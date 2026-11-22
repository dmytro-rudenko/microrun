import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import type { StorageConfig } from '@microrun/core/protocol';
import type { ReleaseState } from '@microrun/core/state';
import { buildApp, OpBus } from './app.ts';
import type { Config } from './config.ts';
import { encrypt, hashToken } from './crypto.ts';
import { openDb } from './db/db.ts';
import { Repo, type EnvInput } from './db/repo.ts';
import { Hub } from './hub.ts';
import { Orchestrator } from './orchestrator.ts';
import { Scheduler } from './scheduler.ts';

const STORAGE: StorageConfig = { kind: 'local', path: '/backups' };
const NOW = 1_700_000_000_000;
const MIN = 60_000;

const config: Config = {
  adminUser: 'admin',
  adminPassword: 'correct-horse-battery',
  secretKey: Buffer.alloc(32, 7),
  publicUrl: new URL('http://microrun.test'),
  dataDir: '/tmp/microrun-test',
  port: 8080,
  secureCookies: false,
  trustProxy: false,
};

let db: Knex;
let repo: Repo;
let app: FastifyInstance;
let serverId: string;
let cookie: string;

function envInput(name: string, k: number, isProduction: boolean): EnvInput {
  return {
    name, branch: `b-${k}`, isProduction, position: k, serverId,
    composeProject: name, composeDir: `/srv/${name}`, composeFiles: ['docker-compose.yml'], composeEnvFiles: [],
    services: [{ name: 'web', strategy: 'rolling', domain: `${name}.example.com`, port: 3000 }],
    migrationService: 'web', dbKind: 'postgres', dbUrlEnv: 'DATABASE_URL', migrationTables: ['knex_migrations'],
    expandCmd: 'npm run migrate', contractCmd: null, cleanupCmd: null, schemaCheck: 'dry_run', healthTimeoutS: 90,
    storageKind: 'local', storageConfigEnc: encrypt(config.secretKey, JSON.stringify(STORAGE)), retentionS: 86400,
    deployTokenHash: hashToken(`token-${name}`),
  };
}

const shaOf = (e: number, r: number) => `${r.toString(16).padStart(3, '0')}${e.toString(16).padStart(4, '0')}${'c'.repeat(33)}`;

async function addRelease(envId: string, commitSha: string, state: ReleaseState, deployedAt: number) {
  return repo.insertRelease({
    envId, commitSha, images: { web: { ref: `app:${commitSha}`, digest: `sha256:${commitSha}` } },
    author: 'alice', message: `commit ${commitSha.slice(0, 7)}`, deployedAt,
    schemaSnapshot: { kind: 'sql', engine: 'postgres', tables: [] }, schemaDiff: [], state, stored: true,
  });
}

async function seedHundred() {
  for (let e = 0; e < 100; e++) {
    const env = await repo.saveEnv(envInput(`env-${e}`, e, e % 10 === 0));
    for (let r = 0; r < 10; r++) await addRelease(env.id, shaOf(e, r), r === 0 ? 'active' : 'available', NOW - (r * 100 + e) * MIN);
  }
}

async function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { cookie, accept: 'text/html' } });
}

const relCount = (body: string) => body.match(/data-testid="rel-/g)?.length ?? 0;
const nextFrom = (body: string, path: string) => {
  const m = new RegExp(`hx-get="${path}\\?before=([^"&]+)`).exec(body);
  expect(m, body.slice(0, 400)).not.toBeNull();
  return decodeURIComponent(m![1]!);
};

beforeEach(async () => {
  db = await openDb(':memory:');
  repo = new Repo(db);
  const clock = () => NOW;
  const bus = new OpBus();
  const hub = new Hub({ repo, clock });
  serverId = (await repo.createServer({ name: 'main', agentTokenHash: hashToken('agent-token'), builtin: true })).id;
  hub.attachLocal(serverId, async () => ({}));
  const decryptStorage = () => STORAGE;
  const orchestrator = new Orchestrator({ repo, agent: hub, clock, decryptStorage, emit: (id, ev) => bus.emit(id, ev) });
  const scheduler = new Scheduler({ repo, agent: hub, clock, decryptStorage, runContract: (id) => orchestrator.runContract(id) });
  app = await buildApp({ config, repo, hub, orchestrator, scheduler, clock, bus });
  await app.ready();
  const res = await app.inject({
    method: 'POST', url: '/login',
    payload: new URLSearchParams({ username: config.adminUser, password: config.adminPassword }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  const session = res.cookies.find((c) => c.name === 'mr_session');
  expect(session, res.body).toBeDefined();
  cookie = `mr_session=${session!.value}`;
});

afterEach(async () => {
  await app.close();
  await db.destroy();
});

describe('home at 100 environments and 1,000 releases', () => {
  beforeEach(seedHundred);

  it('renders one page of the feed without loading every environment’s releases', async () => {
    const spy = vi.spyOn(repo, 'listReleases');
    const res = await get('/');
    expect(res.statusCode).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    expect(relCount(res.body)).toBe(25);
    expect(res.body).toContain('975 not shown');
    expect(res.body.match(/data-testid="env-link-/g)).toHaveLength(100);
    expect(res.body).toContain(`data-testid="rel-env-0-${shaOf(0, 0).slice(0, 7)}"`);
  });

  it('pages the feed by cursor', async () => {
    const first = await get('/');
    const more = await get(`/feed?before=${encodeURIComponent(nextFrom(first.body, '/feed'))}`);
    expect(more.statusCode).toBe(200);
    expect(relCount(more.body)).toBe(25);
    expect(more.body).toContain('950 not shown');
    const firstIds = new Set(first.body.match(/data-testid="rel-[^"]+"/g));
    expect((more.body.match(/data-testid="rel-[^"]+"/g) ?? []).some((t) => firstIds.has(t))).toBe(false);
  });

  it('rejects a malformed cursor', async () => {
    expect((await get('/feed?before=garbage')).statusCode).toBe(400);
  });

  it('finds a release by commit prefix', async () => {
    const target = shaOf(42, 7);
    const res = await get(`/?q=${target.slice(0, 8)}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`data-testid="rel-env-42-${target.slice(0, 7)}"`);
    expect(relCount(res.body)).toBe(1);
    expect(res.body).toContain('data-testid="env-link-env-42"');
  });

  it('keeps the search and the filter on the next feed page', async () => {
    const first = await get('/?q=env-1&only=prod');
    expect(relCount(first.body)).toBe(10);
    expect(first.body).not.toContain('data-testid="feed-more"');
    const more = await get(`/feed?before=${encodeURIComponent(`${NOW}.zzz`)}&q=env-2&only=all`);
    const envs = [...more.body.matchAll(/data-testid="rel-(env-\d+)-/g)].map((m) => m[1]!);
    expect(envs.length).toBe(25);
    expect(envs.every((e) => e.includes('env-2'))).toBe(true);
    const prodMore = await get(`/feed?before=${encodeURIComponent(`${NOW}.zzz`)}&only=prod`);
    const prodEnvs = [...prodMore.body.matchAll(/data-testid="rel-(env-\d+)-/g)].map((m) => Number(m[1]!.slice(4)));
    expect(prodEnvs).toHaveLength(25);
    expect(prodEnvs.every((e) => e % 10 === 0)).toBe(true);
  });

  it('shows each environment’s status in the index', async () => {
    const all = await repo.listEnvs();
    const id = (name: string) => all.find((e) => e.name === name)!.id;
    await addRelease(id('env-3'), 'f'.repeat(40), 'failed', NOW);
    await addRelease(id('env-4'), 'e'.repeat(40), 'failed', NOW);
    await repo.createOperation({ envId: id('env-4'), kind: 'deploy', fromReleaseId: null, toReleaseId: null, actor: 'admin', status: 'running', startedAt: NOW });
    const res = await get('/');
    const link = (name: string) => new RegExp(`<a[^>]*data-testid="env-link-${name}"[\\s\\S]*?</a>`).exec(res.body)?.[0] ?? '';
    expect(link('env-3')).toContain('Needs a look');
    expect(link('env-4')).toContain('Running normally');
    expect(link('env-5')).toContain('Running normally');
  });

  it('filters the feed to production', async () => {
    const res = await get('/?only=prod');
    expect(relCount(res.body)).toBe(25);
    const envs = [...res.body.matchAll(/data-testid="rel-(env-\d+)-/g)].map((m) => Number(m[1]!.slice(4)));
    expect(envs.every((e) => e % 10 === 0)).toBe(true);
  });
});

describe('older releases of one environment', () => {
  it('returns 404 for an unknown environment', async () => {
    expect((await get('/env/unknown/older')).statusCode).toBe(404);
  });

  it('pages the folded releases 20 at a time', async () => {
    const env = await repo.saveEnv(envInput('big', 0, false));
    for (let r = 0; r < 140; r++) {
      const state: ReleaseState = r === 0 ? 'active' : r < 15 ? 'available' : 'expired';
      await addRelease(env.id, shaOf(500, r), state, NOW - r * 60 * MIN);
    }
    const first = await get(`/env/${env.id}/older`);
    expect(first.statusCode).toBe(200);
    expect(relCount(first.body)).toBe(20);
    expect(first.body).toContain(`data-testid="rel-big-${shaOf(500, 15).slice(0, 7)}"`);
    const second = await get(`/env/${env.id}/older?before=${encodeURIComponent(nextFrom(first.body, `/env/${env.id}/older`))}`);
    expect(relCount(second.body)).toBe(20);
    expect(second.body).toContain(`data-testid="rel-big-${shaOf(500, 35).slice(0, 7)}"`);
    expect(second.body).not.toContain(`data-testid="rel-big-${shaOf(500, 34).slice(0, 7)}"`);
    expect(second.body).toContain('85 not shown');
    expect((await get(`/env/${env.id}/older?before=garbage`)).statusCode).toBe(400);
  });
});
