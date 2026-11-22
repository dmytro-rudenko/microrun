import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';
import { openDb } from './db.ts';
import { Repo } from './repo.ts';

let db: Knex;
let repo: Repo;
let prodId: string;
let devId: string;

const PER_ENV = 30;
const shaOf = (letter: string, k: number) => `${letter}${k.toString(16).padStart(7, '0')}${letter.repeat(32)}`;

async function mkEnv(serverId: string, name: string, branch: string, isProduction: boolean, position: number) {
  return repo.saveEnv({
    name,
    branch,
    isProduction,
    position,
    serverId,
    composeProject: `proj-${name}`,
    composeDir: `/srv/${name}`,
    composeFiles: ['docker-compose.yml'],
    composeEnvFiles: [],
    services: [{ name: 'web', strategy: 'rolling', domain: `${name}.example.com`, port: 3000 }],
    migrationService: 'web',
    dbKind: 'postgres',
    dbUrlEnv: 'DATABASE_URL',
    migrationTables: ['knex_migrations'],
    expandCmd: 'npm run migrate',
    contractCmd: null,
    cleanupCmd: null,
    schemaCheck: 'dry_run',
    healthTimeoutS: 120,
    storageKind: 'local',
    storageConfigEnc: Buffer.from([1, 2, 3]),
    retentionS: 86400,
    deployTokenHash: `deploy-${name}`,
  });
}

function newRelease(envId: string, commitSha: string, state: 'active' | 'available', deployedAt: number) {
  return {
    envId,
    commitSha,
    images: { web: { ref: `app:${commitSha}`, digest: `sha256:${commitSha}` } },
    author: 'alice',
    message: `commit ${commitSha}`,
    deployedAt,
    schemaSnapshot: { tables: [] },
    schemaDiff: { changes: [] },
    state,
    stored: true,
  };
}

async function seed() {
  const server = await repo.createServer({ name: 'main', agentTokenHash: 'hash-main', builtin: false });
  prodId = (await mkEnv(server.id, 'shop-prod', 'main', true, 0)).id;
  devId = (await mkEnv(server.id, 'shop-dev', 'develop', false, 1)).id;
  for (let k = 0; k < PER_ENV; k++) {
    await repo.insertRelease(newRelease(prodId, shaOf('a', k), k === 0 ? 'active' : 'available', 1000 + k * 10));
    await repo.insertRelease(newRelease(devId, shaOf('b', k), k === 0 ? 'active' : 'available', 1005 + k * 10));
  }
}

beforeEach(async () => {
  db = await openDb(':memory:');
  repo = new Repo(db);
  await seed();
});

afterEach(async () => {
  await db.destroy();
});

describe('scale indexes', () => {
  it('creates the indexes the feed and env lists sort by', async () => {
    const rows: { name: string }[] = await db.raw("select name from sqlite_master where type = 'index'");
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(['releases_env_deployed', 'releases_deployed', 'operations_env_started']));
  });
});

describe('listRecentReleases', () => {
  it('pages newest first by cursor and reports how many rows are left', async () => {
    const p1 = await repo.listRecentReleases({ q: '', productionOnly: false, before: null, limit: 25 });
    expect(p1.rows).toHaveLength(25);
    expect(p1.rest).toBe(2 * PER_ENV - 25);
    const at = p1.rows.map((r) => r.deployedAt);
    expect(at).toEqual([...at].sort((a, b) => b - a));
    expect(p1.rows[0]!.envName).toBe('shop-dev');
    expect(p1.rows[0]!.envIsProduction).toBe(false);

    const last = p1.rows.at(-1)!;
    await repo.insertRelease(newRelease(prodId, 'f'.repeat(40), 'available', 99_999));
    const p2 = await repo.listRecentReleases({ q: '', productionOnly: false, before: { at: last.deployedAt, id: last.id }, limit: 25 });
    expect(p2.rows).toHaveLength(25);
    expect(p2.rows.some((r) => p1.rows.some((x) => x.id === r.id))).toBe(false);
    expect(p2.rows.every((r) => r.deployedAt < last.deployedAt)).toBe(true);
    expect(p2.rest).toBe(2 * PER_ENV - 50);
  });

  it('does not repeat a release redeployed between two pages', async () => {
    const p1 = await repo.listRecentReleases({ q: '', productionOnly: false, before: null, limit: 25 });
    const last = p1.rows.at(-1)!;
    const shown = p1.rows.slice(0, -1).reduce((a, b) => (b.id < a.id ? b : a));
    await db('releases').where({ id: shown.id }).update({ deployed_at: 99_999 });
    const p2 = await repo.listRecentReleases({ q: '', productionOnly: false, before: { at: last.deployedAt, id: last.id }, limit: 25 });
    expect(p2.rows).toHaveLength(25);
    const firstIds = new Set(p1.rows.map((r) => r.id));
    expect(p2.rows.filter((r) => firstIds.has(r.id))).toEqual([]);
  });

  it('breaks deployedAt ties by id so a page boundary skips nothing', async () => {
    await db('releases').update({ deployed_at: 5000 });
    const seen = new Set<string>();
    let before: { at: number; id: string } | null = null;
    for (let page = 0; page < 3; page++) {
      const res: Awaited<ReturnType<Repo['listRecentReleases']>> = await repo.listRecentReleases({ q: '', productionOnly: false, before, limit: 25 });
      for (const r of res.rows) seen.add(r.id);
      const last = res.rows.at(-1);
      if (!last) break;
      before = { at: last.deployedAt, id: last.id };
    }
    expect(seen.size).toBe(2 * PER_ENV);
  });

  it('keeps only production environments when asked', async () => {
    const res = await repo.listRecentReleases({ q: '', productionOnly: true, before: null, limit: 100 });
    expect(res.rows).toHaveLength(PER_ENV);
    expect(res.rows.every((r) => r.envIsProduction && r.envName === 'shop-prod')).toBe(true);
    expect(res.rest).toBe(0);
  });

  it('searches by environment name, branch and commit prefix', async () => {
    const byName = await repo.listRecentReleases({ q: 'dev', productionOnly: false, before: null, limit: 100 });
    expect(byName.rows).toHaveLength(PER_ENV);
    expect(byName.rows.every((r) => r.envName === 'shop-dev')).toBe(true);

    const byBranch = await repo.listRecentReleases({ q: 'main', productionOnly: false, before: null, limit: 100 });
    expect(byBranch.rows).toHaveLength(PER_ENV);
    expect(byBranch.rows.every((r) => r.envName === 'shop-prod')).toBe(true);

    expect((await repo.listRecentReleases({ q: 'aaaa', productionOnly: false, before: null, limit: 100 })).rows).toHaveLength(0);

    const target = shaOf('a', 7);
    const bySha = await repo.listRecentReleases({ q: target.slice(0, 8), productionOnly: false, before: null, limit: 100 });
    expect(bySha.rows.map((r) => r.commitSha)).toEqual([target]);
    expect(bySha.rest).toBe(0);
  });

  it('treats SQL wildcards in the query literally', async () => {
    for (const q of ['%', '_', 'shop_prod']) {
      expect((await repo.listRecentReleases({ q, productionOnly: false, before: null, limit: 5 })).rows).toHaveLength(0);
    }
  });
});

describe('envIdsWithShaPrefix', () => {
  it('returns the environments that hold a commit with the prefix', async () => {
    expect(await repo.envIdsWithShaPrefix(shaOf('b', 3).slice(0, 8))).toEqual(new Set([devId]));
    expect(await repo.envIdsWithShaPrefix('zzzz')).toEqual(new Set());
    expect(await repo.envIdsWithShaPrefix('')).toEqual(new Set());
  });
});

describe('envStatuses', () => {
  it('reports the latest and active release and the last finished operation of each environment', async () => {
    const older = await repo.createOperation({ envId: prodId, kind: 'deploy', fromReleaseId: null, toReleaseId: null, actor: 'admin', status: 'running', startedAt: 1500 });
    await repo.updateOperation(older.id, { status: 'failed', finishedAt: 1600 });
    const done = await repo.createOperation({ envId: prodId, kind: 'deploy', fromReleaseId: null, toReleaseId: null, actor: 'admin', status: 'running', startedAt: 2000 });
    await repo.updateOperation(done.id, { status: 'succeeded', finishedAt: 2100 });
    await repo.createOperation({ envId: prodId, kind: 'deploy', fromReleaseId: null, toReleaseId: null, actor: 'admin', status: 'running', startedAt: 3000 });

    const s = await repo.envStatuses();
    const prod = s.get(prodId)!;
    expect(prod.latest!.deployedAt).toBe(1000 + (PER_ENV - 1) * 10);
    expect(prod.active!.state).toBe('active');
    expect(prod.active!.commitSha).toBe(shaOf('a', 0));
    expect(prod.lastOp!.id).toBe(done.id);

    const dev = s.get(devId)!;
    expect(dev.latest!.commitSha).toBe(shaOf('b', PER_ENV - 1));
    expect(dev.lastOp).toBeNull();
  });

  it('has an entry with nulls for an environment without releases', async () => {
    const server = (await repo.listServers())[0]!;
    const empty = await mkEnv(server.id, 'empty', 'empty-branch', false, 2);
    expect((await repo.envStatuses()).get(empty.id)).toEqual({ latest: null, active: null, lastOp: null });
  });
});
