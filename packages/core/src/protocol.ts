import { z } from 'zod';
import type { DbKind, SchemaSnapshot } from './schema.ts';

export const PROTOCOL_VERSION = 1;

export const RESULT_CODES = ['ALREADY_ACTIVE','BRANCH_MISMATCH','COMMIT_BLOCKED','COMMIT_EXPIRED','SCHEMA_DESTRUCTIVE_APPROVED',
  'AGENT_OFFLINE','ENV_BUSY','DB_NOT_BOUND','DB_MARKER_MISMATCH','IMAGE_PULL_FAILED','SCHEMA_DESTRUCTIVE','MIGRATION_FAILED',
  'HEALTHCHECK_FAILED','AGENT_LOST','CLEANUP_MISMATCH','CONTRACT_FAILED','STORAGE_FAILED','INVALID_REQUEST','UNAUTHORIZED'] as const;
export type ResultCode = typeof RESULT_CODES[number];

export const REJECT_CODES: ResultCode[] = ['COMMIT_BLOCKED','COMMIT_EXPIRED','BRANCH_MISMATCH','SCHEMA_DESTRUCTIVE','DB_MARKER_MISMATCH','DB_NOT_BOUND','INVALID_REQUEST'];

export class AgentError extends Error {
  code: ResultCode;
  params: Record<string, string | number>;
  constructor(code: ResultCode, params: Record<string, string | number> = {}) {
    super(code);
    this.name = 'AgentError';
    this.code = code;
    this.params = params;
  }
}

export interface ComposeRef { project: string; dir: string; files: string[] }
export interface DbRef { compose: ComposeRef; service: string; dbKind: DbKind; dbUrlEnv: string }
export type ServiceSpec = { name: string; strategy: 'rolling'|'recreate'; image: string; domain?: string; port?: number };
export type StorageConfig =
  | { kind: 'local'; path: string }
  | { kind: 'registry'; registry: string; repository: string; username: string; password: string }
  | { kind: 's3'; endpoint: string; region: string; bucket: string; prefix: string; accessKey: string; secretKey: string; forcePathStyle: boolean };
export type CleanupPreviewLine = { rule: string; description: string; count: number };
export type CleanupApplyLine = { rule: string; deleted: number };

export type Command =
  | { type: 'ping' }
  | { type: 'inspectEnv'; compose: ComposeRef; dbUrlEnv: string }
  | { type: 'readMarker'; db: DbRef; viaService?: string }
  | { type: 'writeMarker'; db: DbRef; envId: string; envName: string }
  | { type: 'pullImages'; refs: string[] }
  | { type: 'snapshotSchema'; db: DbRef }
  | { type: 'dryRunExpand'; db: DbRef; image: string; cmd: string; migrationTables: string[]; opId: string; env: Record<string,string> }
  | { type: 'runCommand'; compose: ComposeRef; service: string; image: string; cmd: string; args: string[]; env: Record<string,string> }
  | { type: 'switchServices'; compose: ComposeRef; services: ServiceSpec[]; healthTimeoutS: number; proxyMode: 'external'|'bundled' }
  | { type: 'storeImages'; storage: StorageConfig; env: string; sha: string; images: Record<string,string> }
  | { type: 'fetchImages'; storage: StorageConfig; env: string; sha: string; images: Record<string,string> }
  | { type: 'deleteImages'; storage: StorageConfig; env: string; sha: string; images: Record<string,string> };

export interface ResultMap {
  ping: { agentVersion: string };
  inspectEnv: { services: { name: string; image: string|null; replicas: number; hasHealthcheck: boolean; containerName: string|null; hostPorts: string[]; hasDbUrl: boolean }[] };
  readMarker: { markers: { service: string; marker: { envId: string; envName: string } | null }[] };
  writeMarker: { envId: string };
  pullImages: { digests: Record<string,string> };
  snapshotSchema: { snapshot: SchemaSnapshot };
  dryRunExpand: { snapshot: SchemaSnapshot; log: string };
  runCommand: { exitCode: number; stdout: string; log: string };
  switchServices: { replaced: string[] };
  storeImages: {}; fetchImages: {}; deleteImages: {};
}

export type CommandOf<T extends Command['type']> = Extract<Command, { type: T }>;

export interface AgentPort {
  call<T extends Command['type']>(serverId: string, key: { opId: string; step: string }, cmd: CommandOf<T>): Promise<ResultMap[T]>;
  isOnline(serverId: string): boolean;
}

const stringMap = z.record(z.string(), z.string());
const params = z.record(z.string(), z.union([z.string(), z.number()]));
const resultCode = z.enum(RESULT_CODES);
const dbKind = z.enum(['postgres', 'mysql', 'sqlite', 'mongodb']);

const composeRef = z.object({ project: z.string(), dir: z.string(), files: z.array(z.string()) });
const dbRef = z.object({ compose: composeRef, service: z.string(), dbKind, dbUrlEnv: z.string() });
const serviceSpec = z.object({
  name: z.string(),
  strategy: z.enum(['rolling', 'recreate']),
  image: z.string(),
  domain: z.string().optional(),
  port: z.number().int().optional(),
});
const storageConfig = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), path: z.string() }),
  z.object({ kind: z.literal('registry'), registry: z.string(), repository: z.string(), username: z.string(), password: z.string() }),
  z.object({
    kind: z.literal('s3'), endpoint: z.string(), region: z.string(), bucket: z.string(), prefix: z.string(),
    accessKey: z.string(), secretKey: z.string(), forcePathStyle: z.boolean(),
  }),
]);
const imagesCommand = { storage: storageConfig, env: z.string(), sha: z.string(), images: stringMap };

export const commandSchema: z.ZodType<Command> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('inspectEnv'), compose: composeRef, dbUrlEnv: z.string() }),
  z.object({ type: z.literal('readMarker'), db: dbRef, viaService: z.string().optional() }),
  z.object({ type: z.literal('writeMarker'), db: dbRef, envId: z.string(), envName: z.string() }),
  z.object({ type: z.literal('pullImages'), refs: z.array(z.string()) }),
  z.object({ type: z.literal('snapshotSchema'), db: dbRef }),
  z.object({
    type: z.literal('dryRunExpand'), db: dbRef, image: z.string(), cmd: z.string(),
    migrationTables: z.array(z.string()), opId: z.string(), env: stringMap,
  }),
  z.object({
    type: z.literal('runCommand'), compose: composeRef, service: z.string(), image: z.string(),
    cmd: z.string(), args: z.array(z.string()), env: stringMap,
  }),
  z.object({
    type: z.literal('switchServices'), compose: composeRef, services: z.array(serviceSpec),
    healthTimeoutS: z.number(), proxyMode: z.enum(['external', 'bundled']),
  }),
  z.object({ type: z.literal('storeImages'), ...imagesCommand }),
  z.object({ type: z.literal('fetchImages'), ...imagesCommand }),
  z.object({ type: z.literal('deleteImages'), ...imagesCommand }),
]);

const opKey = z.object({ opId: z.string(), step: z.string() });

export const wsAgentToServer: z.ZodType<
  | { t: 'hello'; protocolVersion: number; agentVersion: string }
  | { t: 'res'; id: string; ok: true; result: unknown }
  | { t: 'res'; id: string; ok: false; code: ResultCode; params: Record<string,string|number>; message: string }
  | { t: 'pong' }> = z.union([
  z.object({ t: z.literal('hello'), protocolVersion: z.number(), agentVersion: z.string() }),
  z.object({ t: z.literal('res'), id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ t: z.literal('res'), id: z.string(), ok: z.literal(false), code: resultCode, params, message: z.string() }),
  z.object({ t: z.literal('pong') }),
]);

export const wsServerToAgent: z.ZodType<
  | { t: 'req'; id: string; key: { opId: string; step: string }; cmd: Command }
  | { t: 'ping' }
  | { t: 'bye'; code: 'PROTOCOL_MISMATCH'|'UNAUTHORIZED' }> = z.discriminatedUnion('t', [
  z.object({ t: z.literal('req'), id: z.string(), key: opKey, cmd: commandSchema }),
  z.object({ t: z.literal('ping') }),
  z.object({ t: z.literal('bye'), code: z.enum(['PROTOCOL_MISMATCH', 'UNAUTHORIZED']) }),
]);

export const deployRequest: z.ZodType<{ images: Record<string,string>; commit: string; branch: string; author: string; message: string }> = z.object({
  images: stringMap.refine((m) => Object.keys(m).length > 0),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/),
  branch: z.string(),
  author: z.string().max(500),
  message: z.string().max(500),
});

export type DeployAccepted = { operationId: string };
export type ApiError = { code: ResultCode; message: string; params: Record<string,string|number> };
export type OperationEvent = { type: 'step'; step: string; status: 'running'|'done' } | { type: 'log'; line: string }
  | { type: 'done'; status: 'succeeded'|'failed'|'rejected'; code: ResultCode|null; message: string; params: Record<string,string|number> };

const MAX_CLEANUP_LINE = 65536;
const cleanupPreviewLine = z.object({ rule: z.string(), description: z.string(), count: z.number().int() });
const cleanupApplyLine = z.object({ rule: z.string(), deleted: z.number().int() });

export function parseCleanupLines(stdout: string, mode: 'dry-run'|'apply'): { lines: (CleanupPreviewLine|CleanupApplyLine)[]; other: string[] } {
  const shape = mode === 'dry-run' ? cleanupPreviewLine : cleanupApplyLine;
  const lines: (CleanupPreviewLine|CleanupApplyLine)[] = [];
  const other: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    if (raw.length > MAX_CLEANUP_LINE) {
      other.push(raw);
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      other.push(raw);
      continue;
    }
    const parsed = shape.safeParse(value);
    if (parsed.success) lines.push(parsed.data);
    else other.push(raw);
  }
  return { lines, other };
}
