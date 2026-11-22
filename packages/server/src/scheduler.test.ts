import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';
import { AgentError } from '@microrun/core/protocol';
import type { AgentPort, Command, StorageConfig } from '@microrun/core/protocol';
import { openDb } from './db/db.ts';
import { Repo } from './db/repo.ts';
import type { EnvRow, NewRelease, ReleaseRow } from './db/repo.ts';
import { Scheduler } from './scheduler.ts';

const T0 = 1_000_000_000;
const RETENTION_S = 86400;
const RETENTION_MS = RETENTION_S * 1000;
const STORAGE: StorageConfig = { kind: 'local', path: '/var/backups' };

type Call = { serverId: string; key: { opId: string; step: string }; cmd: Command };
type Handler = (cmd: Command) => unknown;

class FakeAgent implements AgentPort {
  calls: Call[] = [];
  online = new Set<string>();
  handlers: Partial<Record<Command['type'], Handler>> = {};

  isOnline(serverId: string): boolean {
    return this.online.has(serverId);
  }

  async call(serverId: string, key: { opId: string; step: string }, cmd: Command): Promise<never> {
    this.calls.push({ serverId, key, cmd });
    const h = this.handlers[cmd.type];
    if (h) return (await h(cmd)) as never;
    if (cmd.type === 'runCommand') return { exitCode: 0, stdout: '', log: '' } as never;
    if (cmd.type === 'readMarker') return { markers: [] } as never;
    return {} as never;
  }

  of<T extends Command['type']>(type: T): Extract<Command, { type: T }>[] {
    return this.calls.filter((c) => c.cmd.type === type).map((c) => c.cmd as Extract<Command, { type: T }>);
  }
}

let db: Knex;
let repo: Repo;
let agent: FakeAgent;
let now: number;
let scheduler: Scheduler;
let serverId: string;

beforeEach(async () => {
  db = await openDb(':memory:');
  repo = new Repo(db);
  agent = new FakeAgent();
  now = T0;
  const server = await repo.createServer({ name: 'main', agentTokenHash: 'hash-main', builtin: false });
  serverId = server.id;
  agent.online.add(serverId);
  scheduler = new Scheduler({ repo, agent, clock: () => now, decryptStorage: () => STORAGE });
});

afterEach(async () => {
  scheduler.stop();
  await db.destroy();
});

async function mkEnv(
  name: string,
  o: { contractCmd?: string | null; position?: number; services?: string[] } = {},
): Promise<EnvRow> {
  return repo.saveEnv({
    name,
    branch: `branch-${name}`,
    isProduction: false,
    position: o.position ?? 0,
    serverId,
    composeProject: `proj-${name}`,
    composeDir: `/srv/${name}`,
    composeFiles: ['docker-compose.yml'],
    services: (o.services ?? ['web']).map((s) => ({ name: s, strategy: 'rolling' as const })),
    migrationService: 'web',
    dbKind: 'postgres',
    dbUrlEnv: 'DATABASE_URL',
    migrationTables: ['knex_migrations'],
    expandCmd: 'npm run migrate',
    contractCmd: o.contractCmd ?? null,
    cleanupCmd: null,
    schemaCheck: 'dry_run',
    healthTimeoutS: 120,
    storageKind: 'local',
    storageConfigEnc: Buffer.from([1, 2, 3]),
    retentionS: RETENTION_S,
    deployTokenHash: `deploy-${name}`,
  });
}

async function mkRelease(
  envId: string,
  sha: string,
  state: NewRelease['state'],
  deployedAt: number,
  patch: Partial<ReleaseRow> = {},
): Promise<ReleaseRow> {
  const r = await repo.insertRelease({
    envId,
    commitSha: sha,
    images: { web: { ref: `app:${sha}`, digest: `sha256:${sha}` } },
    author: 'alice',
    message: `commit ${sha}`,
    deployedAt,
    schemaSnapshot: { tables: [] },
    schemaDiff: { changes: [] },
    state,
    stored: true,
  });
  if (Object.keys(patch).length) await repo.patchReleases([{ id: r.id, patch }]);
  return (await repo.getRelease(r.id))!;
}

async function release(id: string): Promise<ReleaseRow> {
  return (await repo.getRelease(id))!;
}

async function ops(envId: string, kind: string) {
  return (await repo.listOperations({ envId, limit: 100 })).filter((o) => o.kind === kind);
}

function fullCmd(c: Extract<Command, { type: 'runCommand' }>): string {
  return [c.cmd, ...c.args].join(' ');
}

describe('Scheduler', () => {
  it('expires an available release exactly when retention has elapsed', async () => {
    const env = await mkEnv('staging');
    await mkRelease(env.id, 'aaa', 'active', 2000);
    const old = await mkRelease(env.id, 'bbb', 'available', 1000, { supersededAt: T0 });
    const blocked = await mkRelease(env.id, 'ccc', 'blocked', 500, { blockedAt: T0 });

    now = T0 + RETENTION_MS - 1;
    await scheduler.tick();
    expect((await release(old.id)).state).toBe('available');
    expect(await ops(env.id, 'expire')).toEqual([]);

    now = T0 + RETENTION_MS;
    await scheduler.tick();
    expect((await release(old.id)).state).toBe('expired');
    const expire = await ops(env.id, 'expire');
    expect(expire).toHaveLength(1);
    expect(expire[0]).toMatchObject({ actor: 'system', status: 'succeeded' });

    const b = await release(blocked.id);
    expect(b.state).toBe('blocked');
    expect(b.imagePurgedAt).toBe(T0 + RETENTION_MS);
  });

  it('purges an expired image only once the agent is online', async () => {
    const env = await mkEnv('staging');
    await mkRelease(env.id, 'aaa', 'active', 2000);
    const old = await mkRelease(env.id, 'bbb', 'expired', 1000, { supersededAt: T0 - RETENTION_MS });
    agent.online.delete(serverId);

    await scheduler.tick();
    expect(agent.of('deleteImages')).toEqual([]);
    expect((await release(old.id)).imagePurgedAt).toBeNull();

    agent.online.add(serverId);
    now = T0 + 60_000;
    await scheduler.tick();
    expect(agent.of('deleteImages')).toEqual([
      expect.objectContaining({ type: 'deleteImages', storage: STORAGE, sha: 'bbb', images: { web: 'app:bbb' } }),
    ]);
    expect((await release(old.id)).imagePurgedAt).toBe(T0 + 60_000);
  });

  it('marks pending cleanup of a purged blocked release as lapsed', async () => {
    const env = await mkEnv('staging');
    await mkRelease(env.id, 'aaa', 'active', 2000);
    const b = await mkRelease(env.id, 'bbb', 'blocked', 1000, {
      blockedAt: T0 - RETENTION_MS,
      imagePurgedAt: T0 - 1,
      cleanupState: 'pending',
    });

    await scheduler.tick();
    expect((await release(b.id)).cleanupState).toBe('lapsed');
  });

  it('runs contracts oldest first, one per tick, and stops at a failure', async () => {
    const env = await mkEnv('staging', { contractCmd: 'npm run contract' });
    const purged = { supersededAt: T0 - RETENTION_MS, imagePurgedAt: T0 - 1 };
    const r1 = await mkRelease(env.id, 'r1', 'expired', 1000, purged);
    const r2 = await mkRelease(env.id, 'r2', 'expired', 2000, purged);
    const r3 = await mkRelease(env.id, 'r3', 'active', 3000);

    await scheduler.tick();
    let runs = agent.of('runCommand');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ service: 'web', image: 'app:r1' });
    expect(fullCmd(runs[0]!)).toContain('npm run contract');
    expect((await release(r1.id)).contractedAt).toBe(T0);
    expect((await release(r2.id)).contractedAt).toBeNull();
    expect(await ops(env.id, 'contract')).toEqual([expect.objectContaining({ status: 'succeeded' })]);

    agent.handlers.runCommand = (cmd) => {
      throw new AgentError('MIGRATION_FAILED', { reason: 'timeout', cmd: (cmd as { cmd: string }).cmd });
    };
    now = T0 + 60_000;
    await scheduler.tick();
    runs = agent.of('runCommand');
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ service: 'web', image: 'app:r2' });
    expect((await release(r2.id)).contractedAt).toBeNull();
    const failed = (await ops(env.id, 'contract')).filter((o) => o.status === 'failed');
    expect(failed).toEqual([expect.objectContaining({ code: 'CONTRACT_FAILED' })]);

    agent.handlers.runCommand = undefined;
    now = T0 + 120_000;
    await scheduler.tick();
    expect(agent.of('runCommand')).toHaveLength(2);
    expect((await release(r2.id)).contractedAt).toBeNull();
    expect((await release(r3.id)).contractedAt).toBeNull();
  });

  it('purges an expired image only after its own contract has run with it', async () => {
    const env = await mkEnv('staging', { contractCmd: 'npm run contract' });
    const due = { supersededAt: T0 - RETENTION_MS };
    const r1 = await mkRelease(env.id, 'r1', 'available', 1000, due);
    const r2 = await mkRelease(env.id, 'r2', 'available', 2000, due);
    await mkRelease(env.id, 'r3', 'active', 3000);

    const firstIndex = (type: Command['type'], pred: (c: Command) => boolean) =>
      agent.calls.findIndex((c) => c.cmd.type === type && pred(c.cmd));
    const contractOf = (sha: string) =>
      firstIndex('runCommand', (c) => (c as Extract<Command, { type: 'runCommand' }>).image === `app:${sha}`);
    const purgeOf = (sha: string) =>
      firstIndex('deleteImages', (c) => (c as Extract<Command, { type: 'deleteImages' }>).sha === sha);

    await scheduler.tick();
    expect((await release(r1.id)).state).toBe('expired');
    expect((await release(r2.id)).state).toBe('expired');
    expect(contractOf('r1')).toBeGreaterThanOrEqual(0);
    expect((await release(r1.id)).contractedAt).toBe(T0);
    expect(contractOf('r2')).toBe(-1);
    expect(purgeOf('r2')).toBe(-1);
    expect((await release(r2.id)).imagePurgedAt).toBeNull();
    if (purgeOf('r1') >= 0) expect(purgeOf('r1')).toBeGreaterThan(contractOf('r1'));

    now = T0 + 60_000;
    await scheduler.tick();
    expect(purgeOf('r1')).toBeGreaterThan(contractOf('r1'));
    expect((await release(r1.id)).imagePurgedAt).not.toBeNull();
    expect(contractOf('r2')).toBeGreaterThanOrEqual(0);
    expect((await release(r2.id)).contractedAt).toBe(T0 + 60_000);
    if (purgeOf('r2') >= 0) expect(purgeOf('r2')).toBeGreaterThan(contractOf('r2'));

    now = T0 + 120_000;
    await scheduler.tick();
    expect(purgeOf('r2')).toBeGreaterThan(contractOf('r2'));
    expect((await release(r2.id)).imagePurgedAt).not.toBeNull();
    expect(agent.of('deleteImages').filter((c) => c.sha === 'r1')).toHaveLength(1);
  });

  it('holds a contract while an older release has pending cleanup', async () => {
    const env = await mkEnv('staging', { contractCmd: 'npm run contract' });
    const b = await mkRelease(env.id, 'bbb', 'blocked', 1000, { blockedAt: T0 - 1000, cleanupState: 'pending' });
    const active = await mkRelease(env.id, 'aaa', 'active', 2000);

    await scheduler.tick();
    expect(agent.of('runCommand')).toEqual([]);
    expect((await release(active.id)).contractedAt).toBeNull();

    await repo.patchReleases([{ id: b.id, patch: { cleanupState: 'dismissed' } }]);
    now = T0 + 60_000;
    await scheduler.tick();
    const runs = agent.of('runCommand');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ image: 'app:aaa' });
    expect((await release(active.id)).contractedAt).toBe(T0 + 60_000);
  });

  it('retries storing images of an unstored release', async () => {
    const env = await mkEnv('staging');
    const r = await mkRelease(env.id, 'aaa', 'active', 1000, { stored: false });

    await scheduler.tick();
    expect(agent.of('storeImages')).toEqual([
      expect.objectContaining({ type: 'storeImages', storage: STORAGE, sha: 'aaa', images: { web: 'app:aaa' } }),
    ]);
    expect((await release(r.id)).stored).toBe(true);
  });

  it('skips a busy env for this tick and still processes the others', async () => {
    const busy = await mkEnv('alpha', { position: 0 });
    const free = await mkEnv('beta', { position: 1 });
    await repo.createOperation({
      envId: busy.id,
      kind: 'deploy',
      fromReleaseId: null,
      toReleaseId: null,
      actor: 'admin',
      status: 'running',
      startedAt: T0 - 10,
    });
    await mkRelease(busy.id, 'a1', 'active', 2000);
    const busyOld = await mkRelease(busy.id, 'a0', 'available', 1000, { supersededAt: T0 - RETENTION_MS });
    await mkRelease(free.id, 'b1', 'active', 2000);
    const freeOld = await mkRelease(free.id, 'b0', 'available', 1000, { supersededAt: T0 - RETENTION_MS });

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect((await release(busyOld.id)).state).toBe('available');
    expect((await release(busyOld.id)).imagePurgedAt).toBeNull();
    expect((await release(freeOld.id)).state).toBe('expired');
    expect(agent.of('deleteImages').map((c) => c.sha)).toEqual(['b0']);
  });

  it('isolates an env whose work throws and logs the error once', async () => {
    const broken = await mkEnv('alpha', { position: 0 });
    const ok = await mkEnv('beta', { position: 1 });
    await mkRelease(broken.id, 'a1', 'active', 2000);
    await mkRelease(broken.id, 'a0', 'available', 1000, { supersededAt: T0 - RETENTION_MS });
    await mkRelease(ok.id, 'b1', 'active', 2000);
    const okOld = await mkRelease(ok.id, 'b0', 'available', 1000, { supersededAt: T0 - RETENTION_MS });
    const listReleases = repo.listReleases.bind(repo);
    repo.listReleases = async (envId) => {
      if (envId === broken.id) throw new Error('db read failed');
      return listReleases(envId);
    };
    const lines: string[] = [];
    const s = new Scheduler({
      repo,
      agent,
      clock: () => now,
      decryptStorage: () => STORAGE,
      log: (line) => lines.push(line),
    });

    await expect(s.tick()).resolves.toBeUndefined();
    expect((await release(okOld.id)).state).toBe('expired');
    expect((await release(okOld.id)).imagePurgedAt).toBe(T0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('db read failed');
  });

  it('fills the marker warning map on a mismatch, re-reading every markerEveryMs', async () => {
    const env = await mkEnv('staging', { services: ['web', 'worker'] });
    await repo.setEnvMarker(env.id, 'mk-staging');
    let foreign = true;
    agent.handlers.readMarker = (cmd) => {
      const c = cmd as Extract<Command, { type: 'readMarker' }>;
      const all = [
        { service: 'web', marker: { envId: 'mk-staging', envName: 'staging' } },
        {
          service: 'worker',
          marker: foreign ? { envId: 'prod-id', envName: 'production' } : { envId: 'mk-staging', envName: 'staging' },
        },
      ];
      return { markers: c.viaService ? all.filter((m) => m.service === c.viaService) : all };
    };

    await scheduler.tick();
    now = T0 + 300_000;
    await scheduler.tick();
    expect(scheduler.markerWarnings().get(env.id)).toEqual([
      expect.objectContaining({ svc: 'worker', other: 'production' }),
    ]);

    const reads = agent.of('readMarker').length;
    expect(reads).toBeGreaterThan(0);
    foreign = false;
    now = T0 + 360_000;
    await scheduler.tick();
    expect(agent.of('readMarker')).toHaveLength(reads);
    expect(scheduler.markerWarnings().get(env.id)).toHaveLength(1);

    now = T0 + 600_000;
    await scheduler.tick();
    expect(scheduler.markerWarnings().get(env.id) ?? []).toEqual([]);
  });

  it('compares markers with the bound marker id and warns an unbound env on any marker', async () => {
    const bound = await mkEnv('production', { services: ['web', 'worker'] });
    await repo.setEnvMarker(bound.id, 'mk-123');
    const unbound = await mkEnv('preview', { services: ['web'] });
    const reported: Record<string, Record<string, { envId: string; envName: string }>> = {
      'proj-production': {
        web: { envId: 'mk-123', envName: 'production' },
        worker: { envId: 'mk-other', envName: 'stage' },
      },
      'proj-preview': { web: { envId: 'mk-123', envName: 'production' } },
    };
    agent.handlers.readMarker = (cmd) => {
      const c = cmd as Extract<Command, { type: 'readMarker' }>;
      const byService = reported[c.db.compose.project] ?? {};
      return {
        markers: Object.entries(byService)
          .filter(([svc]) => !c.viaService || svc === c.viaService)
          .map(([service, marker]) => ({ service, marker })),
      };
    };

    await scheduler.tick();
    expect(scheduler.markerWarnings().get(bound.id)).toEqual([
      expect.objectContaining({ svc: 'worker', other: 'stage' }),
    ]);
    expect(scheduler.markerWarnings().get(unbound.id)).toEqual([
      expect.objectContaining({ svc: 'web', other: 'production' }),
    ]);
  });
});

describe('Scheduler tickEnv edges', () => {
  function logged() {
    const lines: string[] = [];
    const s = new Scheduler({ repo, agent, clock: () => now, decryptStorage: () => STORAGE, log: (line) => lines.push(line) });
    return { s, lines };
  }

  it('runs no contract while the agent is offline', async () => {
    const env = await mkEnv('staging', { contractCmd: 'npm run contract' });
    await mkRelease(env.id, 'aaa', 'active', 1000);
    agent.online.delete(serverId);
    await scheduler.tick();
    expect(agent.calls).toEqual([]);
    expect(await ops(env.id, 'contract')).toEqual([]);
  });

  it('logs a failed purge, keeps imagePurgedAt unset and still stores the others', async () => {
    const env = await mkEnv('staging');
    await mkRelease(env.id, 'aaa', 'active', 2000, { stored: false });
    const old = await mkRelease(env.id, 'bbb', 'expired', 1000, { supersededAt: T0 - RETENTION_MS });
    agent.handlers.deleteImages = () => { throw new AgentError('STORAGE_FAILED', { reason: 'locked' }); };
    const { s, lines } = logged();
    await s.tick();
    expect((await release(old.id)).imagePurgedAt).toBeNull();
    expect(lines).toEqual([expect.stringContaining('scheduler: env staging: purge bbb:')]);
    expect(agent.of('storeImages').map((c) => c.sha)).toEqual(['aaa']);
  });

  it('logs a failed store and keeps the release unstored', async () => {
    const env = await mkEnv('staging');
    const r = await mkRelease(env.id, 'aaa', 'active', 1000, { stored: false });
    agent.handlers.storeImages = () => { throw new AgentError('STORAGE_FAILED', { reason: 'disk full' }); };
    const { s, lines } = logged();
    await s.tick();
    expect((await release(r.id)).stored).toBe(false);
    expect(lines).toEqual([expect.stringContaining('scheduler: env staging: store aaa:')]);
  });

  it('does not store a release whose image was already purged', async () => {
    const env = await mkEnv('staging');
    await mkRelease(env.id, 'aaa', 'active', 2000);
    await mkRelease(env.id, 'bbb', 'expired', 1000, { stored: false, imagePurgedAt: T0 - 1, supersededAt: T0 - RETENTION_MS });
    await scheduler.tick();
    expect(agent.of('storeImages')).toEqual([]);
  });
});
