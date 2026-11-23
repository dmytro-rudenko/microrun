import { randomUUID } from 'node:crypto';
import {
  decideDeploy,
  nextContract,
  onDeploySuccess,
  onDestructiveApproved,
  onRollbackSuccess,
  planRollback,
} from '@microrun/core/state';
import type { DeployDecision, ReleaseFacts } from '@microrun/core/state';
import { diffSchema, isDestructive, sameDestructive } from '@microrun/core/schema';
import type { DiffEntry, SchemaSnapshot } from '@microrun/core/schema';
import { AgentError, REJECT_CODES, parseCleanupLines } from '@microrun/core/protocol';
import type {
  AgentPort,
  ApiError,
  CleanupApplyLine,
  CleanupPreviewLine,
  Command,
  CommandOf,
  ComposeRef,
  DbRef,
  OperationEvent,
  ResultCode,
  ResultMap,
  ServiceSpec,
  StorageConfig,
} from '@microrun/core/protocol';
import { codePlain, i18n } from '@microrun/core/i18n';
import { BusyError, composeRefOf as compose } from './db/repo.ts';
import type { EnvRow, OperationRow, OperationStatus, ReleaseRow, Repo } from './db/repo.ts';

export interface OrchestratorDeps {
  repo: Repo;
  agent: AgentPort;
  clock: () => number;
  decryptStorage: (env: EnvRow) => StorageConfig;
  emit: (opId: string, ev: OperationEvent) => void;
}

export type DeployRequestParsed = { images: Record<string, string>; commit: string; branch: string; author: string; message: string };

type Params = Record<string, string | number>;
type Accepted = { operationId: string } | { rejected: ApiError };
type Images = ReleaseRow['images'];
type Step = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

class Stop extends Error {
  constructor(
    readonly code: ResultCode,
    readonly params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

const en = i18n('en');
const message = (code: ResultCode, params: Params) => codePlain(en, code, params);
const rejected = (code: ResultCode, params: Params = {}): { rejected: ApiError } => ({
  rejected: { code, message: message(code, params), params },
});
const wire = (p: Record<string, unknown> | null): Params =>
  Object.fromEntries(Object.entries(p ?? {}).filter((e): e is [string, string | number] => typeof e[1] === 'string' || typeof e[1] === 'number'));
const iso = (ts: number) => new Date(ts).toISOString();
const sha7 = (sha: string) => sha.slice(0, 7);
const imageOf = (i: { ref: string; digest: string }) => (!i.digest ? i.ref : i.digest.includes('@') ? i.digest : `${i.ref}@${i.digest}`);
const refs = (images: Images) => Object.fromEntries(Object.entries(images).map(([s, i]) => [s, i.ref]));
const dbRef = (env: EnvRow, service: string): DbRef => ({ compose: compose(env), service, dbKind: env.dbKind, dbUrlEnv: env.dbUrlEnv });
const drops = (d: DiffEntry[]) => d.filter((e) => e.kind === 'drop');
const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const LOG_TAIL = 8000;

function ownSchema(env: EnvRow, s: SchemaSnapshot): SchemaSnapshot {
  const skip = new Set(env.migrationTables);
  return s.kind === 'sql'
    ? { ...s, tables: s.tables.filter((t) => !skip.has(t.name)) }
    : { ...s, collections: s.collections.filter((c) => !skip.has(c.name)) };
}

function serviceImages(env: EnvRow, given: Record<string, string>): Record<string, string> | null {
  const names = env.services.map((s) => s.name);
  const keys = Object.keys(given);
  if (keys.length === 1 && keys[0] === '*') return Object.fromEntries(names.map((n) => [n, given['*']!]));
  if (keys.length === names.length && names.every((n) => n in given)) return given;
  return null;
}

function applyPatches(rs: ReleaseFacts[], ps: { id: string; patch: Partial<ReleaseFacts> }[]): ReleaseFacts[] {
  return rs.map((r) => ps.filter((p) => p.id === r.id).reduce((acc, p) => ({ ...acc, ...p.patch }), r));
}

export class Orchestrator {
  constructor(private readonly d: OrchestratorDeps) {}

  private get repo() {
    return this.d.repo;
  }

  private now() {
    return this.d.clock();
  }

  private async call<T extends Command['type']>(env: EnvRow, opId: string, step: string, cmd: CommandOf<T>): Promise<ResultMap[T]> {
    try {
      return await this.d.agent.call(env.serverId, { opId, step }, cmd);
    } catch (e) {
      throw e instanceof AgentError ? e : new AgentError('AGENT_ERROR', { reason: reasonOf(e) });
    }
  }

  private async snapshot(env: EnvRow, opId: string, step: string): Promise<{ snapshot: SchemaSnapshot }> {
    const res = await this.call(env, opId, step, { type: 'snapshotSchema', db: dbRef(env, env.migrationService) });
    return { snapshot: ownSchema(env, res.snapshot) };
  }

  private async commandFailed(opId: string, res: ResultMap['runCommand'], code: ResultCode): Promise<Stop> {
    if (res.log) await this.log(opId, res.log.slice(-LOG_TAIL));
    return new Stop(code, { exitCode: res.exitCode });
  }

  private start(opId: string) {
    void this.run(opId);
  }

  async requestDeploy(env: EnvRow, req: DeployRequestParsed): Promise<Accepted> {
    const base = { sha: sha7(req.commit), env: env.name };
    if (req.branch !== env.branch) return rejected('BRANCH_MISMATCH', { ...base, branch: req.branch, expected: env.branch });
    const images = serviceImages(env, req.images);
    if (!images) return rejected('INVALID_REQUEST', base);
    if (!env.dbMarkerId) return rejected('DB_NOT_BOUND', base);

    const rs = await this.repo.listReleases(env.id);
    const decision = decideDeploy(rs, req.commit);
    if (decision.kind === 'reject') {
      const r = rs.find((x) => x.id === decision.releaseId)!;
      return rejected(decision.code, decision.code === 'COMMIT_BLOCKED' ? { ...base, at: r.blockedAt ?? 0 } : base);
    }
    const now = this.now();
    const active = rs.find((r) => r.state === 'active') ?? null;
    const actor = `ci:${req.author}`;
    if (decision.kind === 'already_active') return this.alreadyActive(env, decision.releaseId, actor, base, now);
    if (!this.d.agent.isOnline(env.serverId)) return rejected('AGENT_OFFLINE', base);

    try {
      const opId = await this.createDeploy(env, req, decision, images, { activeId: active?.id ?? null, actor, base, now });
      this.start(opId);
      return { operationId: opId };
    } catch (e) {
      if (e instanceof BusyError) return rejected('ENV_BUSY', base);
      throw e;
    }
  }

  private async alreadyActive(env: EnvRow, releaseId: string, actor: string, base: Params, now: number): Promise<Accepted> {
    const op = await this.repo.createOperation({
      envId: env.id, kind: 'deploy', fromReleaseId: releaseId, toReleaseId: releaseId,
      actor, status: 'succeeded', code: 'ALREADY_ACTIVE', params: base, startedAt: now,
    });
    await this.repo.updateOperation(op.id, { finishedAt: now });
    this.d.emit(op.id, { type: 'done', status: 'succeeded', code: 'ALREADY_ACTIVE', message: message('ALREADY_ACTIVE', base), params: base });
    return { operationId: op.id };
  }

  private async createDeploy(
    env: EnvRow,
    req: DeployRequestParsed,
    decision: Exclude<DeployDecision, { kind: 'reject' } | { kind: 'already_active' }>,
    images: Record<string, string>,
    o: { activeId: string | null; actor: string; base: Params; now: number },
  ): Promise<string> {
    const { actor, base, now } = o;
    const releaseImages: Images = Object.fromEntries(Object.entries(images).map(([s, ref]) => [s, { ref, digest: '' }]));
    return this.repo.tx(async (r) => {
      const op = await r.createOperation({
        envId: env.id, kind: 'deploy', fromReleaseId: o.activeId, toReleaseId: null,
        actor, status: 'pending', params: base, startedAt: now,
      });
      let releaseId: string;
      if (decision.kind === 'new') {
        releaseId = (await r.insertRelease({
          envId: env.id, commitSha: req.commit, images: releaseImages, author: req.author, message: req.message,
          deployedAt: now, schemaSnapshot: {}, schemaDiff: [], state: 'failed', stored: false,
        })).id;
      } else {
        releaseId = decision.releaseId;
        if (decision.kind === 'redeploy') {
          await r.patchReleases([{
            id: releaseId,
            patch: { images: releaseImages, author: req.author, message: req.message, deployedAt: now, destructiveApproved: false, stored: false },
          }]);
        }
      }
      await r.updateOperation(op.id, { toReleaseId: releaseId });
      return op.id;
    });
  }

  async requestRollback(envId: string, targetReleaseId: string): Promise<Accepted> {
    const env = await this.repo.getEnv(envId);
    if (!env) return rejected('INVALID_REQUEST');
    const rs = await this.repo.listReleases(env.id);
    const target = rs.find((r) => r.id === targetReleaseId);
    const base = { env: env.name, sha: sha7(target?.commitSha ?? '') };
    if (!target || 'error' in planRollback(rs, targetReleaseId)) return rejected('INVALID_REQUEST', base);
    if (!this.d.agent.isOnline(env.serverId)) return rejected('AGENT_OFFLINE', base);
    const active = rs.find((r) => r.state === 'active') ?? null;
    return this.create(env, {
      kind: 'rollback', fromReleaseId: active?.id ?? null, toReleaseId: target.id, actor: 'admin', params: base,
    });
  }

  async requestCleanupPreview(releaseId: string): Promise<Accepted> {
    return this.requestCleanup(releaseId, { mode: 'dry-run' });
  }

  async requestCleanupApply(releaseId: string, rules: string[]): Promise<Accepted> {
    if (!rules.length) return rejected('INVALID_REQUEST');
    return this.requestCleanup(releaseId, { mode: 'apply', rules: rules.join(',') });
  }

  private async requestCleanup(releaseId: string, mode: Record<string, string>): Promise<Accepted> {
    const rel = await this.repo.getRelease(releaseId);
    const env = rel && (await this.repo.getEnv(rel.envId));
    if (!rel || !env || !env.cleanupCmd || rel.state !== 'blocked' || rel.imagePurgedAt !== null || rel.cleanupState !== 'pending') {
      return rejected('INVALID_REQUEST');
    }
    const base = { env: env.name, sha: sha7(rel.commitSha) };
    if (!this.d.agent.isOnline(env.serverId)) return rejected('AGENT_OFFLINE', base);
    return this.create(env, { kind: 'cleanup', fromReleaseId: null, toReleaseId: rel.id, actor: 'admin', params: { ...base, ...mode } });
  }

  private async create(
    env: EnvRow,
    o: { kind: OperationRow['kind']; fromReleaseId: string | null; toReleaseId: string | null; actor: string; params: Params },
  ): Promise<Accepted> {
    try {
      const op = await this.repo.createOperation({ envId: env.id, status: 'pending', startedAt: this.now(), ...o });
      this.start(op.id);
      return { operationId: op.id };
    } catch (e) {
      if (e instanceof BusyError) return rejected('ENV_BUSY', { env: env.name });
      throw e;
    }
  }

  async dismissCleanup(releaseId: string): Promise<void> {
    const rel = await this.repo.getRelease(releaseId);
    if (rel?.cleanupState === 'pending') await this.repo.patchReleases([{ id: rel.id, patch: { cleanupState: 'dismissed' } }]);
  }

  async approveDestructive(envId: string, commitSha: string): Promise<void> {
    const env = await this.repo.getEnv(envId);
    if (!env) throw new Error(`no env ${envId}`);
    const rs = await this.repo.listReleases(envId);
    const rel = rs.find((r) => r.commitSha === commitSha);
    if (!rel) throw new Error(`no release ${commitSha} in env ${envId}`);
    const ops = await this.repo.listOperations({ envId, limit: 1000 });
    const op = ops.find((o) => o.kind === 'deploy' && o.status === 'rejected' && o.code === 'SCHEMA_DESTRUCTIVE' && o.toReleaseId === rel.id);
    if (!op) throw new Error(`no SCHEMA_DESTRUCTIVE rejection for ${commitSha}`);
    const diff = drops((op.params?.diff as DiffEntry[] | undefined) ?? []);
    const now = this.now();
    await this.repo.tx(async (r) => {
      await r.putApproval({ envId, commitSha, diff, approvedAt: now });
      const approve = await r.createOperation({
        envId, kind: 'approve', fromReleaseId: null, toReleaseId: rel.id, actor: 'admin', status: 'succeeded',
        params: { env: env.name, sha: sha7(commitSha), commit: commitSha }, startedAt: now,
      });
      await r.updateOperation(approve.id, { finishedAt: now });
    });
  }

  async runContract(releaseId: string): Promise<void> {
    const rel = await this.repo.getRelease(releaseId);
    const env = rel && (await this.repo.getEnv(rel.envId));
    if (!rel || !env?.contractCmd) throw new Error(`no contract to run for release ${releaseId}`);
    const op = await this.repo.createOperation({
      envId: env.id, kind: 'contract', fromReleaseId: rel.id, toReleaseId: rel.id, actor: 'system', status: 'pending',
      params: { env: env.name, sha: sha7(rel.commitSha) }, startedAt: this.now(),
    });
    await this.run(op.id);
  }

  async retryContract(envId: string): Promise<Accepted> {
    const env = await this.repo.getEnv(envId);
    if (!env) return rejected('INVALID_REQUEST');
    const id = nextContract(await this.repo.listReleases(env.id));
    const rel = id ? await this.repo.getRelease(id) : null;
    if (!env.contractCmd || !rel) return rejected('INVALID_REQUEST', { env: env.name });
    const base = { env: env.name, sha: sha7(rel.commitSha) };
    if (!this.d.agent.isOnline(env.serverId)) return rejected('AGENT_OFFLINE', base);
    return this.create(env, { kind: 'contract', fromReleaseId: rel.id, toReleaseId: rel.id, actor: 'admin', params: base });
  }

  async bindDatabase(envId: string): Promise<{ ok: true } | { ok: false; code: ResultCode; params: Params }> {
    const env = await this.repo.getEnv(envId);
    if (!env) return { ok: false, code: 'INVALID_REQUEST', params: {} };
    if (!this.d.agent.isOnline(env.serverId)) return { ok: false, code: 'AGENT_OFFLINE', params: { env: env.name } };
    const opId = randomUUID();
    const db = dbRef(env, env.migrationService);
    try {
      const res = await this.call(env, opId, 'readMarker', { type: 'readMarker', db });
      const marker = (res.markers.find((m) => m.service === env.migrationService) ?? res.markers[0])?.marker ?? null;
      if (marker) {
        if (marker.envId === env.dbMarkerId) return { ok: true };
        if (await this.repo.findEnvByMarker(marker.envId)) return { ok: false, code: 'DB_MARKER_MISMATCH', params: { other: marker.envName } };
      }
      const markerId = randomUUID();
      await this.call(env, opId, 'writeMarker', { type: 'writeMarker', db, envId: markerId, envName: env.name });
      await this.repo.setEnvMarker(env.id, markerId);
      return { ok: true };
    } catch (e) {
      if (e instanceof AgentError) return { ok: false, code: e.code, params: e.params };
      throw e;
    }
  }

  async resumeAll(): Promise<void> {
    for (const op of await this.repo.activeOperations()) this.start(op.id);
  }

  async run(opId: string): Promise<void> {
    const op = await this.repo.getOperation(opId);
    if (!op || (op.status !== 'pending' && op.status !== 'running')) return;
    try {
      if (op.status === 'pending') await this.repo.updateOperation(op.id, { status: 'running' });
      const env = (await this.repo.getEnv(op.envId))!;
      if (op.kind === 'deploy') await this.runDeploy(op, env);
      else if (op.kind === 'rollback') await this.runRollback(op, env);
      else if (op.kind === 'cleanup') await this.runCleanup(op, env);
      else if (op.kind === 'contract') await this.executeContract(op, env);
      else await this.finish(op, 'succeeded', null, {});
    } catch (e) {
      await this.fail(op, e);
    }
  }

  private async fail(op: OperationRow, e: unknown): Promise<void> {
    if (e instanceof Stop || e instanceof AgentError) {
      const status: OperationStatus = REJECT_CODES.includes(e.code) ? 'rejected' : 'failed';
      await this.finish(op, status, e.code, e.params);
      return;
    }
    await this.log(op.id, e instanceof Error ? e.message : String(e));
    await this.finish(op, 'failed', null, {});
  }

  private async finish(op: OperationRow, status: 'succeeded' | 'failed' | 'rejected', code: ResultCode | null, extra: Record<string, unknown>) {
    const params = { ...(op.params ?? {}), ...extra };
    await this.repo.updateOperation(op.id, { status, code, params, finishedAt: this.now() });
    const p = wire(params);
    this.d.emit(op.id, { type: 'done', status, code, message: code ? message(code, p) : '', params: p });
  }

  private async log(opId: string, line: string) {
    await this.repo.appendLog(opId, line);
    this.d.emit(opId, { type: 'log', line });
  }

  private stepper(op: OperationRow) {
    const done: Record<string, unknown> = { ...op.stepsDone };
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      if (name in done) return done[name] as T;
      this.d.emit(op.id, { type: 'step', step: name, status: 'running' });
      const res = await fn();
      await this.repo.markStepDone(op.id, name, res);
      done[name] = res ?? null;
      this.d.emit(op.id, { type: 'step', step: name, status: 'done' });
      return res;
    };
    const once = async (name: string, fn: (r: Repo) => Promise<void>) => {
      if (name in done) return;
      this.d.emit(op.id, { type: 'step', step: name, status: 'running' });
      await this.repo.tx(async (r) => {
        await fn(r);
        await r.markStepDone(op.id, name, null);
      });
      done[name] = null;
      this.d.emit(op.id, { type: 'step', step: name, status: 'done' });
    };
    return { step, once };
  }

  private async services(env: EnvRow, images: Images): Promise<{ services: ServiceSpec[]; proxyMode: 'external' | 'bundled' }> {
    const server = await this.repo.getServer(env.serverId);
    const services = env.services.map((s) => {
      const spec: ServiceSpec = { name: s.name, strategy: s.strategy, image: imageOf(images[s.name]!) };
      if (s.domain !== undefined) spec.domain = s.domain;
      if (s.port !== undefined) spec.port = s.port;
      return spec;
    });
    return { services, proxyMode: server?.proxyMode ?? 'external' };
  }

  private releaseEnv(env: EnvRow, rel: ReleaseRow): Record<string, string> {
    return { MICRORUN_ENV: env.name, MICRORUN_RELEASE_COMMIT: rel.commitSha, MICRORUN_DEPLOYED_AT: iso(rel.deployedAt) };
  }

  private async runDeploy(op: OperationRow, env: EnvRow): Promise<void> {
    const { step, once } = this.stepper(op);
    let rel = (await this.repo.getRelease(op.toReleaseId!))!;
    const activated = 'activate' in op.stepsDone;
    const plan = (op.stepsDone.plan as { reactivate: boolean } | undefined) ?? { reactivate: rel.state === 'available' };
    if (!('plan' in op.stepsDone)) await this.repo.markStepDone(op.id, 'plan', plan);
    if (plan.reactivate && rel.stored) await this.fetchRelease(op, env, rel, step);

    const pulled = await step('pull', async () =>
      this.call(env, op.id, 'pull', { type: 'pullImages', refs: [...new Set(Object.values(rel.images).map((i) => i.ref))] }),
    );
    const images: Images = Object.fromEntries(
      Object.entries(rel.images).map(([s, i]) => [s, { ref: i.ref, digest: pulled.digests[i.ref] ?? i.digest }]),
    );
    await this.repo.patchReleases([{ id: rel.id, patch: { images } }]);

    await step('markers', async () => this.checkMarkers(op, env));

    if (!activated) {
      const approved = plan.reactivate ? false : await this.migrate(op, env, rel, images, step);

      const { services, proxyMode } = await this.services(env, images);
      await step('switch', async () =>
        this.call(env, op.id, 'switch', { type: 'switchServices', compose: compose(env), services, healthTimeoutS: env.healthTimeoutS, proxyMode }),
      );

      await once('activate', async (r) => {
        const rs = await r.listReleases(env.id);
        const patches: { id: string; patch: Partial<ReleaseRow> }[] = onDeploySuccess(rs, rel.id, this.now());
        if (approved) {
          patches.push({ id: rel.id, patch: { destructiveApproved: true } });
          const expire = onDestructiveApproved(applyPatches(rs, patches));
          patches.push(...expire.map((id) => ({ id, patch: { state: 'expired' as const } })));
        }
        await r.patchReleases(patches);
      });
    }

    rel = (await this.repo.getRelease(rel.id))!;
    await step('store', async () => this.storeRelease(op, env, rel, images));

    await this.finish(op, 'succeeded', null, {});
  }

  private async migrate(op: OperationRow, env: EnvRow, rel: ReleaseRow, images: Images, step: Step): Promise<boolean> {
    const db = dbRef(env, env.migrationService);
    const migImage = imageOf(images[env.migrationService]!);
    const migEnv = this.releaseEnv(env, rel);
    const active = (await this.repo.listReleases(env.id)).find((r) => r.state === 'active' && r.id !== rel.id);
    const base: SchemaSnapshot = active && !('baseline' in op.stepsDone)
      ? (active.schemaSnapshot as SchemaSnapshot)
      : (await step('baseline', async () => this.snapshot(env, op.id, 'baseline'))).snapshot;

    let approved = false;
    if (env.schemaCheck === 'dry_run') {
      const dry = await step('dryRun', async () =>
        this.call(env, op.id, 'dryRun', {
          type: 'dryRunExpand', db, image: migImage, cmd: env.expandCmd, migrationTables: env.migrationTables, opId: op.id, env: migEnv,
        }),
      );
      approved = await this.gate(op, env, rel.commitSha, diffSchema(base, dry.snapshot));
    }

    await step('expand', async () => {
      const res = await this.call(env, op.id, 'expand', {
        type: 'runCommand', compose: compose(env), service: env.migrationService, image: migImage, cmd: env.expandCmd, args: [], env: migEnv,
      });
      if (res.exitCode !== 0) throw await this.commandFailed(op.id, res, 'MIGRATION_FAILED');
      return { exitCode: res.exitCode };
    });

    const after = (await step('snapshot', async () => this.snapshot(env, op.id, 'snapshot'))).snapshot;
    const diff = diffSchema(base, after);
    await this.repo.patchReleases([{ id: rel.id, patch: { schemaSnapshot: after, schemaDiff: diff } }]);
    if (env.schemaCheck === 'post_check') approved = await this.gate(op, env, rel.commitSha, diff);
    return approved;
  }

  private async gate(op: OperationRow, env: EnvRow, sha: string, diff: DiffEntry[]): Promise<boolean> {
    if (!isDestructive(diff)) return false;
    const approval = await this.repo.getApproval(env.id, sha);
    const usable = approval && (approval.usedByOp === null || approval.usedByOp === op.id)
      && sameDestructive(approval.diff as DiffEntry[], diff);
    const objects = [...new Set(drops(diff).map((e) => e.object))].join(', ');
    if (!usable || !approval) throw new Stop('SCHEMA_DESTRUCTIVE', { objects, col: objects, diff });
    if (approval.usedByOp === null) {
      await this.repo.useApproval(env.id, sha, op.id);
      await this.log(op.id, `SCHEMA_DESTRUCTIVE_APPROVED: ${objects}`);
    }
    return true;
  }

  private fetchCmd(env: EnvRow, r: ReleaseRow): CommandOf<'fetchImages'> {
    return {
      type: 'fetchImages', storage: this.d.decryptStorage(env), env: env.name, sha: r.commitSha, images: refs(r.images),
      digests: Object.fromEntries(Object.entries(r.images).filter(([, i]) => i.digest).map(([s, i]) => [s, i.digest])),
    };
  }

  private async fetchRelease(op: OperationRow, env: EnvRow, rel: ReleaseRow, step: Step): Promise<void> {
    try {
      await step('fetch', async () => this.call(env, op.id, 'fetch', this.fetchCmd(env, rel)));
    } catch (e) {
      if (e instanceof AgentError) await this.logStorageFailed(op.id, e);
      throw e;
    }
    await this.repo.patchReleases([{ id: rel.id, patch: { imageUnpinnedAt: null } }]);
  }

  private async logStorageFailed(opId: string, e: unknown): Promise<void> {
    const params = e instanceof AgentError ? e.params : {};
    const detail = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ');
    await this.log(opId, `STORAGE_FAILED: ${message('STORAGE_FAILED', params)}${detail ? ` (${detail})` : ''}`);
  }

  private async storeRelease(op: OperationRow, env: EnvRow, rel: ReleaseRow, images: Images): Promise<{ stored: boolean }> {
    try {
      await this.call(env, op.id, 'store', {
        type: 'storeImages', storage: this.d.decryptStorage(env), env: env.name, sha: rel.commitSha, images: refs(images),
      });
      await this.repo.patchReleases([{ id: rel.id, patch: { stored: true } }]);
      return { stored: true };
    } catch (e) {
      await this.logStorageFailed(op.id, e);
      await this.repo.patchReleases([{ id: rel.id, patch: { stored: false } }]);
      return { stored: false };
    }
  }

  private async checkMarkers(op: OperationRow, env: EnvRow) {
    const found: { service: string; marker: { envId: string; envName: string } | null }[] = [];
    for (const s of env.services) {
      const res = await this.call(env, op.id, `markers:${s.name}`, { type: 'readMarker', db: dbRef(env, s.name) });
      found.push(...res.markers);
    }
    const bad = found.find((m) => m.marker && m.marker.envId !== env.dbMarkerId);
    if (bad) throw new Stop('DB_MARKER_MISMATCH', { svc: bad.service, other: bad.marker!.envName });
    return found;
  }

  private async runRollback(op: OperationRow, env: EnvRow): Promise<void> {
    const { step, once } = this.stepper(op);
    const target = (await this.repo.getRelease(op.toReleaseId!))!;
    await step('markers', async () => this.checkMarkers(op, env));
    await this.fetchRelease(op, env, target, step);
    const { services, proxyMode } = await this.services(env, target.images);
    await step('switch', async () =>
      this.call(env, op.id, 'switch', {
        type: 'switchServices', compose: compose(env), services, healthTimeoutS: Math.min(env.healthTimeoutS, 45), proxyMode,
      }),
    );
    await once('activate', async (r) => {
      const rs = await r.listReleases(env.id);
      const patches: { id: string; patch: Partial<ReleaseRow> }[] = onRollbackSuccess(rs, target.id, this.now()).map((p) =>
        p.patch.state === 'blocked' ? { id: p.id, patch: { ...p.patch, blockedByOp: op.id } } : p,
      );
      await r.patchReleases(patches);
    });
    await this.finish(op, 'succeeded', null, {});
    await this.previewBlocked(op, env);
  }

  private async previewBlocked(op: OperationRow, env: EnvRow): Promise<void> {
    const blocked = (await this.repo.listReleases(env.id))
      .filter((r) => r.blockedByOp === op.id && r.hasCleanupCmd && r.cleanupState === 'pending')
      .sort((a, b) => (b.activationSeq ?? 0) - (a.activationSeq ?? 0));
    for (const rel of blocked) {
      try {
        const preview = await this.repo.createOperation({
          envId: env.id, kind: 'cleanup', fromReleaseId: null, toReleaseId: rel.id, actor: 'system', status: 'pending',
          startedAt: this.now(), params: { env: env.name, sha: sha7(rel.commitSha), mode: 'dry-run' },
        });
        await this.run(preview.id);
      } catch (e) {
        const reason = e instanceof BusyError ? 'ENV_BUSY' : e instanceof Error ? e.message : String(e);
        await this.log(op.id, `cleanup preview of ${sha7(rel.commitSha)} skipped: ${reason}`);
      }
    }
  }

  private async runCleanup(op: OperationRow, env: EnvRow): Promise<void> {
    const { step } = this.stepper(op);
    const rel = (await this.repo.getRelease(op.toReleaseId!))!;
    const apply = op.params?.mode === 'apply';
    const rules = apply ? String(op.params?.rules ?? '').split(',') : [];
    const args = apply ? ['--apply', `--rules=${rules.join(',')}`] : ['--dry-run'];
    const name = apply ? 'apply' : 'preview';
    if (rel.stored) await this.fetchRelease(op, env, rel, step);
    const res = await step(name, async () => {
      const out = await this.call(env, op.id, name, {
        type: 'runCommand', compose: compose(env), service: env.migrationService, image: imageOf(rel.images[env.migrationService]!),
        cmd: env.cleanupCmd!, args, env: { ...this.releaseEnv(env, rel), MICRORUN_ROLLED_BACK_AT: iso(rel.blockedAt ?? 0) },
      });
      if (out.exitCode !== 0) throw await this.commandFailed(op.id, out, 'MIGRATION_FAILED');
      return out;
    });
    const parsed = parseCleanupLines(res.stdout, apply ? 'apply' : 'dry-run');
    for (const line of parsed.other) await this.log(op.id, line);

    if (!apply) {
      await this.repo.patchReleases([{ id: rel.id, patch: { cleanupPreview: parsed.lines } }]);
      await this.finish(op, 'succeeded', null, {});
      return;
    }
    await this.finishApply(op, rel, rules, parsed.lines as CleanupApplyLine[]);
  }

  private async finishApply(op: OperationRow, rel: ReleaseRow, rules: string[], deleted: CleanupApplyLine[]): Promise<void> {
    const preview = (rel.cleanupPreview as CleanupPreviewLine[] | null) ?? [];
    const rows = rules.map((rule) => ({
      rule,
      expected: preview.find((p) => p.rule === rule)?.count ?? 0,
      deleted: deleted.find((d) => d.rule === rule)?.deleted ?? 0,
    }));
    for (const r of rows) await this.log(op.id, `${r.rule}: expected ${r.expected}, deleted ${r.deleted}`);
    await this.repo.updateOperation(op.id, { cleanupResult: rows });
    await this.repo.patchReleases([{ id: rel.id, patch: { cleanupState: 'applied' } }]);
    const expected = rows.reduce((n, r) => n + r.expected, 0);
    const total = rows.reduce((n, r) => n + r.deleted, 0);
    if (rows.some((r) => r.expected !== r.deleted)) {
      await this.log(op.id, `CLEANUP_MISMATCH: expected ${expected}, deleted ${total}`);
      await this.finish(op, 'succeeded', 'CLEANUP_MISMATCH', { expected, deleted: total });
      return;
    }
    await this.finish(op, 'succeeded', null, {});
  }

  private async executeContract(op: OperationRow, env: EnvRow): Promise<void> {
    const { step } = this.stepper(op);
    const rel = (await this.repo.getRelease(op.toReleaseId!))!;
    try {
      if (rel.stored) await this.fetchRelease(op, env, rel, step);
      await step('contract', async () => {
        const out = await this.call(env, op.id, 'contract', {
          type: 'runCommand', compose: compose(env), service: env.migrationService, image: imageOf(rel.images[env.migrationService]!),
          cmd: env.contractCmd!, args: [], env: this.releaseEnv(env, rel),
        });
        if (out.exitCode !== 0) throw await this.commandFailed(op.id, out, 'CONTRACT_FAILED');
        return { exitCode: out.exitCode };
      });
    } catch (e) {
      if (e instanceof AgentError) throw new Stop('CONTRACT_FAILED', e.params);
      throw e;
    }
    await this.repo.patchReleases([{ id: rel.id, patch: { contractedAt: this.now() } }]);
    await this.finish(op, 'succeeded', null, {});
  }
}
