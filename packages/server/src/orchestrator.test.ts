import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Knex } from 'knex';
import { AgentError } from '@microrun/core/protocol';
import type { AgentPort, Command, OperationEvent, StorageConfig } from '@microrun/core/protocol';
import { diffSchema, sameDestructive } from '@microrun/core/schema';
import type { DiffEntry, SchemaSnapshot } from '@microrun/core/schema';
import { openDb } from './db/db.ts';
import { Repo } from './db/repo.ts';
import type { EnvInput, EnvRow, OperationRow } from './db/repo.ts';
import { Orchestrator } from './orchestrator.ts';

const A = 'a1a1a1a1';
const B = 'b2b2b2b2';
const C = 'c3c3c3c3';
const D = 'd4d4d4d4';
const X = 'e5e5e5e5';
const SHAS = [A, B, C, D, X];
const MARKER = '11111111-1111-4111-8111-111111111111';
const STORAGE: StorageConfig = { kind: 'local', path: '/backups' };

function table(name: string) {
  return { name, columns: [{ name: 'id', type: 'integer', nullable: false, default: null }], indexes: [] };
}
function sql(...names: string[]): SchemaSnapshot {
  return { kind: 'sql', engine: 'postgres', tables: names.map(table) };
}
const S0 = sql('users');
const SCHEMAS: Record<string, SchemaSnapshot> = {
  [A]: sql('users', 'posts'),
  [B]: sql('users', 'posts', 'comments'),
  [C]: sql('users', 'posts', 'comments', 'tags'),
  [D]: sql('users'),
  [X]: sql('users', 'posts'),
};

const shaIn = (s: string) => SHAS.find((x) => s.includes(x));
const images = (sha: string) => ({ web: `reg/web:${sha}`, worker: `reg/worker:${sha}` });

type Key = { opId: string; step: string };
type Call = { serverId: string; key: Key; cmd: Command };
type Handler = (cmd: any, key: Key) => unknown;

class FakeAgent implements AgentPort {
  calls: Call[] = [];
  online = true;
  live: SchemaSnapshot = S0;
  marker: { envId: string; envName: string } | null = { envId: MARKER, envName: 'prod' };
  markerFor: Record<string, { envId: string; envName: string } | null> = {};
  handlers: Partial<Record<Command['type'], Handler>> = {};

  isOnline(): boolean {
    return this.online;
  }

  async call(serverId: string, key: Key, cmd: Command): Promise<any> {
    this.calls.push({ serverId, key, cmd });
    const h = this.handlers[cmd.type];
    if (h) return h(cmd, key);
    return this.fallback(cmd);
  }

  fallback(cmd: Command): unknown {
    switch (cmd.type) {
      case 'pullImages':
        return { digests: Object.fromEntries(cmd.refs.map((r) => [r, `sha256:${r.replace(/\W/g, '')}`])) };
      case 'readMarker': {
        const svc = cmd.db.service;
        return { markers: [{ service: svc, marker: svc in this.markerFor ? this.markerFor[svc] : this.marker }] };
      }
      case 'writeMarker':
        this.marker = { envId: cmd.envId, envName: cmd.envName };
        return { envId: cmd.envId };
      case 'snapshotSchema':
        return { snapshot: this.live };
      case 'dryRunExpand':
        return { snapshot: SCHEMAS[shaIn(cmd.image)!], log: '' };
      case 'runCommand':
        if (cmd.cmd === 'npm run migrate') this.live = SCHEMAS[shaIn(cmd.image)!]!;
        return { exitCode: 0, stdout: '', log: '' };
      case 'switchServices':
        return { replaced: cmd.services.map((s) => s.name) };
      default:
        return {};
    }
  }

  forOp(opId: string): Call[] {
    return this.calls.filter((c) => c.key.opId === opId);
  }

  cmds<T extends Command['type']>(opId: string, type: T): Extract<Command, { type: T }>[] {
    return this.forOp(opId).map((c) => c.cmd).filter((c): c is Extract<Command, { type: T }> => c.type === type);
  }

  steps(opId: string): string[] {
    const out: string[] = [];
    for (const c of this.forOp(opId)) {
      const s = c.key.step.replace(/[:/.].*$/, '');
      if (out[out.length - 1] !== s) out.push(s);
    }
    return out;
  }
}

let db: Knex;
let repo: Repo;
let agent: FakeAgent;
let now: number;
let events: { opId: string; ev: OperationEvent }[];
let orch: Orchestrator;
let envId: string;
let serverId: string;

function mkOrch(a: FakeAgent) {
  return new Orchestrator({
    repo,
    agent: a,
    clock: () => now,
    decryptStorage: () => STORAGE,
    emit: (opId, ev) => events.push({ opId, ev }),
  });
}

function envInput(): EnvInput {
  return {
    name: 'prod',
    branch: 'main',
    isProduction: true,
    position: 0,
    serverId,
    composeProject: 'shop',
    composeDir: '/srv/shop',
    composeFiles: ['docker-compose.yml'],
    services: [
      { name: 'web', strategy: 'rolling', domain: 'shop.example.com', port: 3000 },
      { name: 'worker', strategy: 'recreate' },
    ],
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
    storageConfigEnc: Buffer.from([1, 2, 3]),
    retentionS: 86400,
    deployTokenHash: 'deploy-prod',
  };
}

async function env(): Promise<EnvRow> {
  return (await repo.getEnv(envId))!;
}

async function setEnv(patch: Partial<EnvInput>) {
  await repo.saveEnv({ ...envInput(), ...patch, id: envId });
}

async function rel(sha: string) {
  return (await repo.listReleases(envId)).find((r) => r.commitSha === sha);
}

async function ops(): Promise<OperationRow[]> {
  return repo.listOperations({ envId, limit: 100 });
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

function req(sha: string, extra: Record<string, unknown> = {}) {
  return { images: images(sha), commit: sha, branch: 'main', author: 'alice', message: `commit ${sha}`, ...extra } as any;
}

async function request(sha: string, extra: Record<string, unknown> = {}) {
  now += 1000;
  return orch.requestDeploy(await env(), req(sha, extra));
}

async function deploy(sha: string): Promise<OperationRow> {
  const res = await request(sha);
  if (!('operationId' in res)) throw new Error(`deploy ${sha} rejected with ${res.rejected.code}`);
  return settle(res.operationId);
}

async function rollback(sha: string): Promise<OperationRow> {
  now += 1000;
  const res = await orch.requestRollback(envId, (await rel(sha))!.id);
  if (!('operationId' in res)) throw new Error(`rollback to ${sha} rejected with ${res.rejected.code}`);
  const op = await settle(res.operationId);
  if (op.status === 'succeeded') await previewsSettled(op.id);
  return op;
}

async function previewsSettled(rollbackOpId: string) {
  await vi.waitFor(
    async () => {
      const blocked = (await repo.listReleases(envId)).filter((r) => r.blockedByOp === rollbackOpId && r.hasCleanupCmd);
      const cleanups = (await ops()).filter((o) => o.kind === 'cleanup' && o.status !== 'pending' && o.status !== 'running');
      for (const r of blocked) {
        if (!cleanups.some((o) => o.toReleaseId === r.id)) throw new Error(`no finished cleanup preview for ${r.commitSha}`);
      }
    },
    { timeout: 3000, interval: 5 },
  );
}

function rejectedCode(res: { operationId: string } | { rejected: { code: string } }) {
  return 'rejected' in res ? res.rejected.code : `accepted ${res.operationId}`;
}

beforeEach(async () => {
  db = await openDb(':memory:');
  repo = new Repo(db);
  now = 1_700_000_000_000;
  events = [];
  agent = new FakeAgent();
  orch = mkOrch(agent);
  serverId = (await repo.createServer({ name: 'main', agentTokenHash: 'agent-hash', builtin: false })).id;
  envId = (await repo.saveEnv(envInput())).id;
  await repo.setEnvMarker(envId, MARKER);
});

afterEach(async () => {
  await db.destroy();
});

describe('Orchestrator deploy', () => {
  it('deploys v1 then v2 with the named steps, activation_seq and stored snapshots', async () => {
    const op1 = await deploy(A);
    expect(op1).toMatchObject({ status: 'succeeded', kind: 'deploy', actor: 'ci:alice' });
    expect(agent.steps(op1.id)).toEqual(['pull', 'markers', 'baseline', 'dryRun', 'expand', 'snapshot', 'switch', 'store']);
    const r1 = (await rel(A))!;
    expect(op1.toReleaseId).toBe(r1.id);
    expect(r1).toMatchObject({ state: 'active', activationSeq: 1, stored: true, author: 'alice', message: `commit ${A}` });
    expect(Object.keys(r1.images).sort()).toEqual(['web', 'worker']);
    expect(r1.images.web!.ref).toBe(`reg/web:${A}`);
    expect(r1.schemaSnapshot).toEqual(SCHEMAS[A]);
    expect(r1.schemaDiff).toEqual(diffSchema(S0, SCHEMAS[A]!));

    const pull = agent.cmds(op1.id, 'pullImages')[0]!;
    expect([...pull.refs].sort()).toEqual([`reg/web:${A}`, `reg/worker:${A}`]);
    const dry = agent.cmds(op1.id, 'dryRunExpand')[0]!;
    expect(dry).toMatchObject({ cmd: 'npm run migrate', migrationTables: ['knex_migrations'], opId: op1.id });
    expect(dry.image).toContain(A);
    const expand = agent.cmds(op1.id, 'runCommand')[0]!;
    expect(expand).toMatchObject({ service: 'web', cmd: 'npm run migrate', args: [] });
    expect(expand.image).toContain(A);
    expect(expand.env).toMatchObject({ MICRORUN_ENV: 'prod', MICRORUN_RELEASE_COMMIT: A });
    expect(expand.env.MICRORUN_DEPLOYED_AT).toBeDefined();
    const sw = agent.cmds(op1.id, 'switchServices')[0]!;
    expect(sw.healthTimeoutS).toBe(90);
    expect(sw.services.map((s) => [s.name, s.strategy])).toEqual([['web', 'rolling'], ['worker', 'recreate']]);
    expect(sw.services.every((s) => s.image.includes(A))).toBe(true);
    const store = agent.cmds(op1.id, 'storeImages')[0]!;
    expect(store).toMatchObject({ storage: STORAGE, env: 'prod', sha: A });
    expect(agent.forOp(op1.id).every((c) => c.serverId === serverId)).toBe(true);

    const evs = events.filter((e) => e.opId === op1.id).map((e) => e.ev);
    expect(evs).toContainEqual({ type: 'step', step: 'pull', status: 'done' });
    expect(evs.at(-1)).toMatchObject({ type: 'done', status: 'succeeded' });

    const op2 = await deploy(B);
    const deployedB = now;
    expect(op2.status).toBe('succeeded');
    expect(agent.steps(op2.id)).toEqual(['pull', 'markers', 'dryRun', 'expand', 'snapshot', 'switch', 'store']);
    expect(await rel(A)).toMatchObject({ state: 'available', activationSeq: 1, supersededAt: deployedB });
    const r2 = (await rel(B))!;
    expect(r2).toMatchObject({ state: 'active', activationSeq: 2 });
    expect(r2.schemaDiff).toEqual(diffSchema(SCHEMAS[A]!, SCHEMAS[B]!));
  });

  it('reactivates an available commit without dryRun, expand or snapshot and keeps its snapshot', async () => {
    await deploy(A);
    await deploy(B);
    const op = await deploy(A);
    expect(op.status).toBe('succeeded');
    expect(agent.steps(op.id)).toEqual(['pull', 'markers', 'switch', 'store']);
    expect(await rel(A)).toMatchObject({ state: 'active', activationSeq: 3, schemaSnapshot: SCHEMAS[A] });
    expect(await rel(B)).toMatchObject({ state: 'available' });
  });

  it('expands a single "*" image to every service', async () => {
    const res = await request(A, { images: { '*': `reg/app:${A}` } });
    if (!('operationId' in res)) throw new Error(res.rejected.code);
    expect((await settle(res.operationId)).status).toBe('succeeded');
    const r = (await rel(A))!;
    expect(Object.keys(r.images).sort()).toEqual(['web', 'worker']);
    expect(r.images.worker!.ref).toBe(`reg/app:${A}`);
  });

  it.each([
    ['a missing service', { web: `reg/web:${A}` }],
    ['an unknown service', { ...images(A), cron: `reg/cron:${A}` }],
    ['"*" next to a service', { '*': `reg/app:${A}`, web: `reg/web:${A}` }],
  ])('rejects %s with INVALID_REQUEST', async (_, imgs) => {
    const res = await request(A, { images: imgs });
    expect(rejectedCode(res)).toBe('INVALID_REQUEST');
    expect(await repo.listReleases(envId)).toEqual([]);
    expect(await ops()).toEqual([]);
  });

  it('runs the pre-checks in order and creates nothing while rejecting', async () => {
    const unbound = await repo.saveEnv({ ...envInput(), name: 'bare', branch: 'bare', deployTokenHash: 'deploy-bare' });
    const expired = await repo.insertRelease({
      envId: unbound.id, commitSha: X, images: { web: { ref: 'r', digest: 'd' }, worker: { ref: 'r', digest: 'd' } },
      author: 'bob', message: 'old', deployedAt: 1, schemaSnapshot: S0, schemaDiff: [], state: 'expired', stored: true,
    });
    agent.online = false;
    await repo.createOperation({
      envId: unbound.id, kind: 'cleanup', fromReleaseId: null, toReleaseId: null, actor: 'admin', status: 'pending', startedAt: now,
    });
    const call = async (e: EnvRow, sha: string, extra: Record<string, unknown>) => orch.requestDeploy(e, req(sha, extra));

    const r1 = await call(unbound, X, { branch: 'feature', images: { web: 'x' } });
    expect(r1).toMatchObject({ rejected: { code: 'BRANCH_MISMATCH', params: { branch: 'feature', expected: 'bare' } } });
    expect(rejectedCode(await call(unbound, X, { branch: 'bare', images: { web: 'x' } }))).toBe('INVALID_REQUEST');
    expect(rejectedCode(await call(unbound, X, { branch: 'bare' }))).toBe('DB_NOT_BOUND');
    await repo.setEnvMarker(unbound.id, '22222222-2222-4222-8222-222222222222');
    const bound = (await repo.getEnv(unbound.id))!;
    expect(rejectedCode(await call(bound, X, { branch: 'bare' }))).toBe('COMMIT_EXPIRED');
    expect(rejectedCode(await call(bound, A, { branch: 'bare' }))).toBe('AGENT_OFFLINE');
    agent.online = true;
    expect(rejectedCode(await call(bound, A, { branch: 'bare' }))).toBe('ENV_BUSY');

    expect((await repo.listReleases(unbound.id)).map((r) => r.id)).toEqual([expired.id]);
    expect(await repo.listOperations({ envId: unbound.id, limit: 100 })).toHaveLength(1);
    expect(agent.calls).toEqual([]);
  });

  it('rejects a blocked commit with COMMIT_BLOCKED {sha:7, env, at}', async () => {
    await deploy(A);
    await deploy(B);
    await rollback(A);
    const before = await repo.listReleases(envId);
    const res = await request(B);
    expect(res).toMatchObject({ rejected: { code: 'COMMIT_BLOCKED', params: { sha: B.slice(0, 7), env: 'prod' } } });
    if ('rejected' in res) expect(typeof res.rejected.params.at).toBe('number');
    expect(await repo.listReleases(envId)).toEqual(before);
  });

  it('answers an active commit with a succeeded ALREADY_ACTIVE operation, even with the agent offline', async () => {
    await deploy(A);
    agent.online = false;
    const callsBefore = agent.calls.length;
    const res = await request(A);
    if (!('operationId' in res)) throw new Error(res.rejected.code);
    const op = (await repo.getOperation(res.operationId))!;
    expect(op).toMatchObject({ status: 'succeeded', code: 'ALREADY_ACTIVE', kind: 'deploy' });
    expect(agent.calls.length).toBe(callsBefore);
    expect(await rel(A)).toMatchObject({ state: 'active', activationSeq: 1 });
  });

  it('lets exactly one of two parallel deploys through and answers the other ENV_BUSY', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    agent.handlers.pullImages = async (cmd) => {
      await gate;
      return agent.fallback(cmd);
    };
    const e = await env();
    now += 1000;
    const [ra, rb] = await Promise.all([orch.requestDeploy(e, req(A)), orch.requestDeploy(e, req(B))]);
    const results = [ra, rb];
    const accepted = results.filter((r): r is { operationId: string } => 'operationId' in r);
    const rejected = results.filter((r) => 'rejected' in r);
    expect(accepted).toHaveLength(1);
    expect(rejected).toEqual([{ rejected: expect.objectContaining({ code: 'ENV_BUSY' }) }]);
    expect(await repo.activeOperations()).toHaveLength(1);
    open();
    const op = await settle(accepted[0]!.operationId);
    expect(op.status).toBe('succeeded');
    const winner = 'operationId' in ra ? A : B;
    expect((await repo.listReleases(envId)).map((r) => r.commitSha)).toEqual([winner]);
  });

  it('rejects a destructive dry-run with SCHEMA_DESTRUCTIVE and never runs expand', async () => {
    await deploy(A);
    const op = await deploy(D);
    expect(op).toMatchObject({ status: 'rejected', code: 'SCHEMA_DESTRUCTIVE' });
    expect(op.params!.objects).toContain('posts');
    expect(agent.cmds(op.id, 'dryRunExpand')).toHaveLength(1);
    expect(agent.cmds(op.id, 'runCommand')).toEqual([]);
    expect(agent.cmds(op.id, 'switchServices')).toEqual([]);
    expect(await rel(D)).toMatchObject({ state: 'failed' });
    expect(await rel(A)).toMatchObject({ state: 'active' });
    expect(agent.live).toEqual(SCHEMAS[A]);
    expect(events.filter((e) => e.opId === op.id).at(-1)?.ev).toMatchObject({ type: 'done', status: 'rejected', code: 'SCHEMA_DESTRUCTIVE' });
  });

  it('passes an approved destructive commit once and expires every available release', async () => {
    await deploy(A);
    await deploy(B);
    const rejected = await deploy(D);
    expect(rejected.code).toBe('SCHEMA_DESTRUCTIVE');
    await orch.approveDestructive(envId, D);
    const approval = (await repo.getApproval(envId, D))!;
    expect(sameDestructive(approval.diff as DiffEntry[], diffSchema(SCHEMAS[B]!, SCHEMAS[D]!))).toBe(true);

    const op = await deploy(D);
    expect(op.status).toBe('succeeded');
    expect(op.log).toContain('SCHEMA_DESTRUCTIVE_APPROVED');
    expect((await repo.getApproval(envId, D))!.usedByOp).toBe(op.id);
    expect(await rel(D)).toMatchObject({ state: 'active', destructiveApproved: true });
    expect(await rel(A)).toMatchObject({ state: 'expired' });
    expect(await rel(B)).toMatchObject({ state: 'expired' });
  });

  it('rejects the next redeploy again once the approval was used by a failed attempt', async () => {
    await deploy(A);
    await deploy(D);
    await orch.approveDestructive(envId, D);
    agent.handlers.switchServices = () => {
      throw new AgentError('HEALTHCHECK_FAILED', { service: 'web' });
    };
    const failed = await deploy(D);
    expect(failed).toMatchObject({ status: 'failed', code: 'HEALTHCHECK_FAILED' });
    expect(failed.log).toContain('SCHEMA_DESTRUCTIVE_APPROVED');
    delete agent.handlers.switchServices;

    const again = await deploy(D);
    expect(again).toMatchObject({ status: 'rejected', code: 'SCHEMA_DESTRUCTIVE' });
    expect(agent.cmds(again.id, 'switchServices')).toEqual([]);
    expect(await rel(A)).toMatchObject({ state: 'active' });
    expect(await rel(D)).toMatchObject({ state: 'failed' });
  });

  it('keeps rejecting a post_check destructive retry because the base is the active snapshot', async () => {
    await setEnv({ schemaCheck: 'post_check' });
    await deploy(A);
    const first = await deploy(D);
    expect(first).toMatchObject({ status: 'rejected', code: 'SCHEMA_DESTRUCTIVE' });
    expect(agent.cmds(first.id, 'dryRunExpand')).toEqual([]);
    expect(agent.cmds(first.id, 'runCommand')).toHaveLength(1);
    expect(agent.live).toEqual(SCHEMAS[D]);

    const retry = await deploy(D);
    expect(retry).toMatchObject({ status: 'rejected', code: 'SCHEMA_DESTRUCTIVE' });
    expect(retry.params!.objects).toContain('posts');
    expect(agent.cmds(retry.id, 'switchServices')).toEqual([]);
    expect(await rel(D)).toMatchObject({ state: 'failed' });
    expect(await rel(A)).toMatchObject({ state: 'active' });
  });

  it('fails with MIGRATION_FAILED on a non-zero expand exit and keeps the previous release active', async () => {
    await deploy(A);
    agent.handlers.runCommand = () => ({ exitCode: 1, stdout: '', log: 'boom' });
    const op = await deploy(B);
    expect(op).toMatchObject({ status: 'failed', code: 'MIGRATION_FAILED' });
    expect(agent.cmds(op.id, 'switchServices')).toEqual([]);
    expect(await rel(B)).toMatchObject({ state: 'failed' });
    expect(await rel(A)).toMatchObject({ state: 'active', activationSeq: 1 });
  });

  it('fails the operation and the release on an agent error in an early step', async () => {
    agent.handlers.pullImages = () => {
      throw new AgentError('IMAGE_PULL_FAILED', { ref: `reg/web:${A}` });
    };
    const op = await deploy(A);
    expect(op).toMatchObject({ status: 'failed', code: 'IMAGE_PULL_FAILED' });
    expect(await rel(A)).toMatchObject({ state: 'failed' });
  });

  it('rejects with DB_MARKER_MISMATCH {svc, other} when a service points at another env database', async () => {
    agent.markerFor.worker = { envId: '33333333-3333-4333-8333-333333333333', envName: 'stage' };
    const op = await deploy(A);
    expect(op).toMatchObject({ status: 'rejected', code: 'DB_MARKER_MISMATCH', params: { svc: 'worker', other: 'stage' } });
    expect(agent.cmds(op.id, 'runCommand')).toEqual([]);
    expect(await rel(A)).toMatchObject({ state: 'failed' });
  });

  it('keeps a deploy succeeded with stored=0 and a STORAGE_FAILED log line when storing fails', async () => {
    agent.handlers.storeImages = () => {
      throw new AgentError('STORAGE_FAILED', { reason: 'disk full' });
    };
    const op = await deploy(A);
    expect(op.status).toBe('succeeded');
    expect(op.log).toContain('STORAGE_FAILED');
    expect(await rel(A)).toMatchObject({ state: 'active', stored: false });
  });
});

describe('Orchestrator rollback', () => {
  it('rolls R3 back to R1, blocking R3 and R2 without running DDL', async () => {
    await deploy(A);
    await deploy(B);
    await deploy(C);
    const op = await rollback(A);
    const at = now;
    expect(op).toMatchObject({ status: 'succeeded', kind: 'rollback' });
    expect(agent.steps(op.id)).toEqual(['markers', 'fetch', 'switch']);
    const fetch = agent.cmds(op.id, 'fetchImages')[0]!;
    expect(fetch).toMatchObject({ storage: STORAGE, env: 'prod', sha: A });
    const sw = agent.cmds(op.id, 'switchServices')[0]!;
    expect(sw.healthTimeoutS).toBe(45);
    expect(sw.services.every((s) => s.image.includes(A))).toBe(true);
    expect(agent.cmds(op.id, 'runCommand')).toEqual([]);
    expect(agent.cmds(op.id, 'snapshotSchema')).toEqual([]);
    expect(await rel(A)).toMatchObject({ state: 'active', activationSeq: 4 });
    expect(await rel(B)).toMatchObject({ state: 'blocked', blockedAt: at, blockedByOp: op.id, cleanupState: 'pending' });
    expect(await rel(C)).toMatchObject({ state: 'blocked', blockedAt: at, blockedByOp: op.id, cleanupState: 'pending' });
  });

  it('leaves every release state unchanged when the switch fails', async () => {
    await deploy(A);
    await deploy(B);
    await deploy(C);
    const before = await repo.listReleases(envId);
    agent.handlers.switchServices = () => {
      throw new AgentError('HEALTHCHECK_FAILED', { service: 'web' });
    };
    const op = await rollback(A);
    expect(op).toMatchObject({ status: 'failed', code: 'HEALTHCHECK_FAILED' });
    expect(await repo.listReleases(envId)).toEqual(before);
  });

  it('rejects a rollback with DB_MARKER_MISMATCH {svc, other} without fetching or switching', async () => {
    await deploy(A);
    await deploy(B);
    const before = await repo.listReleases(envId);
    agent.markerFor.worker = { envId: '33333333-3333-4333-8333-333333333333', envName: 'stage' };
    const op = await rollback(A);
    expect(op).toMatchObject({ status: 'rejected', code: 'DB_MARKER_MISMATCH', params: { svc: 'worker', other: 'stage' } });
    expect(agent.cmds(op.id, 'fetchImages')).toEqual([]);
    expect(agent.cmds(op.id, 'switchServices')).toEqual([]);
    expect(await repo.listReleases(envId)).toEqual(before);
  });

  it('rejects a rollback with AGENT_OFFLINE and creates no operation', async () => {
    await deploy(A);
    await deploy(B);
    const opsBefore = (await ops()).length;
    agent.online = false;
    const res = await orch.requestRollback(envId, (await rel(A))!.id);
    expect(rejectedCode(res)).toBe('AGENT_OFFLINE');
    expect(await ops()).toHaveLength(opsBefore);
  });
});

describe('Orchestrator cleanup', () => {
  const previewOut: Record<string, string> = {
    [B]: '{"rule":"orphans","description":"Orphan posts","count":2}\n',
    [C]: 'starting\n{"rule":"orphans","description":"Orphan posts","count":5}\n{"rule":"tags","description":"Unused tags","count":0}\n',
  };
  const applyOut: Record<string, string> = {
    [B]: '{"rule":"orphans","deleted":2}\n',
    [C]: '{"rule":"orphans","deleted":3}\n',
  };

  beforeEach(() => {
    agent.handlers.runCommand = (cmd) => {
      if (cmd.cmd !== 'npm run cleanup') return agent.fallback(cmd);
      const sha = shaIn(cmd.image)!;
      return { exitCode: 0, stdout: cmd.args[0] === '--dry-run' ? previewOut[sha] : applyOut[sha], log: '' };
    };
  });

  async function cleanupOp(res: { operationId: string } | { rejected: { code: string } }) {
    if (!('operationId' in res)) throw new Error(res.rejected.code);
    return settle(res.operationId);
  }

  it('previews from the blocked release image, then applies with a CLEANUP_MISMATCH', async () => {
    await deploy(A);
    await deploy(B);
    await deploy(C);
    await rollback(A);
    const rolledBackAt = now;
    const relC = (await rel(C))!;

    now += 1000;
    const preview = await cleanupOp(await orch.requestCleanupPreview(relC.id));
    expect(preview).toMatchObject({ status: 'succeeded', kind: 'cleanup' });
    const dry = agent.cmds(preview.id, 'runCommand')[0]!;
    expect(dry).toMatchObject({ service: 'web', cmd: 'npm run cleanup', args: ['--dry-run'] });
    expect(dry.image).toContain(C);
    expect(dry.image).toContain('web');
    expect(dry.env).toMatchObject({
      MICRORUN_ENV: 'prod',
      MICRORUN_RELEASE_COMMIT: C,
      MICRORUN_ROLLED_BACK_AT: new Date(rolledBackAt).toISOString(),
    });
    expect(dry.env.MICRORUN_DEPLOYED_AT).toBeDefined();
    expect(await rel(C)).toMatchObject({
      cleanupState: 'pending',
      cleanupPreview: [
        { rule: 'orphans', description: 'Orphan posts', count: 5 },
        { rule: 'tags', description: 'Unused tags', count: 0 },
      ],
    });

    now += 1000;
    const apply = await cleanupOp(await orch.requestCleanupApply(relC.id, ['orphans', 'tags']));
    expect(agent.cmds(apply.id, 'runCommand')[0]).toMatchObject({ cmd: 'npm run cleanup', args: ['--apply', '--rules=orphans,tags'] });
    expect(apply).toMatchObject({ status: 'succeeded', kind: 'cleanup', code: 'CLEANUP_MISMATCH' });
    expect(apply.cleanupResult).not.toBeNull();
    expect(await rel(C)).toMatchObject({ cleanupState: 'applied' });
  });

  it('previews every release blocked by a rollback on its own cleanup operation, newest first', async () => {
    await deploy(A);
    await deploy(B);
    await deploy(C);
    const rb = await rollback(A);
    expect(rb.status).toBe('succeeded');
    const cleanups = (await ops()).filter((o) => o.kind === 'cleanup');
    const relB = (await rel(B))!;
    const relC = (await rel(C))!;
    expect(cleanups.map((o) => o.toReleaseId).sort()).toEqual([relB.id, relC.id].sort());
    expect(cleanups.every((o) => o.status === 'succeeded')).toBe(true);
    const dryRuns = agent.calls
      .map((c) => c.cmd)
      .filter((c): c is Extract<Command, { type: 'runCommand' }> => c.type === 'runCommand' && c.args[0] === '--dry-run');
    expect(dryRuns.map((c) => shaIn(c.image))).toEqual([C, B]);
    expect(relC.cleanupPreview).toEqual([
      { rule: 'orphans', description: 'Orphan posts', count: 5 },
      { rule: 'tags', description: 'Unused tags', count: 0 },
    ]);
    expect(relB.cleanupPreview).toEqual([{ rule: 'orphans', description: 'Orphan posts', count: 2 }]);
    expect(relB.cleanupState).toBe('pending');
  });

  it('applies a cleanup whose deleted counts match the preview without a code', async () => {
    await deploy(A);
    await deploy(B);
    await rollback(A);
    const relB = (await rel(B))!;
    await cleanupOp(await orch.requestCleanupPreview(relB.id));
    const apply = await cleanupOp(await orch.requestCleanupApply(relB.id, ['orphans']));
    expect(agent.cmds(apply.id, 'runCommand')[0]).toMatchObject({ args: ['--apply', '--rules=orphans'] });
    expect(apply).toMatchObject({ status: 'succeeded', code: null });
    expect(await rel(B)).toMatchObject({ cleanupState: 'applied' });
  });

  it('logs the non-protocol stdout lines and the per-rule counts of a cleanup', async () => {
    await deploy(A);
    await deploy(B);
    await deploy(C);
    await rollback(A);
    const relC = (await rel(C))!;
    const preview = await settle((await ops()).find((o) => o.kind === 'cleanup' && o.toReleaseId === relC.id)!.id);
    expect(preview.log).toContain('starting');
    const apply = await cleanupOp(await orch.requestCleanupApply(relC.id, ['orphans', 'gone']));
    expect(apply.log).toContain('orphans: expected 5, deleted 3');
    expect(apply.log).toContain('gone: expected 0, deleted 0');
    expect(apply.log).toContain('CLEANUP_MISMATCH: expected 5, deleted 3');
    expect(apply).toMatchObject({ code: 'CLEANUP_MISMATCH', params: { expected: 5, deleted: 3 } });
    expect(apply.cleanupResult).toEqual([
      { rule: 'orphans', expected: 5, deleted: 3 },
      { rule: 'gone', expected: 0, deleted: 0 },
    ]);
  });

  it('fails a cleanup with MIGRATION_FAILED {exitCode} on a non-zero exit and stores no preview', async () => {
    agent.handlers.runCommand = (cmd) => (cmd.cmd === 'npm run cleanup' ? { exitCode: 4, stdout: '', log: '' } : agent.fallback(cmd));
    await deploy(A);
    await deploy(B);
    await rollback(A);
    const relB = (await rel(B))!;
    const preview = await settle((await ops()).find((o) => o.kind === 'cleanup' && o.toReleaseId === relB.id)!.id);
    expect(preview).toMatchObject({ status: 'failed', code: 'MIGRATION_FAILED', params: { exitCode: 4 } });
    expect(relB).toMatchObject({ cleanupState: 'pending', cleanupPreview: null });
  });

  it('rejects cleanup of a release that is not blocked with INVALID_REQUEST', async () => {
    await deploy(A);
    expect(await orch.requestCleanupPreview((await rel(A))!.id)).toMatchObject({ rejected: { code: 'INVALID_REQUEST' } });
    expect(await orch.requestCleanupApply((await rel(A))!.id, [])).toMatchObject({ rejected: { code: 'INVALID_REQUEST' } });
  });
});

describe('Orchestrator resume', () => {
  it('resumeAll continues an interrupted deploy from the first step not in steps_done', async () => {
    agent.handlers.switchServices = () => new Promise(() => {});
    const res = await request(A);
    if (!('operationId' in res)) throw new Error(res.rejected.code);
    const opId = res.operationId;
    await vi.waitFor(() => {
      if (!agent.cmds(opId, 'switchServices').length) throw new Error('switch not reached');
    });
    const stepsDone = (await repo.getOperation(opId))!.stepsDone;
    expect(Object.keys(stepsDone)).toEqual(expect.arrayContaining(['pull', 'markers', 'baseline', 'dryRun', 'expand', 'snapshot']));

    const restarted = new FakeAgent();
    restarted.live = agent.live;
    await mkOrch(restarted).resumeAll();
    const op = await settle(opId);
    expect(op.status).toBe('succeeded');
    expect(restarted.steps(opId)).toEqual(['switch', 'store']);
    expect(await rel(A)).toMatchObject({ state: 'active', activationSeq: 1, schemaSnapshot: SCHEMAS[A] });
  });
});

describe('Orchestrator contract retry', () => {
  async function failedContract() {
    await deploy(A);
    const relA = (await rel(A))!;
    await repo.createOperation({
      envId, kind: 'contract', fromReleaseId: relA.id, toReleaseId: relA.id, actor: 'system',
      status: 'failed', code: 'CONTRACT_FAILED', startedAt: now,
    });
    return relA;
  }

  it('re-labels an agent timeout during a retried contract as CONTRACT_FAILED', async () => {
    await failedContract();
    agent.handlers.runCommand = (cmd) => {
      if (cmd.cmd === 'npm run contract') throw new AgentError('MIGRATION_FAILED', { reason: 'timeout', cmd: cmd.cmd });
      return agent.fallback(cmd);
    };
    now += 1000;
    const res = await orch.retryContract(envId);
    if (!('operationId' in res)) throw new Error(res.rejected.code);
    const op = await settle(res.operationId);
    expect(op).toMatchObject({ kind: 'contract', status: 'failed', code: 'CONTRACT_FAILED' });
    expect(await rel(A)).toMatchObject({ contractedAt: null });
  });

  it('runs contract_cmd from the release image and stamps contracted_at on success', async () => {
    await failedContract();
    now += 1000;
    const res = await orch.retryContract(envId);
    if (!('operationId' in res)) throw new Error(res.rejected.code);
    const op = await settle(res.operationId);
    expect(op).toMatchObject({ kind: 'contract', status: 'succeeded' });
    const cmd = agent.cmds(op.id, 'runCommand')[0]!;
    expect(cmd).toMatchObject({ service: 'web', cmd: 'npm run contract' });
    expect(cmd.image).toContain(A);
    expect(await rel(A)).toMatchObject({ contractedAt: now });
  });
});

describe('Orchestrator bindDatabase', () => {
  beforeEach(async () => {
    envId = (await repo.saveEnv({ ...envInput(), name: 'fresh', branch: 'fresh', deployTokenHash: 'deploy-fresh' })).id;
  });

  it('writes a new marker when the database has none and stores it on the env', async () => {
    agent.marker = null;
    const res = await orch.bindDatabase(envId);
    expect(res).toEqual({ ok: true });
    const read = agent.calls.find((c) => c.cmd.type === 'readMarker')!.cmd as Extract<Command, { type: 'readMarker' }>;
    expect(read.db).toMatchObject({ service: 'web', dbKind: 'postgres', dbUrlEnv: 'DATABASE_URL' });
    const writes = agent.calls.filter((c) => c.cmd.type === 'writeMarker').map((c) => c.cmd as Extract<Command, { type: 'writeMarker' }>);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.envName).toBe('fresh');
    expect(writes[0]!.envId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect((await env()).dbMarkerId).toBe(writes[0]!.envId);

    expect(await orch.bindDatabase(envId)).toEqual({ ok: true });
    expect(agent.calls.filter((c) => c.cmd.type === 'writeMarker')).toHaveLength(1);
    expect((await env()).dbMarkerId).toBe(writes[0]!.envId);
  });

  it('refuses a database that carries the marker of another env', async () => {
    agent.marker = { envId: '44444444-4444-4444-8444-444444444444', envName: 'stage' };
    const res = await orch.bindDatabase(envId);
    expect(res).toEqual({ ok: false, code: 'DB_MARKER_MISMATCH', params: { other: 'stage' } });
    expect(agent.calls.filter((c) => c.cmd.type === 'writeMarker')).toEqual([]);
    expect((await env()).dbMarkerId).toBeNull();
  });
});

describe('Orchestrator migration tables', () => {
  const withMeta = (s: SchemaSnapshot): SchemaSnapshot =>
    s.kind === 'sql' ? { ...s, tables: [...s.tables, table('django_migrations')] } : s;

  beforeEach(async () => {
    await setEnv({ migrationTables: ['django_migrations'] });
    agent.handlers.snapshotSchema = () => ({ snapshot: withMeta(agent.live) });
  });

  it('leaves the env migration_tables out of the baseline, so a dry_run deploy is not destructive', async () => {
    const op = await deploy(A);
    expect(op).toMatchObject({ status: 'succeeded', code: null });
    const r = (await rel(A))!;
    expect(r.schemaSnapshot).toEqual(SCHEMAS[A]);
    expect(r.schemaDiff).toEqual(diffSchema(S0, SCHEMAS[A]!));
  });

  it('leaves the env migration_tables out of the stored after-expand snapshot under post_check', async () => {
    await setEnv({ migrationTables: ['django_migrations'], schemaCheck: 'post_check' });
    await deploy(A);
    const op = await deploy(B);
    expect(op.status).toBe('succeeded');
    expect((await rel(A))!.schemaSnapshot).toEqual(SCHEMAS[A]);
    expect((await rel(B))!.schemaDiff).toEqual(diffSchema(SCHEMAS[A]!, SCHEMAS[B]!));
  });
});

describe('Orchestrator resume after activate', () => {
  async function interruptedAtStore(sha: string) {
    agent.handlers.storeImages = () => new Promise(() => {});
    const res = await request(sha);
    if (!('operationId' in res)) throw new Error(res.rejected.code);
    const opId = res.operationId;
    await vi.waitFor(() => {
      if (!agent.cmds(opId, 'storeImages').length) throw new Error('store not reached');
    });
    return opId;
  }

  async function resume(opId: string) {
    const restarted = new FakeAgent();
    restarted.live = agent.live;
    await mkOrch(restarted).resumeAll();
    return { op: await settle(opId), restarted };
  }

  it('records the reactivate decision and resumes a reactivation with only the store step', async () => {
    await deploy(A);
    await deploy(B);
    const opId = await interruptedAtStore(A);
    const stepsDone = (await repo.getOperation(opId))!.stepsDone;
    expect(stepsDone.plan).toEqual({ reactivate: true });
    expect(stepsDone).toHaveProperty('activate');

    const { op, restarted } = await resume(opId);
    expect(op.status).toBe('succeeded');
    expect(restarted.steps(opId)).toEqual(['store']);
    expect(await rel(A)).toMatchObject({ state: 'active', activationSeq: 3, schemaSnapshot: SCHEMAS[A], stored: true });
    expect(await rel(B)).toMatchObject({ state: 'available' });
  });

  it('resumes a new release over an active one with only the store step', async () => {
    await deploy(A);
    const opId = await interruptedAtStore(B);
    expect((await repo.getOperation(opId))!.stepsDone.plan).toEqual({ reactivate: false });

    const { op, restarted } = await resume(opId);
    expect(op.status).toBe('succeeded');
    expect(restarted.steps(opId)).toEqual(['store']);
    expect(await rel(B)).toMatchObject({ state: 'active', activationSeq: 2, schemaSnapshot: SCHEMAS[B] });
    expect((await rel(B))!.schemaDiff).toEqual(diffSchema(SCHEMAS[A]!, SCHEMAS[B]!));
  });
});

describe('Orchestrator agent failures', () => {
  it('fails with AGENT_ERROR {reason} when the agent port throws a plain error', async () => {
    agent.handlers.pullImages = () => {
      throw new Error('socket hang up');
    };
    const op = await deploy(A);
    expect(op).toMatchObject({ status: 'failed', code: 'AGENT_ERROR', params: expect.objectContaining({ reason: 'socket hang up' }) });
    expect(events.filter((e) => e.opId === op.id).at(-1)?.ev).toEqual({
      type: 'done', status: 'failed', code: 'AGENT_ERROR', message: 'The agent failed: socket hang up',
      params: expect.objectContaining({ reason: 'socket hang up' }),
    });
    expect(await rel(A)).toMatchObject({ state: 'failed' });
  });

  it('keeps the last 8000 characters of a failed expand log in the operation log', async () => {
    const tail = `${'x'.repeat(7990)}END-OF-LOG`;
    agent.handlers.runCommand = (cmd) =>
      cmd.cmd === 'npm run migrate' ? { exitCode: 2, stdout: '', log: `HEAD-OF-LOG${'y'.repeat(5000)}${tail}` } : agent.fallback(cmd);
    const op = await deploy(A);
    expect(op).toMatchObject({ status: 'failed', code: 'MIGRATION_FAILED' });
    expect(op.log).toContain(tail);
    expect(op.log).not.toContain('HEAD-OF-LOG');
  });

  it('sets stored=0 on a reactivated release whose store fails and keeps the deploy succeeded', async () => {
    await deploy(A);
    await deploy(B);
    expect((await rel(A))!.stored).toBe(true);
    agent.handlers.storeImages = () => {
      throw new AgentError('STORAGE_FAILED', { reason: 'disk full' });
    };
    const op = await deploy(A);
    expect(op).toMatchObject({ status: 'succeeded', code: null });
    expect(op.log).toContain('STORAGE_FAILED');
    expect(await rel(A)).toMatchObject({ state: 'active', stored: false });
  });
});

describe('Orchestrator plain-text messages', () => {
  it('answers a rejected deploy with the params unescaped', async () => {
    const res = await request(A, { branch: "fix/o'neil&co" });
    expect(res).toMatchObject({ rejected: { code: 'BRANCH_MISMATCH', message: expect.stringContaining("fix/o'neil&co") } });
  });

  it('emits the done message with the params unescaped', async () => {
    agent.markerFor.worker = { envId: '33333333-3333-4333-8333-333333333333', envName: "qa & o'neil" };
    const op = await deploy(A);
    const done = events.filter((e) => e.opId === op.id).at(-1)!.ev as Extract<OperationEvent, { type: 'done' }>;
    expect(done).toMatchObject({ code: 'DB_MARKER_MISMATCH' });
    expect(done.message).toContain("qa & o'neil");
  });
});

describe('Orchestrator rollback digests', () => {
  it('sends the recorded digest of every service with fetchImages', async () => {
    await deploy(A);
    await deploy(B);
    const relA = (await rel(A))!;
    const op = await rollback(A);
    const fetch = agent.cmds(op.id, 'fetchImages')[0]!;
    expect(fetch.digests).toEqual({ web: relA.images.web!.digest, worker: relA.images.worker!.digest });
    expect(fetch.digests!.web).toMatch(/^sha256:/);
  });
});

describe('Orchestrator runContract', () => {
  it('runs contract_cmd from the digest-pinned release image with MICRORUN_* env and stamps contracted_at', async () => {
    await deploy(A);
    const relA = (await rel(A))!;
    now += 1000;
    await orch.runContract(relA.id);
    const op = (await ops()).find((o) => o.kind === 'contract')!;
    expect(op).toMatchObject({ status: 'succeeded', actor: 'system', toReleaseId: relA.id });
    const cmd = agent.cmds(op.id, 'runCommand')[0]!;
    expect(cmd).toMatchObject({ service: 'web', cmd: 'npm run contract', args: [] });
    expect(cmd.image).toBe(`reg/web:${A}@${relA.images.web!.digest}`);
    expect(cmd.env).toMatchObject({
      MICRORUN_ENV: 'prod', MICRORUN_RELEASE_COMMIT: A, MICRORUN_DEPLOYED_AT: new Date(relA.deployedAt).toISOString(),
    });
    expect(await rel(A)).toMatchObject({ contractedAt: now });
  });

  it('fails with CONTRACT_FAILED and keeps the command log', async () => {
    await deploy(A);
    agent.handlers.runCommand = (cmd) =>
      cmd.cmd === 'npm run contract' ? { exitCode: 3, stdout: '', log: 'contract: column still in use' } : agent.fallback(cmd);
    now += 1000;
    await orch.runContract((await rel(A))!.id);
    const op = (await ops()).find((o) => o.kind === 'contract')!;
    expect(op).toMatchObject({ status: 'failed', code: 'CONTRACT_FAILED' });
    expect(op.log).toContain('contract: column still in use');
    expect(await rel(A)).toMatchObject({ contractedAt: null });
  });
});

describe('Orchestrator approveDestructive', () => {
  it('records the approval as a succeeded approve operation by admin', async () => {
    await deploy(A);
    await deploy(D);
    now += 1000;
    await orch.approveDestructive(envId, D);
    const relD = (await rel(D))!;
    expect((await ops()).filter((o) => o.kind === 'approve')).toEqual([
      expect.objectContaining({ status: 'succeeded', actor: 'admin', toReleaseId: relD.id, params: expect.objectContaining({ commit: D }) }),
    ]);
  });
});

describe('Orchestrator closeWindow', () => {
  it.each([
    ['with', 'npm run contract', A],
    ['without', null, B],
  ])('answers ENV_BUSY %s contract_cmd and expires nothing while the env is busy', async (_, contractCmd, closed) => {
    await setEnv({ contractCmd });
    await deploy(A);
    await deploy(B);
    await repo.createOperation({
      envId, kind: 'deploy', fromReleaseId: null, toReleaseId: null, actor: 'admin', status: 'running', startedAt: now,
    });
    const before = await repo.listReleases(envId);
    await expect(orch.closeWindow((await rel(closed))!.id)).resolves.toMatchObject({ rejected: { code: 'ENV_BUSY' } });
    expect(await repo.listReleases(envId)).toEqual(before);
  });

  it('closes the window without contract_cmd through a succeeded expire operation', async () => {
    await setEnv({ contractCmd: null });
    await deploy(A);
    await deploy(B);
    const res = await orch.closeWindow((await rel(B))!.id);
    if (!('operationId' in res)) throw new Error(res.rejected.code);
    expect(await settle(res.operationId)).toMatchObject({ kind: 'expire', status: 'succeeded', actor: 'admin' });
    expect(await rel(A)).toMatchObject({ state: 'expired' });
    expect(await rel(B)).toMatchObject({ state: 'active' });
  });
});
