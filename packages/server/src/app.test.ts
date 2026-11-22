import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { codeMessage, i18n } from '@microrun/core/i18n';
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
let serverId: string;
let switchCalled: boolean;
let gate: Promise<void> | null;
let markers: Record<string, { envId: string; envName: string }>;
let dryRunSnapshot: SchemaSnapshot;
let contractExit: number;
let inspected: { name: string; hasHealthcheck: boolean | null; hostPorts: string[] }[];
let inspectCalls: number;
let applyOut: string;
let previewExit: number;

const PREVIEW_OUT = '{"rule":"orphans","description":"Orphan posts","count":2}\n{"rule":"tags","description":"Unused tags","count":1}\n';
const APPLY_OUT = '{"rule":"orphans","deleted":2}\n{"rule":"tags","deleted":1}\n';

async function agent(_key: { opId: string; step: string }, cmd: Command): Promise<unknown> {
  switch (cmd.type) {
    case 'pullImages':
      return { digests: Object.fromEntries(cmd.refs.map((r) => [r, `sha256:${r.replace(/\W/g, '')}`])) };
    case 'readMarker':
      return { markers: [{ service: cmd.db.service, marker: markers[cmd.db.compose.project] ?? null }] };
    case 'snapshotSchema':
      return { snapshot: SCHEMA };
    case 'dryRunExpand':
      return { snapshot: dryRunSnapshot, log: '' };
    case 'inspectEnv':
      inspectCalls++;
      return { services: inspected.map((s) => ({ image: null, replicas: 1, containerName: null, hasDbUrl: true, ...s })) };
    case 'runCommand':
      if (cmd.cmd === 'npm run cleanup') {
        const dry = cmd.args[0] === '--dry-run';
        return { exitCode: dry ? previewExit : 0, stdout: dry ? PREVIEW_OUT : applyOut, log: '' };
      }
      return { exitCode: cmd.cmd === 'npm run contract' ? contractExit : 0, stdout: '', log: '' };
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

function postDeploy(token: string, sha: string, headers: Record<string, string> = {}, branch = 'main') {
  now += 1000;
  return app.inject({
    method: 'POST',
    url: '/api/v1/deploy',
    headers: { authorization: `Bearer ${token}`, ...headers },
    payload: { images: { '*': `reg/shop:${sha}` }, commit: sha, branch, author: 'alice', message: `commit ${sha}` },
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
  markers = {
    shop: { envId: PROD_MARKER, envName: 'production' },
    'shop-staging': { envId: STAGING_MARKER, envName: 'staging' },
  };
  dryRunSnapshot = SCHEMA;
  contractExit = 0;
  inspected = [{ name: 'web', hasHealthcheck: true, hostPorts: [] }];
  inspectCalls = 0;
  applyOut = APPLY_OUT;
  previewExit = 0;
  const clock = () => now;
  serverId = (await repo.createServer({ name: 'main', agentTokenHash: hashToken('agent-token'), builtin: true })).id;
  prodId = (await repo.saveEnv(envInput({ name: 'production', branch: 'main', isProduction: true, position: 0, serverId, project: 'shop', token: PROD_TOKEN }))).id;
  stagingId = (await repo.saveEnv(envInput({ name: 'staging', branch: 'develop', isProduction: false, position: 1, serverId, project: 'shop-staging', token: STAGING_TOKEN }))).id;
  await repo.setEnvMarker(prodId, PROD_MARKER);
  await repo.setEnvMarker(stagingId, STAGING_MARKER);

  hub = new Hub({ repo, clock });
  hub.attachLocal(serverId, agent);
  const bus = new OpBus();
  const decryptStorage = (e: { storageConfigEnc: Buffer }) => JSON.parse(decrypt(config.secretKey, e.storageConfigEnc)) as StorageConfig;
  orchestrator = new Orchestrator({ repo, agent: hub, clock, decryptStorage, emit: (opId, ev) => bus.emit(opId, ev) });
  const scheduler = new Scheduler({ repo, agent: hub, clock, decryptStorage, runContract: (id) => orchestrator.runContract(id) });
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

describe('UI routes', () => {
  const en = i18n('en');
  const A7 = A.slice(0, 7);
  const B7 = B.slice(0, 7);
  let ui: Awaited<ReturnType<typeof login>>;

  beforeEach(async () => {
    ui = await login();
  });

  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: ui.cookie, accept: 'text/html' } });

  function post(url: string, fields: Record<string, string> | [string, string][] = {}, headers: Record<string, string> = {}) {
    const body = new URLSearchParams(fields);
    body.set('_csrf', ui.csrf);
    return app.inject({
      method: 'POST',
      url,
      payload: body.toString(),
      headers: { cookie: ui.cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });
  }

  async function idle() {
    await vi.waitFor(
      async () => {
        const active = await repo.activeOperations();
        if (active.length) throw new Error(`${active.length} operations still active`);
      },
      { timeout: 3000, interval: 5 },
    );
  }

  async function ops(envId = prodId) {
    return repo.listOperations({ envId, limit: 100 });
  }

  async function rolledBack() {
    await deploy(A);
    await deploy(B);
    now += 1000;
    const rb = await orchestrator.requestRollback(prodId, (await release(A)).id);
    if (!('operationId' in rb)) throw new Error(`rollback rejected with ${rb.rejected.code}`);
    await settle(rb.operationId);
    await idle();
  }

  async function destructiveRejection() {
    await deploy(A);
    dryRunSnapshot = { kind: 'sql', engine: 'postgres', tables: [] };
    const op = await deploy(B);
    expect(op).toMatchObject({ status: 'rejected', code: 'SCHEMA_DESTRUCTIVE' });
  }

  function envBody(over: Record<string, string> = {}): Record<string, string> {
    return {
      name: 'qa',
      branch: 'qa',
      server_id: serverId,
      position: '2',
      compose_project: 'shop-qa',
      compose_dir: '/srv/shop-qa',
      compose_files: 'docker-compose.yml',
      services: 'web:rolling',
      migration_service: 'web',
      db_kind: 'postgres',
      db_url_env: 'DATABASE_URL',
      migration_tables: 'knex_migrations',
      expand_cmd: 'npm run migrate',
      contract_cmd: '',
      cleanup_cmd: '',
      health_timeout_s: '90',
      storage_kind: 'local',
      storage_path: '/backups',
      retention_value: '1',
      retention_unit: 'days',
      ...over,
    };
  }

  const stagingBody = (over: Record<string, string> = {}) =>
    envBody({ id: stagingId, name: 'staging', branch: 'develop', position: '1', compose_project: 'shop-staging', compose_dir: '/srv/shop-staging', ...over });

  async function storageOf(envId: string): Promise<StorageConfig> {
    return JSON.parse(decrypt(config.secretKey, (await repo.getEnv(envId))!.storageConfigEnc)) as StorageConfig;
  }

  async function setStagingStorage(s: StorageConfig) {
    const env = (await repo.getEnv(stagingId))!;
    await repo.saveEnv({ ...env, storageKind: s.kind, storageConfigEnc: encrypt(config.secretKey, JSON.stringify(s)) });
  }

  const testText = (body: string, testid: string) => new RegExp(`data-testid="${testid}"[^>]*>([^<]*)<`).exec(body)?.[1];
  const tbody = (body: string) => /<tbody>([\s\S]*)<\/tbody>/.exec(body)?.[1] ?? '';
  const rowCount = (body: string) => tbody(body).match(/<tr>/g)?.length ?? 0;
  const keyShaped = /^[A-Za-z]\w*(\.\w+)+$/;
  const fieldError = (body: string, field: string) => new RegExp(`<li><b>${en.t(`settings.f.${field}`)}</b>: ([^<]*)</li>`).exec(body)?.[1];

  async function busy(): Promise<() => Promise<void>> {
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    switchCalled = false;
    const res = await postDeploy(PROD_TOKEN, 'c3c3c3c3');
    expect(res.statusCode, res.body).toBe(202);
    await vi.waitFor(() => expect(switchCalled).toBe(true), { timeout: 3000, interval: 5 });
    return async () => {
      open();
      gate = null;
      await idle();
    };
  }

  function fakeSocket() {
    const closers: ((arg?: unknown) => void)[] = [];
    const socket = {
      closed: false,
      send: () => {},
      on: (event: 'message' | 'close', fn: (arg?: unknown) => void) => {
        if (event === 'close') closers.push(fn);
      },
      close: () => {
        socket.closed = true;
        for (const fn of closers) fn();
      },
    };
    return socket;
  }

  describe('POST /rollback', () => {
    it('answers 422 when the production confirm names another env and starts nothing', async () => {
      await deploy(A);
      await deploy(B);
      const res = await post('/rollback', { envId: prodId, releaseId: (await release(A)).id, confirm: 'staging' });
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain('role="alert"');
      expect((await ops()).map((o) => o.kind)).toEqual(['deploy', 'deploy']);
    });

    it('answers 422 for an unknown env', async () => {
      const res = await post('/rollback', { envId: 'nope', releaseId: 'nope', confirm: 'production' });
      expect(res.statusCode).toBe(422);
    });

    it('starts a confirmed production rollback and answers the progress panel with its steps', async () => {
      await deploy(A);
      await deploy(B);
      const res = await post('/rollback', { envId: prodId, releaseId: (await release(A)).id, confirm: 'production' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).toContain('data-testid="panel"');
      expect(res.body).toContain(en.t('step.image', { sha: A7 }));
      expect(res.body).toContain(en.t('step.healthy', { svc: 'web' }));
      expect(res.body).toContain(en.t('step.blocked'));
      const rb = (await ops()).find((o) => o.kind === 'rollback')!;
      expect(rb).toMatchObject({ actor: 'admin', toReleaseId: (await release(A)).id });
      await settle(rb.id);
      expect((await release(A)).state).toBe('active');
      expect((await release(B)).state).toBe('blocked');
    });

    it('streams a done frame with the rollback-done header once the UI rollback finished', async () => {
      await deploy(A);
      await deploy(B);
      await post('/rollback', { envId: prodId, releaseId: (await release(A)).id, confirm: 'production' });
      const rb = (await ops()).find((o) => o.kind === 'rollback')!;
      await settle(rb.id);
      const res = await get(`/ops/${rb.id}/events`);
      expect(res.statusCode).toBe(200);
      const events = sse(res.body);
      expect(events.map((e) => e.event)).toEqual(['done']);
      expect(events[0]!.data).toContain('data-testid="rollback-done"');
      expect(events[0]!.data).not.toContain('\n');
      expect((await get('/ops/nope/events')).statusCode).toBe(404);
    });

    it('streams the release panel on one line as the done frame of a cleanup operation', async () => {
      await rolledBack();
      const relB = await release(B);
      const preview = (await ops()).find((o) => o.kind === 'cleanup' && o.toReleaseId === relB.id)!;
      const events = sse((await get(`/ops/${preview.id}/events`)).body);
      expect(events.map((e) => e.event)).toEqual(['done']);
      expect(events[0]!.data).toContain(`data-release="${relB.id}"`);
      expect(events[0]!.data).toContain('data-testid="cleanup-apply"');
    });

    it('strips every line terminator, a lone \\r included, from the done frame', async () => {
      await rolledBack();
      const relB = await release(B);
      await db('releases').where({ id: relB.id }).update({ message: 'fix\revent: steps\rdata: <b>pwned</b>\r\ndata: x\n' });
      const preview = (await ops()).find((o) => o.kind === 'cleanup' && o.toReleaseId === relB.id)!;
      const res = await get(`/ops/${preview.id}/events`);
      expect(res.body).not.toContain('\r');
      expect(sse(res.body).map((e) => e.event)).toEqual(['done']);
      expect(sse(res.body)[0]!.data).toContain('fix');
    });

    it('answers ENV_BUSY with 409 and an alert fragment retargeted into the panel alert slot', async () => {
      await deploy(A);
      await deploy(B);
      const free = await busy();
      const res = await post('/rollback', { envId: prodId, releaseId: (await release(A)).id, confirm: 'production' });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.body).toMatch(/<div[^>]*role="alert"/);
      expect(res.body).toContain(codeMessage(en, 'ENV_BUSY', { env: 'production' }));
      expect(res.headers['hx-retarget']).toBe('#panel-alert');
      expect(res.headers['hx-reswap']).toBe('innerHTML');
      await free();
    });

    it('retargets a wrong-confirm 422 into the panel alert slot as well', async () => {
      await deploy(A);
      await deploy(B);
      const res = await post('/rollback', { envId: prodId, releaseId: (await release(A)).id, confirm: 'staging' });
      expect(res.statusCode).toBe(422);
      expect(res.headers['hx-retarget']).toBe('#panel-alert');
    });
  });

  describe('cleanup', () => {
    it('applies the chosen rules on a blocked release and shows the result in its panel', async () => {
      await rolledBack();
      const relB = await release(B);
      expect(relB).toMatchObject({ state: 'blocked', cleanupState: 'pending' });
      const res = await post('/cleanup/apply', [['releaseId', relB.id], ['rules', 'orphans'], ['rules', 'tags']]);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).toContain('data-testid="panel"');
      const apply = (await ops()).find((o) => o.kind === 'cleanup' && o.params?.mode === 'apply')!;
      expect(apply.params).toMatchObject({ rules: 'orphans,tags' });
      await settle(apply.id);
      expect((await release(B)).cleanupState).toBe('applied');
      const panel = await get(`/panel/${relB.id}`);
      expect(panel.body).toContain('data-testid="cleanup-result"');
      expect(panel.body).toContain(en.t('cl.result', { rule: 'tags', p: en.num(1), a: en.num(1) }));
    });

    it('answers 422 to an apply without rules and starts no cleanup', async () => {
      await rolledBack();
      const before = (await ops()).length;
      const res = await post('/cleanup/apply', { releaseId: (await release(B)).id });
      expect(res.statusCode).toBe(422);
      expect(await ops()).toHaveLength(before);
    });

    it('starts a dry-run preview of a pending cleanup and rejects one on an active release', async () => {
      await rolledBack();
      const res = await post('/cleanup/preview', { releaseId: (await release(B)).id });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).toContain('data-testid="panel"');
      await idle();
      const relB = await release(B);
      expect((await ops()).filter((o) => o.kind === 'cleanup' && o.params?.mode === 'dry-run' && o.toReleaseId === relB.id)).toHaveLength(2);
      expect((await post('/cleanup/preview', { releaseId: (await release(A)).id })).statusCode).toBe(422);
    });

    it('dismisses a pending cleanup and answers the panel without the apply form', async () => {
      await rolledBack();
      const relB = await release(B);
      expect((await get(`/panel/${relB.id}`)).body).toContain('data-testid="cleanup-apply"');
      const res = await post('/cleanup/dismiss', { releaseId: relB.id });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(`data-release="${relB.id}"`);
      expect(res.body).not.toContain('data-testid="cleanup-apply"');
      expect((await release(B)).cleanupState).toBe('dismissed');
      expect((await post('/cleanup/dismiss', { releaseId: 'nope' })).statusCode).toBe(404);
    });

    it('shows a failed dry-run with a retry-preview button instead of polling, and the retry runs a new preview', async () => {
      previewExit = 1;
      await rolledBack();
      const relB = await release(B);
      const failed = (await ops()).find((o) => o.kind === 'cleanup' && o.toReleaseId === relB.id)!;
      expect(failed.status).toBe('failed');
      const panel = (await get(`/panel/${relB.id}`)).body;
      expect(panel).not.toContain('hx-trigger="every 2s"');
      expect(panel).not.toContain('data-testid="cleanup-pending"');
      expect(panel).toContain(codeMessage(en, failed.code!, failed.params as Record<string, string | number>));
      expect(panel).toContain('data-testid="cleanup-retry"');
      expect(panel).toContain('hx-post="/cleanup/preview"');

      previewExit = 0;
      const res = await post('/cleanup/preview', { releaseId: relB.id });
      expect(res.statusCode, res.body).toBe(200);
      await idle();
      const after = (await get(`/panel/${relB.id}`)).body;
      expect(after).toContain('data-testid="cleanup-apply"');
      expect(after).not.toContain('data-testid="cleanup-retry"');
    });
  });

  describe('POST /approve', () => {
    it('answers 422 and stores no approval when the confirm is not the env name', async () => {
      await destructiveRejection();
      const res = await post('/approve', { envId: prodId, commitSha: B, confirm: 'prod' });
      expect(res.statusCode).toBe(422);
      expect(await repo.getApproval(prodId, B)).toBeNull();
    });

    it('stores the approval of a SCHEMA_DESTRUCTIVE commit and answers its panel', async () => {
      await destructiveRejection();
      const res = await post('/approve', { envId: prodId, commitSha: B, confirm: 'production' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).toContain(`data-release="${(await release(B)).id}"`);
      expect(await repo.getApproval(prodId, B)).toMatchObject({ envId: prodId, commitSha: B });
    });

    it('answers 422 for an unknown env, an unknown sha and a commit that was never rejected', async () => {
      await destructiveRejection();
      expect((await post('/approve', { envId: 'nope', commitSha: B, confirm: 'production' })).statusCode).toBe(422);
      expect((await post('/approve', { envId: prodId, commitSha: 'ffffffff', confirm: 'production' })).statusCode).toBe(422);
      expect((await post('/approve', { envId: prodId, commitSha: A, confirm: 'production' })).statusCode).toBe(422);
      expect(await repo.getApproval(prodId, A)).toBeNull();
    });
  });

  describe('POST /close-window', () => {
    it('expires the older available releases and answers the panel of the closed one', async () => {
      await deploy(A);
      await deploy(B);
      const relB = await release(B);
      const res = await post('/close-window', { releaseId: relB.id });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).toContain(`data-release="${relB.id}"`);
      expect((await release(A)).state).toBe('expired');
      expect((await release(B)).state).toBe('active');
      expect((await ops()).find((o) => o.kind === 'expire')).toMatchObject({ actor: 'admin', status: 'succeeded', toReleaseId: relB.id });
    });

    it('starts the contract of the release whose window it closes when that release is next to contract', async () => {
      await deploy(A);
      await deploy(B);
      const relA = await release(A);
      expect((await post('/close-window', { releaseId: relA.id })).statusCode).toBe(200);
      const contract = (await ops()).find((o) => o.kind === 'contract')!;
      expect(contract).toMatchObject({ actor: 'admin', toReleaseId: relA.id });
      expect((await settle(contract.id)).status).toBe('succeeded');
      expect((await release(A)).contractedAt).not.toBeNull();
    });

    it('answers 422 for an unknown release', async () => {
      const res = await post('/close-window', { releaseId: 'nope' });
      expect(res.statusCode).toBe(422);
      expect(await ops()).toEqual([]);
    });

    it('answers 409 with the ENV_BUSY alert while another operation runs and expires nothing', async () => {
      await deploy(A);
      await deploy(B);
      const free = await busy();
      const res = await post('/close-window', { releaseId: (await release(A)).id });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.body).toContain('role="alert"');
      expect(res.body).toContain(codeMessage(en, 'ENV_BUSY', { env: 'production' }));
      expect((await release(A)).state).toBe('available');
      await free();
    });
  });

  describe('POST /contract/retry', () => {
    async function failedContract() {
      contractExit = 1;
      await deploy(A);
      await deploy(B);
      await post('/close-window', { releaseId: (await release(A)).id });
      const first = (await ops()).find((o) => o.kind === 'contract')!;
      expect(await settle(first.id)).toMatchObject({ status: 'failed', code: 'CONTRACT_FAILED' });
      contractExit = 0;
    }

    it('shows contract-retry on the release panel and reruns the contract from its release id', async () => {
      await failedContract();
      const relA = await release(A);
      expect((await get(`/panel/${relA.id}`)).body).toContain('data-testid="contract-retry"');
      const res = await post('/contract/retry', { releaseId: relA.id });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).toContain('data-testid="panel"');
      const contracts = (await ops()).filter((o) => o.kind === 'contract');
      expect(contracts).toHaveLength(2);
      await idle();
      expect((await release(A)).contractedAt).not.toBeNull();
    });

    it('falls back to the envId field when the release id is unknown', async () => {
      await failedContract();
      const res = await post('/contract/retry', { releaseId: 'nope', envId: prodId });
      expect(res.statusCode, res.body).toBe(200);
      expect((await ops()).filter((o) => o.kind === 'contract')).toHaveLength(2);
    });

    it('answers 422 when the env has nothing to contract', async () => {
      const res = await post('/contract/retry', { envId: stagingId });
      expect(res.statusCode).toBe(422);
      expect(await ops(stagingId)).toEqual([]);
    });
  });

  describe('POST /settings/env', () => {
    it('answers 422 with env-error, echoes the values and never echoes a password', async () => {
      const envs = (await repo.listEnvs()).length;
      const res = await post('/settings/env', envBody({ name: '', branch: 'echo-me', storage_password: 'hunter2-secret' }));
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain('data-testid="env-error"');
      expect(res.body).toContain('value="echo-me"');
      expect(res.body).not.toContain('hunter2-secret');
      expect(res.body).not.toContain('data-testid="env-bind-db"');
      expect(await repo.listEnvs()).toHaveLength(envs);
    });

    it('answers 404 for an unknown env id', async () => {
      expect((await post('/settings/env', envBody({ id: 'nope' }))).statusCode).toBe(404);
    });

    it('creates a new env once and shows the deploy token that authenticates it', async () => {
      const res = await post('/settings/env', envBody());
      expect(res.statusCode, res.body).toBe(200);
      const token = testText(res.body, 'deploy-token');
      expect(token).toBeTruthy();
      const created = await repo.envByDeployTokenHash(hashToken(token!));
      expect(created).toMatchObject({ name: 'qa', branch: 'qa' });
      expect(res.body).toContain(`name="id" value="${created!.id}"`);
      expect(res.body).toContain('data-testid="env-bind-db"');
    });

    it('updates an existing env, keeps its deploy token and shows none', async () => {
      const before = (await repo.getEnv(stagingId))!;
      const res = await post('/settings/env', stagingBody({ branch: 'release' }));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).not.toContain('data-testid="deploy-token"');
      const after = (await repo.getEnv(stagingId))!;
      expect(after.branch).toBe('release');
      expect(after.deployTokenHash).toBe(before.deployTokenHash);
      expect(await repo.listEnvs()).toHaveLength(2);
    });

    it('keeps the stored registry password when the field is empty and replaces it when filled', async () => {
      await setStagingStorage({ kind: 'registry', registry: 'reg.example.com', repository: 'shop', username: 'bot', password: 'old-pass' });
      const registry = { storage_kind: 'registry', storage_registry: 'reg.example.com', storage_repository: 'shop', storage_username: 'bot2' };
      expect((await post('/settings/env', stagingBody({ ...registry, storage_password: '' }))).statusCode).toBe(200);
      expect(await storageOf(stagingId)).toMatchObject({ kind: 'registry', username: 'bot2', password: 'old-pass' });
      expect((await post('/settings/env', stagingBody({ ...registry, storage_password: 'new-pass' }))).statusCode).toBe(200);
      expect(await storageOf(stagingId)).toMatchObject({ password: 'new-pass' });
    });

    it('keeps the stored s3 secret key when the field is empty', async () => {
      await setStagingStorage({ kind: 's3', endpoint: 'https://s3.example.com', region: 'eu', bucket: 'b', prefix: 'p', accessKey: 'AK', secretKey: 'old-secret', forcePathStyle: false });
      const s3 = { storage_kind: 's3', storage_endpoint: 'https://s3.example.com', storage_region: 'eu', storage_bucket: 'b2', storage_prefix: 'p', storage_access_key: 'AK', storage_secret_key: '' };
      expect((await post('/settings/env', stagingBody(s3))).statusCode).toBe(200);
      expect(await storageOf(stagingId)).toMatchObject({ kind: 's3', bucket: 'b2', secretKey: 'old-secret' });
    });

    it('does not carry a secret over from another storage kind', async () => {
      await setStagingStorage({ kind: 'registry', registry: 'reg.example.com', repository: 'shop', username: 'bot', password: 'old-pass' });
      const s3 = { storage_kind: 's3', storage_endpoint: 'https://s3.example.com', storage_region: 'eu', storage_bucket: 'b', storage_prefix: 'p', storage_access_key: 'AK', storage_secret_key: '' };
      expect((await post('/settings/env', stagingBody(s3))).statusCode).toBe(200);
      expect(await storageOf(stagingId)).toMatchObject({ kind: 's3', secretKey: '' });
    });

    it('saves a rolling service whose healthcheck is still unknown and shows a non-blocking hint', async () => {
      inspected = [{ name: 'web', hasHealthcheck: null, hostPorts: [] }];
      const res = await post('/settings/env', stagingBody({ branch: 'release' }));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).not.toContain('data-testid="env-error"');
      expect(res.body).toContain('data-testid="rolling-hint"');
      expect((await repo.getEnv(stagingId))!.branch).toBe('release');
    });

    it.each([
      ['name', { name: 'production' }],
      ['branch', { branch: 'main' }],
    ])('answers 422 with a field error on %s when a new env reuses another env', async (field, over) => {
      const envs = (await repo.listEnvs()).length;
      const res = await post('/settings/env', envBody(over));
      expect(res.statusCode, res.body).toBe(422);
      expect(res.body).toContain('data-testid="env-error"');
      const message = fieldError(res.body, field);
      expect(message).toBeTruthy();
      expect(message).not.toMatch(keyShaped);
      expect(await repo.listEnvs()).toHaveLength(envs);
    });

    it('answers 422 with a field error when an existing env is renamed to another env name', async () => {
      const res = await post('/settings/env', stagingBody({ name: 'production' }));
      expect(res.statusCode, res.body).toBe(422);
      expect(fieldError(res.body, 'name')).toBeTruthy();
      expect((await repo.getEnv(stagingId))!.name).toBe('staging');
    });

    it('answers 422 on the services field when a rolling service has no healthcheck', async () => {
      inspected = [{ name: 'web', hasHealthcheck: false, hostPorts: [] }];
      const res = await post('/settings/env', stagingBody({ branch: 'release' }));
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain('data-testid="env-error"');
      expect(inspectCalls).toBe(1);
      expect((await repo.getEnv(stagingId))!.branch).toBe('develop');
    });

    it('answers 422 when a rolling service publishes host ports without the bundled proxy', async () => {
      inspected = [{ name: 'web', hasHealthcheck: true, hostPorts: ['0.0.0.0:3000'] }];
      expect((await post('/settings/env', stagingBody())).statusCode).toBe(422);
      await repo.updateServer(serverId, { proxyMode: 'bundled' });
      expect((await post('/settings/env', stagingBody({ services: 'web:rolling:shop-staging.example.com:3000' }))).statusCode).toBe(200);
    });

    it('does not inspect the env when no service is rolling', async () => {
      inspected = [];
      const res = await post('/settings/env', stagingBody({ services: 'web:recreate' }));
      expect(res.statusCode, res.body).toBe(200);
      expect(inspectCalls).toBe(0);
    });
  });

  describe('POST /settings/env/:id/bind and /token', () => {
    it('reports a bound database with data-ok true', async () => {
      const res = await post(`/settings/env/${prodId}/bind`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/data-testid="bind-result"[^>]*data-ok="true"/);
      expect(res.body).toContain(`${en.t('settings.env.bind')}: ${en.t('common.yes')}`);
    });

    it('reports the other env name with data-ok false on a marker mismatch', async () => {
      markers.shop = { envId: STAGING_MARKER, envName: 'staging' };
      const res = await post(`/settings/env/${prodId}/bind`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('data-ok="false"');
      expect(testText(res.body, 'bind-result')).toContain('staging');
      expect((await repo.getEnv(prodId))!.dbMarkerId).toBe(PROD_MARKER);
    });

    it('renders the bind failure message escaped exactly once', async () => {
      markers.shop = { envId: STAGING_MARKER, envName: 'R&D <x>' };
      const res = await post(`/settings/env/${prodId}/bind`);
      expect(res.body).toContain('data-ok="false"');
      const text = /data-testid="bind-result"[^>]*>([\s\S]*?)<\/div>/.exec(res.body)?.[1];
      expect(text).toContain('R&amp;D &lt;x&gt;');
      expect(text).not.toContain('&amp;amp;');
      expect(text).not.toContain('&amp;lt;');
    });

    it('writes a fresh marker for a database without one and stores it on the env', async () => {
      delete markers['shop-staging'];
      const res = await post(`/settings/env/${stagingId}/bind`);
      expect(res.body).toContain('data-ok="true"');
      const marker = (await repo.getEnv(stagingId))!.dbMarkerId;
      expect(marker).not.toBe(STAGING_MARKER);
      expect(marker).toBeTruthy();
    });

    it('answers 404 to bind and token for an unknown env', async () => {
      expect((await post('/settings/env/nope/bind')).statusCode).toBe(404);
      expect((await post('/settings/env/nope/token')).statusCode).toBe(404);
    });

    it('regenerates the deploy token: the shown one deploys, the old one is refused', async () => {
      const res = await post(`/settings/env/${prodId}/token`);
      expect(res.statusCode).toBe(200);
      const token = testText(res.body, 'deploy-token')!;
      expect(token).toBeTruthy();
      expect(token).not.toBe(PROD_TOKEN);
      expect((await postDeploy(PROD_TOKEN, A)).statusCode).toBe(401);
      expect((await postDeploy(token, A)).statusCode).toBe(202);
      await idle();
    });
  });

  describe('settings servers', () => {
    it('creates a server with its proxy mode and shows the token inside the install command', async () => {
      const res = await post('/settings/servers', { name: 'edge', proxy_mode: 'bundled' });
      expect(res.statusCode).toBe(200);
      const token = testText(res.body, 'agent-token')!;
      const command = testText(res.body, 'agent-command')!;
      expect(command).toContain(`MICRORUN_AGENT_TOKEN=${token} microrun agent --url http://microrun.test`);
      expect(command).not.toContain('--token');
      const edge = (await repo.listServers()).find((s) => s.name === 'edge')!;
      expect(edge).toMatchObject({ builtin: false, proxyMode: 'bundled', agentTokenHash: hashToken(token) });
    });

    it('keeps the default proxy mode for an unknown one and creates nothing without a name', async () => {
      await post('/settings/servers', { name: 'edge', proxy_mode: 'weird' });
      expect((await repo.listServers()).find((s) => s.name === 'edge')!.proxyMode).toBe('external');
      const res = await post('/settings/servers', { name: '  ' });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('data-testid="agent-token"');
      expect(await repo.listServers()).toHaveLength(2);
    });

    it('trims form fields and takes the first of repeated values', async () => {
      await post('/settings/servers', [['name', '  edge  '], ['name', 'other']]);
      expect((await repo.listServers()).map((s) => s.name)).toEqual(['edge', 'main']);
    });

    it('regenerates the agent token of a server and refuses the builtin and unknown ones', async () => {
      await post('/settings/servers', { name: 'edge' });
      const edge = (await repo.listServers()).find((s) => s.name === 'edge')!;
      const res = await post(`/settings/servers/${edge.id}/token`);
      expect(res.statusCode).toBe(200);
      const token = testText(res.body, 'agent-token')!;
      expect((await repo.getServer(edge.id))!.agentTokenHash).toBe(hashToken(token));
      expect(hashToken(token)).not.toBe(edge.agentTokenHash);
      expect((await post(`/settings/servers/${serverId}/token`)).statusCode).toBe(404);
      expect((await post('/settings/servers/nope/token')).statusCode).toBe(404);
    });

    it('reissuing a token disconnects the agent holding the old one and shows the token only in the env-var command', async () => {
      await post('/settings/servers', { name: 'edge' });
      const edge = (await repo.listServers()).find((s) => s.name === 'edge')!;
      const socket = fakeSocket();
      hub.attachSocket(edge.id, socket, { agentVersion: '1.0.0' });
      expect(hub.isOnline(edge.id)).toBe(true);
      const res = await post(`/settings/servers/${edge.id}/token`);
      expect(res.statusCode).toBe(200);
      expect(socket.closed).toBe(true);
      expect(hub.isOnline(edge.id)).toBe(false);
      const token = testText(res.body, 'agent-token')!;
      const command = testText(res.body, 'agent-command')!;
      expect(command).toContain(`MICRORUN_AGENT_TOKEN=${token} microrun agent --url http://microrun.test`);
      expect(command).not.toContain('--token');
    });

    it('answers 422 with a server-error and creates nothing for a duplicate server name', async () => {
      const res = await post('/settings/servers', { name: 'main' });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.body).toContain('data-testid="server-error"');
      expect(res.body).not.toContain('data-testid="agent-token"');
      const message = /data-testid="server-error"[^>]*>([\s\S]*?)<\/div>/.exec(res.body)?.[1]?.replace(/<[^>]+>/g, '').trim();
      expect(message).toBeTruthy();
      expect(message).not.toMatch(keyShaped);
      expect(await repo.listServers()).toHaveLength(1);
    });

    it('changes the proxy mode of any server, the builtin one included', async () => {
      expect((await get('/settings/servers')).body).toContain(`action="/settings/servers/${serverId}/proxy"`);
      const res = await post(`/settings/servers/${serverId}/proxy`, { proxy_mode: 'bundled' });
      expect(res.statusCode).toBe(200);
      expect((await repo.getServer(serverId))!.proxyMode).toBe('bundled');
      await post(`/settings/servers/${serverId}/proxy`, { proxy_mode: 'weird' });
      expect((await repo.getServer(serverId))!.proxyMode).toBe('bundled');
      expect((await post('/settings/servers/nope/proxy', { proxy_mode: 'bundled' })).statusCode).toBe(404);
    });
  });

  describe('GET /history', () => {
    async function deployBoth() {
      await deploy(A);
      await deploy(B);
      const res = await postDeploy(STAGING_TOKEN, A, {}, 'develop');
      expect(res.statusCode, res.body).toBe(202);
      await settle(res.json().operationId);
    }

    it('lists finished operations of every env, newest first, with from → to shas and the actor', async () => {
      await deployBoth();
      for (const url of ['/history', '/history?env=all']) {
        const res = await get(url);
        expect(res.statusCode).toBe(200);
        expect(rowCount(res.body)).toBe(3);
      }
      const rows = tbody((await get('/history')).body);
      expect(rows).toContain(`${A7} → ${B7}`);
      expect(rows).toContain(`— → ${A7}`);
      expect(rows).toContain(en.t('actor.ci', { name: 'alice' }));
      expect(rows).toContain('staging');
      expect(rows.match(/data-status="ok"/g)).toHaveLength(3);
    });

    it('filters by env id and marks that filter on', async () => {
      await deployBoth();
      const res = await get(`/history?env=${stagingId}`);
      expect(rowCount(res.body)).toBe(1);
      expect(tbody(res.body)).not.toContain('production');
      expect(res.body).toMatch(new RegExp(`<a href="/history\\?env=${stagingId}"[^>]*aria-current="page"`));
      expect(rowCount((await get(`/history?env=${prodId}`)).body)).toBe(2);
    });

    it('shows the reason of a rejected operation', async () => {
      await destructiveRejection();
      const rows = tbody((await get('/history')).body);
      expect(rows).toMatch(/data-status="(failed|rejected)"/);
      expect(rows).toContain(codeMessage(en, 'SCHEMA_DESTRUCTIVE', { objects: 'users', col: 'users' }));
      expect(rowCount((await get('/history')).body)).toBe(2);
    });

    it('shows the mismatch and expected → deleted per rule of a succeeded cleanup', async () => {
      applyOut = '{"rule":"orphans","deleted":1}\n{"rule":"tags","deleted":1}\n';
      await rolledBack();
      const res = await post('/cleanup/apply', [['releaseId', (await release(B)).id], ['rules', 'orphans'], ['rules', 'tags']]);
      expect(res.statusCode, res.body).toBe(200);
      const apply = (await ops()).find((o) => o.kind === 'cleanup' && o.params?.mode === 'apply')!;
      expect(await settle(apply.id)).toMatchObject({ status: 'succeeded', code: 'CLEANUP_MISMATCH' });
      const rows = tbody((await get('/history')).body);
      expect(rows).toContain(codeMessage(en, 'CLEANUP_MISMATCH', { expected: 3, deleted: 2 }));
      expect(rows).toContain(en.t('cl.result', { rule: 'orphans', p: en.num(2), a: en.num(1) }));
      expect(rows).toContain(en.t('cl.result', { rule: 'tags', p: en.num(1), a: en.num(1) }));
    });

    it('lists the approval of a destructive change as an approve operation', async () => {
      await destructiveRejection();
      expect((await post('/approve', { envId: prodId, commitSha: B, confirm: 'production' })).statusCode).toBe(200);
      const body = (await get('/history')).body;
      expect(en.t('kind.approve')).not.toBe('kind.approve');
      expect(tbody(body)).toContain(en.t('kind.approve'));
      expect(rowCount(body)).toBe(3);
    });
  });

  describe('pages and /lang', () => {
    it('renders an env page and a release panel, and 404s unknown ones', async () => {
      await deploy(A);
      const env = await get(`/env/${prodId}`);
      expect(env.statusCode).toBe(200);
      expect(env.body).toContain(`data-testid="rel-production-${A7}"`);
      const panel = await get(`/panel/${(await release(A)).id}`);
      expect(panel.body).toContain(`data-release="${(await release(A)).id}"`);
      expect((await get('/env/nope')).statusCode).toBe(404);
      expect((await get('/panel/nope')).statusCode).toBe(404);
      expect((await get('/settings/env/nope')).statusCode).toBe(404);
    });

    it('warns on the board card and the panel when an active release image is not stored', async () => {
      await deploy(A);
      const relA = await release(A);
      const warn = en.t('storage.failedWarn');
      expect((await get('/')).body).not.toContain(warn);
      await db('releases').where({ id: relA.id }).update({ stored: 0 });
      expect((await get('/')).body).toContain(warn);
      expect((await get(`/panel/${relA.id}`)).body).toContain(warn);
    });

    it('reads at most 200 operations per env to render the board and a panel', async () => {
      await deploy(A);
      const spy = vi.spyOn(repo, 'listOperations');
      await get('/');
      await get(`/panel/${(await release(A)).id}`);
      expect(spy).toHaveBeenCalled();
      for (const [f] of spy.mock.calls) expect(f.limit).toBeLessThanOrEqual(200);
      spy.mockRestore();
    });

    it('prefills the env form from the stored env', async () => {
      const res = await get(`/settings/env/${prodId}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('web:rolling:shop.example.com:3000');
      expect(res.body).toContain('name="retention_value" value="1"');
    });

    it('redirects /lang back to a same-host referer and to / otherwise, ignoring an unsupported language', async () => {
      const same = await post('/lang', { lang: 'pl' }, { host: 'microrun.test', referer: 'http://microrun.test/history?env=x' });
      expect(same.statusCode).toBe(303);
      expect(same.headers.location).toBe('/history?env=x');
      const foreign = await post('/lang', { lang: 'pl' }, { host: 'microrun.test', referer: 'http://evil.test/history' });
      expect(foreign.headers.location).toBe('/');
      const bad = await post('/lang', { lang: 'xx' });
      expect(bad.statusCode).toBe(303);
      expect(bad.cookies.find((c) => c.name === 'mr_lang')).toBeUndefined();
    });
  });

  describe('UI polish', () => {
    const edgeServer = async () => {
      await post('/settings/servers', { name: 'edge' });
      return (await repo.listServers()).find((s) => s.name === 'edge')!;
    };
    const qaEnv = (sid: string) =>
      repo.saveEnv(envInput({ name: 'qa', branch: 'qa', isProduction: false, position: 2, serverId: sid, project: 'shop-qa', token: 'deploy-token-qa' }));

    it('deletes a remote server without environments and disconnects its agent', async () => {
      const edge = await edgeServer();
      const spy = vi.spyOn(hub, 'disconnect');
      const res = await post(`/settings/servers/${edge.id}/delete`, { confirm_name: 'edge' });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/settings/servers');
      expect(await repo.getServer(edge.id)).toBeNull();
      expect(spy).toHaveBeenCalledWith(edge.id);
    });

    it('refuses the builtin server with 409', async () => {
      const res = await post(`/settings/servers/${serverId}/delete`, { confirm_name: 'main' });
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain(en.t('settings.servers.deleteBuiltin'));
      expect(await repo.getServer(serverId)).not.toBeNull();
    });

    it('refuses a server that still has environments with 409 and the count', async () => {
      const edge = await edgeServer();
      await qaEnv(edge.id);
      const res = await post(`/settings/servers/${edge.id}/delete`, { confirm_name: 'edge' });
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain(en.t('settings.servers.deleteHasEnvs', { name: 'edge', n: 1 }));
      expect(await repo.getServer(edge.id)).not.toBeNull();
    });

    it('answers 400 on a wrong confirm_name, 404 on an unknown server, 403 without csrf', async () => {
      const edge = await edgeServer();
      expect((await post(`/settings/servers/${edge.id}/delete`, { confirm_name: 'edg' })).statusCode).toBe(400);
      expect(await repo.getServer(edge.id)).not.toBeNull();
      expect((await post('/settings/servers/nope/delete', { confirm_name: 'nope' })).statusCode).toBe(404);
      const bare = await app.inject({
        method: 'POST',
        url: `/settings/servers/${edge.id}/delete`,
        payload: 'confirm_name=edge',
        headers: { cookie: ui.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(bare.statusCode).toBe(403);
    });

    it('deletes an idle environment with its releases, operations and approvals', async () => {
      await deploy(A);
      await idle();
      await repo.putApproval({ envId: prodId, commitSha: B, diff: [], approvedAt: now });
      const res = await post(`/settings/env/${prodId}/delete`, { confirm_name: 'production' });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/');
      expect(await repo.getEnv(prodId)).toBeNull();
      for (const t of ['releases', 'operations', 'destructive_approvals']) expect(await db(t).where({ env_id: prodId }), t).toEqual([]);
      expect((await get('/')).body).not.toContain('data-testid="col-production"');
    });

    it('refuses to delete an environment with an operation in progress', async () => {
      const free = await busy();
      const res = await post(`/settings/env/${prodId}/delete`, { confirm_name: 'production' });
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain(en.t('settings.env.deleteBusy', { name: 'production' }));
      expect(await repo.getEnv(prodId)).not.toBeNull();
      await free();
    });

    it('answers 400 on a wrong env confirm_name and 404 on an unknown env', async () => {
      expect((await post(`/settings/env/${stagingId}/delete`, { confirm_name: 'stag' })).statusCode).toBe(400);
      expect(await repo.getEnv(stagingId)).not.toBeNull();
      expect((await post('/settings/env/nope/delete', { confirm_name: 'nope' })).statusCode).toBe(404);
      const bare = await app.inject({
        method: 'POST',
        url: `/settings/env/${stagingId}/delete`,
        payload: 'confirm_name=staging',
        headers: { cookie: ui.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(bare.statusCode).toBe(403);
      expect(await repo.getEnv(stagingId)).not.toBeNull();
    });

    it('a server can be deleted once its environments are gone', async () => {
      const edge = await edgeServer();
      const qa = await qaEnv(edge.id);
      expect((await post(`/settings/env/${qa.id}/delete`, { confirm_name: 'qa' })).statusCode).toBe(303);
      expect((await post(`/settings/servers/${edge.id}/delete`, { confirm_name: 'edge' })).statusCode).toBe(303);
    });

    it('binds a database whose marker belongs to a deleted environment', async () => {
      markers['shop-qa'] = { envId: '99999999-9999-4999-8999-999999999999', envName: 'old-qa' };
      const qa = await qaEnv(serverId);
      const res = await post(`/settings/env/${qa.id}/bind`);
      expect(res.body).toMatch(/data-testid="bind-result"[^>]*data-ok="true"/);
      expect((await repo.getEnv(qa.id))!.dbMarkerId).not.toBeNull();
    });

    it('renders the UI in English without a cookie, ignoring Accept-Language', async () => {
      const page = await app.inject({ method: 'GET', url: '/', headers: { cookie: ui.cookie, accept: 'text/html', 'accept-language': 'de' } });
      expect(page.body).toContain('<html lang="en">');
    });

    it('lists English first in the header language select', async () => {
      const body = (await get('/')).body;
      const at = body.indexOf('data-testid="lang"');
      const select = body.slice(at, body.indexOf('</select>', at));
      expect([...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1])[0]).toBe('en');
    });

    it('serves the real login page in the language chosen by GET /login?lang=uk', async () => {
      const res = await app.inject({ method: 'GET', url: '/login?lang=uk' });
      expect(res.body).toContain('<html lang="uk">');
      expect(res.body).toContain(i18n('uk').t('login.tagline'));
      expect(res.cookies.find((c) => c.name === 'mr_lang')?.value).toBe('uk');
    });
  });
});
