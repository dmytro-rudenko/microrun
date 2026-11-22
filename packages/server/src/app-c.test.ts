import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Knex } from 'knex';
import type { Command, OperationEvent, StorageConfig } from '@microrun/core/protocol';
import type { SchemaSnapshot } from '@microrun/core/schema';
import { buildApp, OpBus, streamOperation, type Frame } from './app.ts';
import type { Config } from './config.ts';
import { encrypt, hashToken } from './crypto.ts';
import { openDb } from './db/db.ts';
import { Repo } from './db/repo.ts';
import type { OperationRow } from './db/repo.ts';
import { Hub } from './hub.ts';
import { Orchestrator } from './orchestrator.ts';
import { Scheduler } from './scheduler.ts';

const A = 'a1a1a1a1';
const TOKEN = 'deploy-token-production';
const MARKER = '11111111-1111-4111-8111-111111111111';
const STORAGE: StorageConfig = { kind: 'local', path: '/backups' };
const SCHEMA: SchemaSnapshot = { kind: 'sql', engine: 'postgres', tables: [] };

const baseConfig: Config = {
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
let app: FastifyInstance | null;
let now: number;
let marker: { envId: string; envName: string };

async function agent(_key: { opId: string; step: string }, cmd: Command): Promise<unknown> {
  switch (cmd.type) {
    case 'pullImages':
      return { digests: Object.fromEntries(cmd.refs.map((r) => [r, 'sha256:aa'])) };
    case 'readMarker':
      return { markers: [{ service: cmd.db.service, marker }] };
    case 'snapshotSchema':
    case 'dryRunExpand':
      return { snapshot: SCHEMA, log: '' };
    case 'runCommand':
      return { exitCode: 0, stdout: '', log: '' };
    case 'switchServices':
      return { replaced: cmd.services.map((s) => s.name) };
    default:
      return {};
  }
}

async function build(config: Config): Promise<FastifyInstance> {
  const clock = () => now;
  const bus = new OpBus();
  const hub = new Hub({ repo, clock });
  const serverId = (await repo.createServer({ name: 'main', agentTokenHash: hashToken('agent-token'), builtin: true })).id;
  hub.attachLocal(serverId, agent);
  const envId = (await repo.saveEnv({
    name: 'production', branch: 'main', isProduction: true, position: 0, serverId,
    composeProject: 'shop', composeDir: '/srv/shop', composeFiles: ['docker-compose.yml'],
    services: [{ name: 'web', strategy: 'rolling', domain: 'shop.example.com', port: 3000 }],
    migrationService: 'web', dbKind: 'postgres', dbUrlEnv: 'DATABASE_URL', migrationTables: ['knex_migrations'],
    expandCmd: 'npm run migrate', contractCmd: null, cleanupCmd: null, schemaCheck: 'dry_run', healthTimeoutS: 90,
    storageKind: 'local', storageConfigEnc: encrypt(config.secretKey, JSON.stringify(STORAGE)), retentionS: 86400,
    deployTokenHash: hashToken(TOKEN),
  })).id;
  await repo.setEnvMarker(envId, MARKER);
  const decryptStorage = () => STORAGE;
  const orchestrator = new Orchestrator({ repo, agent: hub, clock, decryptStorage, emit: (id, ev) => bus.emit(id, ev) });
  const scheduler = new Scheduler({ repo, agent: hub, clock, decryptStorage, runContract: (id) => orchestrator.runContract(id) });
  const a = await buildApp({ config, repo, hub, orchestrator, scheduler, clock, bus });
  await a.ready();
  app = a;
  return a;
}

function postDeploy(a: FastifyInstance, branch = 'main') {
  now += 1000;
  return a.inject({
    method: 'POST',
    url: '/api/v1/deploy',
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { images: { '*': `reg/shop:${A}` }, commit: A, branch, author: 'alice', message: `commit ${A}` },
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

function login(a: FastifyInstance, forwardedFor: string, password = 'wrong-password-123') {
  return a.inject({
    method: 'POST',
    url: '/login',
    remoteAddress: '127.0.0.1',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': forwardedFor },
    payload: new URLSearchParams({ username: 'admin', password }).toString(),
  });
}

beforeEach(async () => {
  db = await openDb(':memory:');
  repo = new Repo(db);
  now = 1_700_000_000_000;
  app = null;
  marker = { envId: MARKER, envName: 'production' };
});

afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  await db.destroy();
});

describe('buildApp trustProxy', () => {
  it('limits logins per forwarded client when the proxy is trusted', async () => {
    const a = await build({ ...baseConfig, trustProxy: '127.0.0.1' });
    for (let i = 0; i < 5; i++) expect((await login(a, '203.0.113.1')).statusCode).toBe(401);
    expect((await login(a, '203.0.113.1')).statusCode).toBe(429);
    expect((await login(a, '203.0.113.2')).statusCode).toBe(401);
  });

  it('ignores X-Forwarded-For without a trusted proxy', async () => {
    const a = await build(baseConfig);
    for (let i = 0; i < 5; i++) expect((await login(a, `203.0.113.${i + 1}`)).statusCode).toBe(401);
    expect((await login(a, '203.0.113.9')).statusCode).toBe(429);
  });
});

describe('API plain-text messages', () => {
  it('answers a rejected deploy with quotes and ampersands unescaped', async () => {
    const a = await build(baseConfig);
    const res = await postDeploy(a, "fix/o'neil&co");
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'BRANCH_MISMATCH' });
    expect(res.json().message).toContain("fix/o'neil&co");
  });

  it('streams the done message with quotes and ampersands unescaped', async () => {
    const a = await build(baseConfig);
    marker = { envId: '33333333-3333-4333-8333-333333333333', envName: "qa & o'neil" };
    const res = await postDeploy(a);
    expect(res.statusCode, res.body).toBe(202);
    const op = await settle(res.json().operationId);
    expect(op.code).toBe('DB_MARKER_MISMATCH');
    const events = await a.inject({ method: 'GET', url: `/api/v1/operations/${op.id}/events`, headers: { authorization: `Bearer ${TOKEN}` } });
    const done = events.body.split('\n\n').find((chunk) => chunk.startsWith('event: done'))!;
    const data = JSON.parse(done.split('\n').find((l) => l.startsWith('data: '))!.slice('data: '.length));
    expect(data.message).toContain("qa & o'neil");
  });
});

class FakeRaw extends EventEmitter {
  chunks: string[] = [];
  ended = false;

  writeHead(): this {
    return this;
  }

  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }

  end(): void {
    this.ended = true;
  }

  text(): string {
    return this.chunks.join('');
  }

  keepalives(): number {
    return this.text().split(': keepalive\n\n').length - 1;
  }
}

describe('streamOperation', () => {
  const op = { id: 'op-1', status: 'running' } as OperationRow;
  let raw: FakeRaw;
  let bus: OpBus;
  let reply: FastifyReply;
  const deps = () => ({ bus, repo: { getOperation: async () => op } as unknown as Repo });

  beforeEach(() => {
    raw = new FakeRaw();
    bus = new OpBus();
    reply = { raw, hijack: () => undefined } as unknown as FastifyReply;
  });

  it('sends a keepalive comment every 15 s and stops once the client closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    await streamOperation(reply, deps(), op.id, () => []);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(raw.keepalives()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(raw.keepalives()).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(raw.keepalives()).toBe(2);

    raw.emit('close');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(raw.keepalives()).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the keepalive once the done frame ends the stream', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    await streamOperation(reply, deps(), op.id, (_cur, ev): Frame[] => (ev?.type === 'done' ? [['done', '{}']] : []));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(raw.keepalives()).toBe(1);

    bus.emit(op.id, { type: 'done', status: 'succeeded', code: null, message: '', params: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(raw.ended).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(raw.keepalives()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('strips CR and LF from data so a payload cannot forge another SSE line', async () => {
    await streamOperation(reply, deps(), op.id, (_cur, ev: OperationEvent | null): Frame[] =>
      ev?.type === 'log' ? [['log', ev.line]] : [],
    );
    bus.emit(op.id, { type: 'log', line: 'one\r\nevent: done\rdata: forged\ntwo' });
    await vi.waitFor(() => expect(raw.text()).toContain('event: log'));

    const lines = raw.text().split(/\r\n|\r|\n/);
    expect(lines.filter((l) => l.startsWith('event:'))).toEqual(['event: log']);
    expect(lines.filter((l) => l.startsWith('data:'))).toHaveLength(1);
    raw.emit('close');
  });
});
