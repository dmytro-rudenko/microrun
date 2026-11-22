import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import type { CleanupState, ReleaseFacts, ReleasePatch, ReleaseState } from '@microrun/core/state';
import type { ComposeRef } from '@microrun/core/protocol';

export class BusyError extends Error {}

export interface ServerRow {
  id: string;
  name: string;
  agentTokenHash: string;
  builtin: boolean;
  proxyMode: 'external' | 'bundled';
  lastSeenAt: number | null;
  agentVersion: string | null;
}

export interface ServiceSpec {
  name: string;
  strategy: 'rolling' | 'recreate';
  domain?: string;
  port?: number;
}

export interface EnvInput {
  name: string;
  branch: string;
  isProduction: boolean;
  position: number;
  serverId: string;
  composeProject: string;
  composeDir: string;
  composeFiles: string[];
  composeEnvFiles: string[];
  services: ServiceSpec[];
  migrationService: string;
  dbKind: 'postgres' | 'mysql' | 'sqlite' | 'mongodb';
  dbUrlEnv: string;
  migrationTables: string[];
  expandCmd: string;
  contractCmd: string | null;
  cleanupCmd: string | null;
  schemaCheck: 'dry_run' | 'post_check';
  healthTimeoutS: number;
  storageKind: 'local' | 'registry' | 's3';
  storageConfigEnc: Buffer;
  retentionS: number;
  deployTokenHash: string;
}

type ComposeFields = Pick<EnvInput, 'composeProject' | 'composeDir' | 'composeFiles' | 'composeEnvFiles'>;
export const composeRefOf = (e: ComposeFields): ComposeRef =>
  ({ project: e.composeProject, dir: e.composeDir, files: e.composeFiles, envFiles: e.composeEnvFiles });

export interface EnvRow extends EnvInput {
  id: string;
  dbMarkerId: string | null;
}

export interface ReleaseRow extends ReleaseFacts {
  envId: string;
  images: Record<string, { ref: string; digest: string }>;
  author: string;
  message: string;
  schemaSnapshot: unknown;
  schemaDiff: unknown;
  destructiveApproved: boolean;
  cleanupPreview: unknown;
  stored: boolean;
  blockedByOp: string | null;
}

export interface NewRelease {
  id?: string;
  envId: string;
  commitSha: string;
  images: ReleaseRow['images'];
  author: string;
  message: string;
  deployedAt: number;
  schemaSnapshot: unknown;
  schemaDiff: unknown;
  state: ReleaseState;
  stored: boolean;
  supersededAt?: number | null;
  activationSeq?: number | null;
  destructiveApproved?: boolean;
  cleanupState?: CleanupState;
  cleanupPreview?: unknown;
}

export type OperationKind = 'deploy' | 'rollback' | 'cleanup' | 'contract' | 'expire' | 'approve';
export type OperationStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'rejected';

export interface OperationRow {
  id: string;
  envId: string;
  kind: OperationKind;
  fromReleaseId: string | null;
  toReleaseId: string | null;
  actor: string;
  status: OperationStatus;
  code: string | null;
  params: Record<string, unknown> | null;
  log: string;
  stepsDone: Record<string, unknown>;
  cleanupResult: unknown;
  startedAt: number;
  finishedAt: number | null;
}

export interface NewOperation {
  id?: string;
  envId: string;
  kind: OperationKind;
  fromReleaseId: string | null;
  toReleaseId: string | null;
  actor: string;
  status: OperationStatus;
  startedAt: number;
  code?: string | null;
  params?: Record<string, unknown> | null;
}

export interface ApprovalRow {
  envId: string;
  commitSha: string;
  diff: unknown;
  approvedAt: number;
  usedByOp: string | null;
}

interface Shape {
  json: string[];
  bool: string[];
}

const SERVER: Shape = { json: [], bool: ['builtin'] };
const ENV: Shape = { json: ['composeFiles', 'composeEnvFiles', 'services', 'migrationTables'], bool: ['isProduction'] };
const RELEASE: Shape = {
  json: ['images', 'schemaSnapshot', 'schemaDiff', 'cleanupPreview'],
  bool: ['destructiveApproved', 'stored', 'hasCleanupCmd'],
};
const OPERATION: Shape = { json: ['params', 'stepsDone', 'cleanupResult'], bool: [] };
const APPROVAL: Shape = { json: ['diff'], bool: [] };

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function toDb(obj: object, s: Shape, skip: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || skip.includes(k)) continue;
    if (s.json.includes(k)) out[snake(k)] = v === null ? null : JSON.stringify(v);
    else if (s.bool.includes(k)) out[snake(k)] = v ? 1 : 0;
    else out[snake(k)] = v;
  }
  return out;
}

function fromDb<T>(row: Record<string, unknown>, s: Shape): T {
  const out: Record<string, unknown> = {};
  for (const [col, v] of Object.entries(row)) {
    const k = camel(col);
    if (s.json.includes(k)) out[k] = v === null ? null : JSON.parse(v as string);
    else if (s.bool.includes(k)) out[k] = Boolean(v);
    else out[k] = v;
  }
  return out as T;
}

async function firstOf<T>(q: Knex.QueryBuilder, s: Shape): Promise<T | null> {
  const r = await q.first();
  return r ? fromDb<T>(r, s) : null;
}

async function allOf<T>(q: Knex.QueryBuilder, s: Shape): Promise<T[]> {
  const rows: Record<string, unknown>[] = await q;
  return rows.map((r) => fromDb<T>(r, s));
}

function isBusy(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed: operations\.env_id/.test(e.message);
}

export class Repo {
  constructor(private readonly db: Knex) {}

  tx<T>(fn: (r: Repo) => Promise<T>): Promise<T> {
    return this.db.transaction((trx) => fn(new Repo(trx)));
  }

  async createServer(s: { name: string; agentTokenHash: string; builtin: boolean }): Promise<ServerRow> {
    const id = randomUUID();
    await this.db('servers').insert(toDb({ id, ...s }, SERVER));
    return (await this.getServer(id))!;
  }

  async listServers(): Promise<ServerRow[]> {
    return allOf<ServerRow>(this.db('servers').select().orderBy('name'), SERVER);
  }

  async serverByTokenHash(h: string): Promise<ServerRow | null> {
    return firstOf<ServerRow>(this.db('servers').where({ agent_token_hash: h }), SERVER);
  }

  async getServer(id: string): Promise<ServerRow | null> {
    return firstOf<ServerRow>(this.db('servers').where({ id }), SERVER);
  }

  async setServerSeen(id: string, at: number, version: string): Promise<void> {
    await this.db('servers').where({ id }).update({ last_seen_at: at, agent_version: version });
  }

  async updateServer(id: string, p: Partial<Pick<ServerRow, 'agentTokenHash' | 'proxyMode'>>): Promise<void> {
    const data = toDb(p, SERVER);
    if (Object.keys(data).length) await this.db('servers').where({ id }).update(data);
  }

  async saveEnv(e: EnvInput & { id?: string }): Promise<EnvRow> {
    const { id, ...rest } = e;
    if (id) {
      await this.db('environments').where({ id }).update(toDb(rest, ENV, ['dbMarkerId']));
      return (await this.getEnv(id))!;
    }
    const newId = randomUUID();
    await this.db('environments').insert(toDb({ id: newId, ...rest }, ENV, ['dbMarkerId']));
    return (await this.getEnv(newId))!;
  }

  async listEnvs(): Promise<EnvRow[]> {
    return allOf<EnvRow>(this.db('environments').select().orderBy(['position', 'name']), ENV);
  }

  async getEnv(id: string): Promise<EnvRow | null> {
    return firstOf<EnvRow>(this.db('environments').where({ id }), ENV);
  }

  async envByDeployTokenHash(h: string): Promise<EnvRow | null> {
    return firstOf<EnvRow>(this.db('environments').where({ deploy_token_hash: h }), ENV);
  }

  async setEnvMarker(id: string, markerId: string): Promise<void> {
    await this.db('environments').where({ id }).update({ db_marker_id: markerId });
  }

  private releases() {
    return this.db('releases as r')
      .join('environments as e', 'e.id', 'r.env_id')
      .select('r.*', this.db.raw('e.cleanup_cmd is not null as has_cleanup_cmd'));
  }

  async listReleases(envId: string): Promise<ReleaseRow[]> {
    return allOf<ReleaseRow>(this.releases().where('r.env_id', envId).orderBy('r.deployed_at', 'desc'), RELEASE);
  }

  async getRelease(id: string): Promise<ReleaseRow | null> {
    return firstOf<ReleaseRow>(this.releases().where('r.id', id), RELEASE);
  }

  async insertRelease(r: NewRelease): Promise<ReleaseRow> {
    const id = r.id ?? randomUUID();
    await this.db('releases').insert(toDb({ ...r, id }, RELEASE));
    return (await this.getRelease(id))!;
  }

  async patchReleases(ps: ReleasePatch[] | { id: string; patch: Partial<ReleaseRow> }[]): Promise<void> {
    await this.tx(async (r) => {
      for (const p of ps) {
        const data = toDb(p.patch, RELEASE, ['id', 'envId', 'hasCleanupCmd']);
        if (Object.keys(data).length) await r.db('releases').where({ id: p.id }).update(data);
      }
    });
  }

  async createOperation(o: NewOperation): Promise<OperationRow> {
    const id = o.id ?? randomUUID();
    try {
      await this.db('operations').insert(toDb({ ...o, id, log: '', stepsDone: {} }, OPERATION));
    } catch (e) {
      if (isBusy(e)) throw new BusyError(`operation already running for env ${o.envId}`);
      throw e;
    }
    return (await this.getOperation(id))!;
  }

  async getOperation(id: string): Promise<OperationRow | null> {
    return firstOf<OperationRow>(this.db('operations').where({ id }), OPERATION);
  }

  async activeOperations(): Promise<OperationRow[]> {
    return allOf<OperationRow>(this.db('operations').whereIn('status', ['pending', 'running']).orderBy('started_at'), OPERATION);
  }

  async updateOperation(id: string, p: Partial<OperationRow>): Promise<void> {
    const data = toDb(p, OPERATION, ['id']);
    if (!Object.keys(data).length) return;
    try {
      await this.db('operations').where({ id }).update(data);
    } catch (e) {
      if (isBusy(e)) throw new BusyError(`operation already running for env`);
      throw e;
    }
  }

  async appendLog(id: string, line: string): Promise<void> {
    await this.db('operations')
      .where({ id })
      .update({ log: this.db.raw('log || ?', [`${line}\n`]) });
  }

  async markStepDone(id: string, step: string, result: unknown): Promise<void> {
    await this.tx(async (r) => {
      const op = await r.getOperation(id);
      if (!op) throw new Error(`operation ${id} not found`);
      await r.db('operations')
        .where({ id })
        .update({ steps_done: JSON.stringify({ ...op.stepsDone, [step]: result ?? null }) });
    });
  }

  async listOperations(f: { envId?: string; limit: number }): Promise<OperationRow[]> {
    const q = this.db('operations').select().orderBy('started_at', 'desc').limit(f.limit);
    if (f.envId) q.where({ env_id: f.envId });
    return allOf<OperationRow>(q, OPERATION);
  }

  async putApproval(a: { envId: string; commitSha: string; diff: unknown; approvedAt: number }): Promise<void> {
    const row = toDb(a, APPROVAL);
    await this.db('destructive_approvals')
      .insert(row)
      .onConflict(['env_id', 'commit_sha'])
      .merge({ diff: row.diff, approved_at: row.approved_at, used_by_op: null });
  }

  async getApproval(envId: string, sha: string): Promise<ApprovalRow | null> {
    return firstOf<ApprovalRow>(this.db('destructive_approvals').where({ env_id: envId, commit_sha: sha }), APPROVAL);
  }

  async useApproval(envId: string, sha: string, opId: string): Promise<void> {
    await this.db('destructive_approvals').where({ env_id: envId, commit_sha: sha }).update({ used_by_op: opId });
  }

  async createSession(id: string, now: number, ttlMs: number): Promise<void> {
    await this.db('sessions').insert({ id, created_at: now, expires_at: now + ttlMs });
  }

  async getSession(id: string, now: number): Promise<boolean> {
    const r = await this.db('sessions').where({ id }).andWhere('expires_at', '>', now).first();
    return Boolean(r);
  }

  async deleteSession(id: string): Promise<void> {
    await this.db('sessions').where({ id }).delete();
  }
}
