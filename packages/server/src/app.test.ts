import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { i18n } from '@microrun/core/i18n';
import type { Command, StorageConfig } from '@microrun/core/protocol';
import type { SchemaSnapshot } from '@microrun/core/schema';
import { buildApp, OpBus } from './app.ts';
import type { Config } from './config.ts';
import { decrypt, encrypt, hashToken } from './crypto.ts';
import { openDb } from './db/db.ts';
import { Repo } from './db/repo.ts';
import type { EnvInput, OperationRow } from './db/repo.ts';
import { Hub } from './hub.ts';
import { Orchestrator } from './orchestrator.ts';
import { Scheduler } from './scheduler.ts';

const A = 'a1a1a1a1';
const B = 'b2b2b2b2';
const PROD_TOKEN = 'deploy-token-production';
const STAGING_TOKEN = 'deploy-token-staging';
const PROD_MARKER = '11111111-1111-4111-8111-111111111111';
const STAGING_MARKER = '22222222-2222-4222-8222-222222222222';
const STORAGE: StorageConfig = { kind: 'local', path: '/backups' };
const SCHEMA: SchemaSnapshot = {
  kind: 'sql',
  engine: 'postgres',
  tables: [{ name: 'users', columns: [{ name: 'id', type: 'integer', nullable: false, default: null }], indexes: [] }],
};

const config: Config = {
  adminUser: 'admin',
  adminPassword: 'correct-horse-battery',
  secretKey: Buffer.alloc(32, 7),
  publicUrl: new URL('http://microrun.test'),
  dataDir: '/tmp/microrun-test',
  port: 8080,
  secureCookies: false,
};

let db: Knex;
let repo: Repo;
let hub: Hub;
let orchestrator: Orchestrator;
let app: FastifyInstance;
let now: number;
let prodId: string;
let stagingId: string;
let switchCalled: boolean;
let gate: Promise<void> | null;

const markers: Record<string, { envId: string; envName: string }> = {
  shop: { envId: PROD_MARKER, envName: 'production' },
  'shop-staging': { envId: STAGING_MARKER, envName: 'staging' },
};

async function agent(_key: { opId: string; step: string }, cmd: Command): Promise<unknown> {
  switch (cmd.type) {
    case 'pullImages':
      return { digests: Object.fromEntries(cmd.refs.map((r) => [r, `sha256:${r.replace(/\W/g, '')}`])) };
    case 'readMarker':
      return { markers: [{ service: cmd.db.service, marker: markers[cmd.db.compose.project] ?? null }] };
    case 'snapshotSchema':
      return { snapshot: SCHEMA };
    case 'dryRunExpand':
      return { snapshot: SCHEMA, log: '' };
    case 'runCommand':
      return { exitCode: 0, stdout: '', log: '' };
    case 'switchServices':
      switchCalled = true;
      if (gate) await gate;
      return { replaced: cmd.services.map((s) => s.name) };
    default:
      return {};
  }
}

function envInput(p: { name: string; branch: string; isProduction: boolean; position: number; serverId: string; project: string; token: string }): EnvInput {
  return {
    name: p.name,
    branch: p.branch,
    isProduction: p.isProduction,
    position: p.position,
    serverId: p.serverId,
    composeProject: p.project,
    composeDir: `/srv/${p.project}`,
    composeFiles: ['docker-compose.yml'],
    services: [{ name: 'web', strategy: 'rolling', domain: `${p.project}.example.com`, port: 3000 }],
    migrationService: 'web',
    dbKind: 'postgres',
    dbUrlEnv: 'DATABASE_URL',
    migrationTables: ['knex_migrations'],
    expandCmd: 'npm run migrate',
    contractCmd: 'npm run contract',
    cleanupCmd: 'npm run cleanup',
    schemaCheck: 'dry_run',
    healthTimeoutS: 90,
    storageKind: 'local',
    storageConfigEnc: encrypt(config.secretKey, JSON.stringify(STORAGE)),
    retentionS: 86400,
    deployTokenHash: hashToken(p.token),
  };
}

function sse(body: string): { event: string; data: string }[] {
  return body
    .split('\n\n')
    .filter((chunk) => chunk.trim() !== '')
    .map((chunk) => {
      const lines = chunk.split('\n');
      const event = lines.find((l) => l.startsWith('event: '))?.slice('event: '.length) ?? '';
      const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice('data: '.length)).join('\n');
      return { event, data };
    });
}

function postDeploy(token: string, sha: string, headers: Record<string, string> = {}) {
  now += 1000;
  return app.inject({
    method: 'POST',
    url: '/api/v1/deploy',
    headers: { authorization: `Bearer ${token}`, ...headers },
    payload: { images: { '*': `reg/shop:${sha}` }, commit: sha, branch: 'main', author: 'alice', message: `commit ${sha}` },
  });
}

async function settle(opId: string): Promise<OperationRow> {
  return vi.waitFor(
    async () => {
      const op = await repo.getOperation(opId);
      if (!op || op.status === 'pending' || op.status === 'running') throw new Error(`operation ${opId} is ${op?.status}`);
      return op;
    },
    { timeout: 3000, interval: 5 },
  );
}

async function deploy(sha: string): Promise<OperationRow> {
  const res = await postDeploy(PROD_TOKEN, sha);
  expect(res.statusCode, res.body).toBe(202);
  return settle(res.json().operationId);
}

async function release(sha: string) {
  return (await repo.listReleases(prodId)).find((r) => r.commitSha === sha)!;
}

function form(fields: Record<string, string>) {
  return { payload: new URLSearchParams(fields).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } };
}

function withCookie(cookie: string, f: ReturnType<typeof form>) {
  return { ...f, headers: { ...f.headers, cookie } };
}

async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await app.inject({ method: 'POST', url: '/login', ...form({ username: config.adminUser, password: config.adminPassword }) });
  const session = res.cookies.find((c) => c.name === 'mr_session');
  expect(session, res.body).toBeDefined();
  const cookie = `mr_session=${session!.value}`;
  const page = await app.inject({ method: 'GET', url: '/', headers: { cookie, accept: 'text/html' } });
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1];
  expect(csrf, page.body).toBeDefined();
  return { cookie, csrf: csrf! };
}

beforeEach(async () => {
  db = await openDb(':memory:');
  repo = new Repo(db);
  now = 1_700_000_000_000;
  switchCalled = false;
  gate = null;
  const clock = () => now;
  const serverId = (await repo.createServer({ name: 'main', agentTokenHash: hashToken('agent-token'), builtin: true })).id;
  prodId = (await repo.saveEnv(envInput({ name: 'production', branch: 'main', isProduction: true, position: 0, serverId, project: 'shop', token: PROD_TOKEN }))).id;
  stagingId = (await repo.saveEnv(envInput({ name: 'staging', branch: 'develop', isProduction: false, position: 1, serverId, project: 'shop-staging', token: STAGING_TOKEN }))).id;
  await repo.setEnvMarker(prodId, PROD_MARKER);
  await repo.setEnvMarker(stagingId, STAGING_MARKER);

  hub = new Hub({ repo, clock });
  hub.attachLocal(serverId, agent);
  const bus = new OpBus();
  const decryptStorage = (e: { storageConfigEnc: Buffer }) => JSON.parse(decrypt(config.secretKey, e.storageConfigEnc)) as StorageConfig;
  orchestrator = new Orchestrator({ repo, agent: hub, clock, decryptStorage, emit: (opId, ev) => bus.emit(opId, ev) });
  const scheduler = new Scheduler({ repo, agent: hub, clock, decryptStorage });
  app = await buildApp({ config, repo, hub, orchestrator, scheduler, clock, bus });
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  hub?.close();
  await db.destroy();
});

describe('API /api/v1', () => {
  it('accepts a deploy with 202 and its SSE stream ends with done succeeded', async () => {
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    const res = await postDeploy(PROD_TOKEN, A);
    expect(res.statusCode, res.body).toBe(202);
    const { operationId } = res.json();
    expect(typeof operationId).toBe('string');

    await vi.waitFor(() => expect(switchCalled).toBe(true), { timeout: 3000, interval: 5 });
    expect((await repo.getOperation(operationId))!.status).toBe('running');

    const stream = app.inject({ method: 'GET', url: `/api/v1/operations/${operationId}/events`, headers: { authorization: `Bearer ${PROD_TOKEN}` } });
    setTimeout(() => open(), 20);
    const sseRes = await stream;

    expect(sseRes.statusCode).toBe(200);
    expect(sseRes.headers['content-type']).toMatch(/^text\/event-stream/);
    const events = sse(sseRes.body);
    expect(events.filter((e) => e.event === 'done')).toHaveLength(1);
    const last = events.at(-1)!;
    expect(last.event).toBe('done');
    expect(JSON.parse(last.data)).toMatchObject({ type: 'done', status: 'succeeded' });
    expect((await release(A)).state).toBe('active');
  });

  it('rejects a blocked commit with 422 COMMIT_BLOCKED and a localized message with the sha', async () => {
    await deploy(A);
    await deploy(B);
    now += 1000;
    const rb = await orchestrator.requestRollback(prodId, (await release(A)).id);
    if (!('operationId' in rb)) throw new Error(`rollback rejected with ${rb.rejected.code}`);
    await settle(rb.operationId);
    expect((await release(B)).state).toBe('blocked');

    const res = await postDeploy(PROD_TOKEN, B, { 'accept-language': 'uk' });
    expect(res.statusCode, res.body).toBe(422);
    const body = res.json();
    expect(body.code).toBe('COMMIT_BLOCKED');
    expect(body.message).toContain(B.slice(0, 7));
    expect(typeof body.params.at).toBe('number');
    expect(body.message).toContain(i18n('uk').date(body.params.at));
    expect(body.message).not.toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
  });

  it('answers a wrong deploy token with 401 UNAUTHORIZED', async () => {
    const res = await postDeploy('not-a-token', A);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await repo.listOperations({ limit: 10 })).toEqual([]);
  });

  it("answers 404 to an SSE request for another env's operation", async () => {
    const op = await deploy(A);
    const res = await app.inject({ method: 'GET', url: `/api/v1/operations/${op.id}/events`, headers: { authorization: `Bearer ${STAGING_TOKEN}` } });
    expect(res.statusCode).toBe(404);
  });
});

describe('UI', () => {
  it('rejects a production rollback without confirm with 422 and changes nothing', async () => {
    await deploy(A);
    await deploy(B);
    const { cookie, csrf } = await login();
    const res = await app.inject({
      method: 'POST',
      url: '/rollback',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ envId: prodId, releaseId: (await release(A)).id, _csrf: csrf }).toString(),
    });
    expect(res.statusCode).toBe(422);
    expect((await repo.listOperations({ envId: prodId, limit: 10 })).map((o) => o.kind)).toEqual(['deploy', 'deploy']);
    expect((await release(B)).state).toBe('active');
    expect((await release(A)).state).toBe('available');
  });

  it('rejects a POST without CSRF with 403', async () => {
    const { cookie } = await login();
    const res = await app.inject({ method: 'POST', url: '/lang', ...withCookie(cookie, form({ lang: 'pl' })) });
    expect(res.statusCode).toBe(403);
    expect(res.cookies.find((c) => c.name === 'mr_lang')).toBeUndefined();
  });

  it('renders the board with col-production and rel-production-<sha7>, behind login', async () => {
    await deploy(A);
    const anon = await app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
    expect(anon.statusCode).toBe(302);
    expect(anon.headers.location).toBe('/login');

    const { cookie } = await login();
    const res = await app.inject({ method: 'GET', url: '/', headers: { cookie, accept: 'text/html' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toContain('data-testid="col-production"');
    expect(res.body).toContain('data-testid="col-staging"');
    expect(res.body).toContain(`data-testid="rel-production-${A.slice(0, 7)}"`);
  });

  it('switches the UI language to pl through the mr_lang cookie', async () => {
    const { cookie, csrf } = await login();
    const res = await app.inject({ method: 'POST', url: '/lang', ...withCookie(cookie, form({ lang: 'pl', _csrf: csrf })) });
    expect(res.statusCode).toBeLessThan(400);
    const lang = res.cookies.find((c) => c.name === 'mr_lang');
    expect(lang).toMatchObject({ value: 'pl', maxAge: 31536000 });

    const page = await app.inject({ method: 'GET', url: '/', headers: { cookie: `${cookie}; mr_lang=pl`, accept: 'text/html', 'accept-language': 'de' } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<html lang="pl">');
    expect(page.body).toContain(i18n('pl').t('nav.envs'));
  });
});
