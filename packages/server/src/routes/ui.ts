import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { codePlain, i18n, isLang, webLang, type I18n } from '@microrun/core/i18n';
import { AgentError, type ResultCode, type ResultMap, type StorageConfig } from '@microrun/core/protocol';
import type { DiffEntry } from '@microrun/core/schema';
import { windowLeftMs } from '@microrun/core/state';
import { finished, streamOperation, type AppDeps, type Frame } from '../app.ts';
import { setLangCookie } from '../auth.ts';
import { decrypt, encrypt, hashToken, newToken } from '../crypto.ts';
import { composeRefOf, type Cursor, type EnvRow, type FeedRow, type OperationRow, type ReleaseRow, type ServerRow } from '../db/repo.ts';
import { short, type EnvVM, type ReleaseVM } from '../ui/board.ts';
import { envView, newEnvView } from '../ui/env.ts';
import { alert } from '../ui/form.ts';
import { releaseHistory, type HistoryVM } from '../ui/history.ts';
import { envDot, feedPage, homeView, type FeedRowVM, type HomeVM } from '../ui/home.ts';
import { codeText, html, type Html } from '../ui/html.ts';
import { layout } from '../ui/layout.ts';
import { opProgressView, panelView } from '../ui/panel.ts';
import { envFormView, parseEnvForm, serverBlock, text as field, type EnvFormParsed, type EnvFormValues } from '../ui/settings.ts';
import { statusFor, wire } from './api.ts';

type Body = Record<string, string | string[]>;

const bodyOf = (req: FastifyRequest): Body => (req.body ?? {}) as Body;
const list = (b: Body, k: string) => {
  const v = b[k];
  return (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter(Boolean);
};
const langOf = (req: FastifyRequest) => i18n(webLang(req.cookies.mr_lang));
const LINE_BREAKS = /\r\n|[\r\n]/g;
const oneLine = (h: Html) => h.__html.replace(LINE_BREAKS, ' ');
const OPS_PER_ENV = 200;

function sendHtml(reply: FastifyReply, h: Html | string, status = 200) {
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .send(typeof h === 'string' ? h : h.__html);
}

function rejection(reply: FastifyReply, i: I18n, code: ResultCode, params: Record<string, string | number> = {}) {
  reply.header('HX-Retarget', '#panel-alert').header('HX-Reswap', 'innerHTML');
  return sendHtml(reply, alert({ tone: 'error', role: 'alert', body: codeText(i, code, params) }), statusFor(code));
}

type Started = { operationId: string } | { rejected: { code: ResultCode; params: Record<string, string | number> } };
type EnvFormInput = {
  values: EnvFormValues;
  errors: Record<string, string>;
  isNew: boolean;
  deployToken?: string;
  deleteError?: string;
  storedName?: string;
  bind?: { ok: boolean; text: string };
  rollingHint?: boolean;
};

const page = (req: FastifyRequest, reply: FastifyReply, title: string, body: Html, status = 200) =>
  sendHtml(reply, layout({ i: langOf(req), title, csrf: req.csrfToken, body, q: String((req.query as { q?: unknown }).q ?? '') }), status);

function parseCursor(s: unknown): Cursor | null | 'bad' {
  if (s == null || s === '') return null;
  const match = typeof s === 'string' && /^(\d+)\.([A-Za-z0-9-]+)$/.exec(s);
  if (!match) return 'bad';
  const at = Number(match[1]);
  return Number.isSafeInteger(at) ? { at, id: match[2]! } : 'bad';
}

const cursorOf = (r: { deployedAt: number; id: string }) => `${r.deployedAt}.${r.id}`;

function feedFilters(query: { q?: unknown; only?: unknown }): Pick<HomeVM, 'q' | 'only'> {
  return { q: String(query.q ?? '').trim().toLowerCase().slice(0, 100), only: query.only === 'prod' ? 'prod' : 'all' };
}

const feedRowVM = (r: FeedRow): FeedRowVM => ({
  id: r.id,
  envId: r.envId,
  envName: r.envName,
  isProduction: r.envIsProduction,
  sha: r.commitSha,
  message: r.message,
  author: r.author,
  deployedAt: r.deployedAt,
  state: r.state,
  schemaChange: Array.isArray(r.schemaDiff) && r.schemaDiff.length > 0,
});

function readStorage(d: AppDeps, env: EnvRow): StorageConfig | null {
  try {
    return JSON.parse(decrypt(d.config.secretKey, env.storageConfigEnc)) as StorageConfig;
  } catch {
    return null;
  }
}

const storageTarget = (s: StorageConfig | null) =>
  !s ? '' : s.kind === 'local' ? s.path : s.kind === 'registry' ? `${s.registry}/${s.repository}` : `s3://${s.bucket}/${s.prefix}`;

function failNoteOf(last: OperationRow | undefined): ReleaseVM['failNote'] {
  if (!last || !last.code) return null;
  return last.status === 'failed' || last.status === 'rejected' ? { code: last.code, params: wire(last.params) } : null;
}

function cleanupFailedOf(ops: OperationRow[], r: ReleaseRow): ReleaseVM['cleanupFailed'] {
  const last = ops.find((o) => o.kind === 'cleanup' && o.toReleaseId === r.id);
  if (!last || last.status !== 'failed' || Array.isArray(r.cleanupPreview)) return null;
  return { code: last.code ?? 'INVALID_REQUEST', params: wire(last.params) };
}

function releaseVM(env: EnvRow, r: ReleaseRow, rs: ReleaseRow[], ops: OperationRow[], now: number): ReleaseVM {
  const blocker = ops.find((o) => o.id === r.blockedByOp);
  const blockerSha = rs.find((x) => x.id === blocker?.toReleaseId)?.commitSha ?? '';
  const last = ops.find((o) => o.toReleaseId === r.id && o.kind !== 'cleanup' && finished(o));
  const cleanup = ops.find((o) => o.kind === 'cleanup' && o.toReleaseId === r.id && Array.isArray(o.cleanupResult));
  const retentionMs = env.retentionS * 1000;
  const left = windowLeftMs(r, retentionMs, now);
  return {
    id: r.id,
    sha: r.commitSha,
    message: r.message,
    author: r.author,
    deployedAt: r.deployedAt,
    state: r.state,
    windowLeftMs: left,
    windowPct: left === null || retentionMs <= 0 ? null : (left / retentionMs) * 100,
    diff: Array.isArray(r.schemaDiff) ? (r.schemaDiff as DiffEntry[]) : [],
    blocked: r.blockedAt === null ? null : { at: r.blockedAt, to: blockerSha },
    failNote: failNoteOf(last),
    cleanupState: r.cleanupState,
    cleanupPreview: Array.isArray(r.cleanupPreview) ? (r.cleanupPreview as ReleaseVM['cleanupPreview']) : null,
    cleanupResult: cleanup ? (cleanup.cleanupResult as ReleaseVM['cleanupResult']) : null,
    activationSeq: r.activationSeq,
    imagePurged: r.imagePurgedAt !== null,
    stored: r.stored,
    storing: ops.some((o) => o.toReleaseId === r.id && o.kind !== 'cleanup' && !finished(o)),
    cleanupFailed: cleanupFailedOf(ops, r),
  };
}

async function envVM(d: AppDeps, env: EnvRow, servers: ServerRow[], now: number): Promise<EnvVM> {
  const server = servers.find((s) => s.id === env.serverId);
  const rs = await d.repo.listReleases(env.id);
  const recent = await d.repo.listOperations({ envId: env.id, limit: OPS_PER_ENV });
  const missing = [...new Set(rs.flatMap((r) => (r.blockedByOp && !recent.some((o) => o.id === r.blockedByOp) ? [r.blockedByOp] : [])))];
  const blockers = (await Promise.all(missing.map((id) => d.repo.getOperation(id)))).filter((o): o is OperationRow => !!o);
  const ops = [...recent, ...blockers];
  return {
    id: env.id,
    name: env.name,
    branch: env.branch,
    isProduction: env.isProduction,
    retentionS: env.retentionS,
    agentOnline: d.hub.isOnline(env.serverId),
    serverName: server?.name ?? '',
    builtin: server?.builtin ?? false,
    composeProject: env.composeProject,
    services: env.services.map((s) => ({ name: s.name, strategy: s.strategy })),
    db: `${env.dbKind} · ${env.dbUrlEnv}`,
    storage: { kind: env.storageKind, target: storageTarget(readStorage(d, env)) },
    markerWarnings: d.scheduler.markerWarnings().get(env.id) ?? [],
    releases: rs.map((r) => releaseVM(env, r, rs, ops, now)),
  };
}

async function oneEnvVM(d: AppDeps, env: EnvRow) {
  return envVM(d, env, await d.repo.listServers(), d.clock());
}

async function panelFor(d: AppDeps, req: FastifyRequest, releaseId: string | null): Promise<Html | null> {
  const rel = releaseId ? await d.repo.getRelease(releaseId) : null;
  const env = rel && (await d.repo.getEnv(rel.envId));
  if (!rel || !env) return null;
  const vm = await oneEnvVM(d, env);
  const r = vm.releases.find((x) => x.id === rel.id)!;
  const i = langOf(req);
  return panelView(i, vm, r, req.csrfToken, releaseHistory(i, await historyOf(d, env, rel.id)));
}

function serviceSteps(i: I18n, s: EnvRow['services'][number], switched: boolean): { label: string; done: boolean }[] {
  if (s.strategy !== 'rolling') return [{ label: i.t('step.recreated', { svc: s.name }), done: switched }];
  return [
    { label: i.t('step.healthy', { svc: s.name }), done: switched },
    { label: i.t('step.stopped', { svc: s.name }), done: switched },
  ];
}

async function stepsOf(d: AppDeps, i: I18n, op: OperationRow): Promise<{ label: string; done: boolean }[]> {
  if (op.kind !== 'rollback') return [];
  const env = await d.repo.getEnv(op.envId);
  const rel = op.toReleaseId ? await d.repo.getRelease(op.toReleaseId) : null;
  if (!env || !rel) return [];
  const done = (s: string) => s in (op.stepsDone ?? {});
  return [
    { label: i.t('step.image', { sha: short(rel.commitSha) }), done: done('fetch') },
    ...env.services.flatMap((s) => serviceSteps(i, s, done('switch'))),
    { label: i.t('step.blocked'), done: done('activate') },
  ];
}

const seconds = (op: OperationRow) => Math.max(0, Math.round(((op.finishedAt ?? op.startedAt) - op.startedAt) / 1000));

async function progress(d: AppDeps, i: I18n, op: OperationRow): Promise<Html> {
  const ok = op.kind === 'rollback' && op.status === 'succeeded';
  return opProgressView(i, op.id, await stepsOf(d, i, op), ok ? seconds(op) : null);
}

async function started(d: AppDeps, req: FastifyRequest, reply: FastifyReply, res: Started) {
  const i = langOf(req);
  if ('rejected' in res) return rejection(reply, i, res.rejected.code, res.rejected.params);
  const op = (await d.repo.getOperation(res.operationId))!;
  return sendHtml(reply, await progress(d, i, op));
}

async function panelOr404(d: AppDeps, req: FastifyRequest, reply: FastifyReply, releaseId: string | null) {
  const panel = await panelFor(d, req, releaseId);
  return panel ? sendHtml(reply, panel) : reply.code(404).send();
}

const serverRows = async (d: AppDeps) =>
  (await d.repo.listServers()).map((s) => ({ id: s.id, name: s.name, online: d.hub.isOnline(s.id), builtin: s.builtin, agentVersion: s.agentVersion, proxyMode: s.proxyMode }));

const agentCommand = (d: AppDeps, token: string) =>
  `npm i -g microrun && MICRORUN_AGENT_TOKEN=${token} microrun agent --url ${d.config.publicUrl.href.replace(/\/$/, '')}`;

const isProxyMode = (m: string): m is ServerRow['proxyMode'] => m === 'external' || m === 'bundled';

const noBlock = (reply: FastifyReply) => reply.code(404).header('HX-Reswap', 'none').send();

async function blockFor(
  d: AppDeps,
  req: FastifyRequest,
  selected: string,
  extra: { created?: { name: string; token: string; command: string }; error?: string } = {},
): Promise<Html> {
  const usedBy = (await d.repo.listEnvs()).filter((e) => e.serverId === selected).map((e) => e.name);
  return serverBlock(langOf(req), { servers: await serverRows(d), selected, usedBy, csrf: req.csrfToken, ...extra });
}

async function defaultServer(d: AppDeps): Promise<string> {
  const servers = await d.repo.listServers();
  return (servers.find((s) => s.builtin) ?? servers[0])?.id ?? '';
}

function storageValues(s: StorageConfig | null): EnvFormValues {
  if (!s) return {};
  if (s.kind === 'local') return { storage_path: s.path };
  if (s.kind === 'registry') return { storage_registry: s.registry, storage_repository: s.repository, storage_username: s.username };
  return {
    storage_endpoint: s.endpoint, storage_region: s.region, storage_bucket: s.bucket, storage_prefix: s.prefix,
    storage_access_key: s.accessKey, storage_force_path_style: s.forcePathStyle ? 'on' : '',
  };
}

const serviceLine = (x: EnvRow['services'][number]) =>
  [x.name, x.strategy, ...(x.domain ? [x.domain, String(x.port ?? '')] : [])].join(':');

function toValues(d: AppDeps, env: EnvRow): EnvFormValues {
  const days = env.retentionS % 86_400 === 0;
  return {
    id: env.id,
    name: env.name,
    branch: env.branch,
    is_production: env.isProduction ? 'on' : '',
    server_id: env.serverId,
    position: String(env.position),
    compose_project: env.composeProject,
    compose_dir: env.composeDir,
    compose_files: env.composeFiles.join('\n'),
    compose_env_files: env.composeEnvFiles.join('\n'),
    services: env.services.map(serviceLine).join('\n'),
    migration_service: env.migrationService,
    db_kind: env.dbKind,
    db_url_env: env.dbUrlEnv,
    migration_tables: env.migrationTables.join('\n'),
    expand_cmd: env.expandCmd,
    contract_cmd: env.contractCmd ?? '',
    cleanup_cmd: env.cleanupCmd ?? '',
    schema_check: env.schemaCheck,
    health_timeout_s: String(env.healthTimeoutS),
    storage_kind: env.storageKind,
    ...storageValues(readStorage(d, env)),
    retention_value: String(days ? env.retentionS / 86_400 : env.retentionS / 3600),
    retention_unit: days ? 'days' : 'hours',
  };
}

const bodyValues = (b: Body): EnvFormValues => {
  const out: Record<string, string> = {};
  for (const k of Object.keys(b)) if (k !== '_csrf' && k !== 'storage_password' && k !== 'storage_secret_key') out[k] = field(b, k);
  return out as EnvFormValues;
};

async function settingsHtml(d: AppDeps, req: FastifyRequest, p: EnvFormInput): Promise<Html> {
  const serverBlock = await blockFor(d, req, p.values.server_id || (await defaultServer(d)));
  return envFormView(langOf(req), { ...p, csrf: req.csrfToken, serverBlock });
}

async function envPage(d: AppDeps, req: FastifyRequest, reply: FastifyReply, env: EnvRow, p: EnvFormInput, status = 200) {
  const i = langOf(req);
  const parts = { settings: await settingsHtml(d, req, p) };
  return page(req, reply, env.name, envView(i, await oneEnvVM(d, env), d.clock(), parts), status);
}

async function newEnvPage(d: AppDeps, req: FastifyRequest, reply: FastifyReply, p: EnvFormInput, status = 200) {
  const i = langOf(req);
  return page(req, reply, i.t('settings.env.newTitle'), newEnvView(i, await settingsHtml(d, req, p)), status);
}

type InspectedService = ResultMap['inspectEnv']['services'][number];

function unfitForRolling(s: EnvFormParsed['services'][number], info: InspectedService | undefined, proxyMode: string | undefined): boolean {
  const proxied = proxyMode === 'bundled' && !!s.domain && !!s.port;
  return !info || info.hasHealthcheck === false || info.containerName !== null || (info.hostPorts.length > 0 && !proxied);
}

async function inspect(d: AppDeps, v: EnvFormParsed) {
  try {
    return await d.hub.call<'inspectEnv'>(v.serverId, { opId: randomUUID(), step: 'inspectEnv' }, {
      type: 'inspectEnv',
      compose: composeRefOf(v),
      dbUrlEnv: v.dbUrlEnv,
    });
  } catch (e) {
    if (e instanceof AgentError) return null;
    throw e;
  }
}

async function rollingCheck(d: AppDeps, v: EnvFormParsed): Promise<{ errors: Record<string, string> | null; unknown: boolean }> {
  const rolling = v.services.filter((s) => s.strategy === 'rolling');
  if (!rolling.length || !d.hub.isOnline(v.serverId)) return { errors: null, unknown: false };
  const server = await d.repo.getServer(v.serverId);
  const res = await inspect(d, v);
  if (!res) return { errors: null, unknown: false };
  const infos = rolling.map((s) => ({ s, info: res.services.find((x) => x.name === s.name) }));
  const bad = infos.some(({ s, info }) => unfitForRolling(s, info, server?.proxyMode));
  return { errors: bad ? { services: 'settings.h.services' } : null, unknown: infos.some(({ info }) => info?.hasHealthcheck === null) };
}

async function uniquenessErrors(d: AppDeps, v: EnvFormParsed, id: string | undefined): Promise<Record<string, string> | null> {
  const others = (await d.repo.listEnvs()).filter((e) => e.id !== id);
  const errors: Record<string, string> = {};
  if (others.some((e) => e.name === v.name)) errors.name = 'settings.err.nameTaken';
  if (others.some((e) => e.branch === v.branch)) errors.branch = 'settings.err.branchTaken';
  return Object.keys(errors).length ? errors : null;
}

function keepSecrets(next: StorageConfig, old: StorageConfig | null): StorageConfig {
  if (next.kind === 'registry' && old?.kind === 'registry' && !next.password) return { ...next, password: old.password };
  if (next.kind === 's3' && old?.kind === 's3' && !next.secretKey) return { ...next, secretKey: old.secretKey };
  return next;
}

type RuleCount = { rule: string; count: number };

function cleanupRows(o: OperationRow, rel: ReleaseRow | undefined): HistoryVM['cleanup'] {
  if (o.kind !== 'cleanup' || !Array.isArray(o.cleanupResult)) return undefined;
  const preview = Array.isArray(rel?.cleanupPreview) ? (rel.cleanupPreview as RuleCount[]) : [];
  return (o.cleanupResult as { rule: string; deleted: number }[]).map((x) => ({
    rule: x.rule,
    expected: preview.find((p) => p.rule === x.rule)?.count ?? 0,
    deleted: x.deleted,
  }));
}

function historyRow(o: OperationRow, rels: Map<string, ReleaseRow>): HistoryVM {
  const sha = (id: string | null) => (id && rels.get(id)?.commitSha) || '—';
  return {
    at: o.startedAt,
    kind: o.kind,
    from: sha(o.fromReleaseId),
    to: sha(o.toReleaseId),
    actor: o.actor,
    status: o.status === 'succeeded' ? 'ok' : o.status,
    durationS: o.finishedAt === null ? null : seconds(o),
    reason: o.code && (o.status !== 'succeeded' || o.code === 'CLEANUP_MISMATCH') ? { code: o.code, params: wire(o.params) } : null,
    cleanup: cleanupRows(o, o.toReleaseId ? rels.get(o.toReleaseId) : undefined),
  };
}

async function historyOf(d: AppDeps, env: EnvRow, releaseId: string): Promise<HistoryVM[]> {
  const rels = new Map((await d.repo.listReleases(env.id)).map((r) => [r.id, r]));
  const ops = await d.repo.listOperations({ envId: env.id, limit: OPS_PER_ENV });
  return ops.filter((o) => finished(o) && (o.toReleaseId === releaseId || o.fromReleaseId === releaseId)).map((o) => historyRow(o, rels));
}

export function registerUi(app: FastifyInstance, d: AppDeps): void {
  const { repo, orchestrator, config, clock } = d;

  app.addHook('preHandler', app.requireAdmin);

  async function loadFeed(filters: Pick<HomeVM, 'q' | 'only'>, before: Cursor | null) {
    const { rows, rest } = await repo.listRecentReleases({ q: filters.q, productionOnly: filters.only === 'prod', before, limit: 25 });
    const last = rows.at(-1);
    return { ...filters, feed: rows.map(feedRowVM), rest, next: last ? cursorOf(last) : null };
  }

  app.get<{ Querystring: { q?: unknown; only?: unknown } }>('/', async (req, reply) => {
    const i = langOf(req);
    const filters = feedFilters(req.query);
    const { q } = filters;
    const [envs, servers, statuses, operations, feed, shaHits] = await Promise.all([
      repo.listEnvs(), repo.listServers(), repo.envStatuses(), repo.activeOperations(), loadFeed(filters, null),
      q ? repo.envIdsWithShaPrefix(q) : new Set<string>(),
    ]);
    const busy = new Set(operations.map((o) => o.envId));
    const online = new Set(servers.filter((s) => d.hub.isOnline(s.id)).map((s) => s.id));
    const warnings = d.scheduler.markerWarnings();
    const index = envs.filter((e) => e.name.toLowerCase().includes(q) || e.branch.toLowerCase().includes(q) || shaHits.has(e.id))
      .map(({ id, name, isProduction, serverId }) => {
        const { latest, active, lastOp } = statuses.get(id) ?? {};
        const dot = envDot({
          mismatch: (warnings.get(id) ?? []).length > 0,
          online: online.has(serverId),
          busy: busy.has(id),
          latest: latest?.state ?? null,
          activeUnstored: active?.stored === false,
          contractFailed: lastOp?.code === 'CONTRACT_FAILED' && lastOp.toReleaseId === active?.id,
        });
        return { id, name, isProduction, dot };
      });
    if (req.headers['hx-target'] === 'home') reply.header('HX-Reswap', 'outerHTML');
    return page(req, reply, i.t('nav.envs'), homeView(i, { ...feed, envs: index }, clock()));
  });

  app.get<{ Querystring: { q?: unknown; only?: unknown; before?: unknown } }>('/feed', async (req, reply) => {
    const before = parseCursor(req.query.before);
    if (before === 'bad') return reply.code(400).send();
    return sendHtml(reply, feedPage(langOf(req), await loadFeed(feedFilters(req.query), before), clock()));
  });

  app.get('/env/new', async (req, reply) => newEnvPage(d, req, reply, { values: {}, errors: {}, isNew: true }));

  app.get<{ Params: { id: string } }>('/env/:id', async (req, reply) => {
    const env = await repo.getEnv(req.params.id);
    if (!env) return reply.code(404).send();
    return envPage(d, req, reply, env, { values: toValues(d, env), errors: {}, isNew: false });
  });

  app.get<{ Params: { releaseId: string } }>('/panel/:releaseId', async (req, reply) => panelOr404(d, req, reply, req.params.releaseId));

  app.post('/rollback', async (req, reply) => {
    const b = bodyOf(req);
    const i = langOf(req);
    const env = await repo.getEnv(field(b, 'envId'));
    if (!env) return rejection(reply, i, 'INVALID_REQUEST');
    if (env.isProduction && field(b, 'confirm') !== 'yes') return rejection(reply, i, 'INVALID_REQUEST', { env: env.name });
    return started(d, req, reply, await orchestrator.requestRollback(env.id, field(b, 'releaseId')));
  });

  app.get<{ Params: { id: string } }>('/ops/:id/events', async (req, reply) => {
    const op = await repo.getOperation(req.params.id);
    if (!op) return reply.code(404).send();
    const i = langOf(req);
    const done = async (cur: OperationRow): Promise<Frame> => {
      const ok = cur.kind === 'rollback' && cur.status === 'succeeded';
      const panel = ok ? await progress(d, i, cur) : ((await panelFor(d, req, cur.toReleaseId)) ?? (await progress(d, i, cur)));
      return ['done', oneLine(panel)];
    };
    const steps = async (cur: OperationRow): Promise<Frame> => {
      const view = await progress(d, i, cur);
      const inner = /<ul class="steps" id="steps">([\s\S]*?)<\/ul>/.exec(view.__html)?.[1] ?? '';
      return ['steps', inner.replace(LINE_BREAKS, ' ')];
    };
    await streamOperation(reply, d, op.id, async (cur, ev) => {
      if (ev === null) return [finished(cur) ? await done(cur) : await steps(cur)];
      if (ev.type === 'done') return [await done(cur)];
      return ev.type === 'step' ? [await steps(cur)] : [];
    });
  });

  app.post('/cleanup/preview', async (req, reply) => started(d, req, reply, await orchestrator.requestCleanupPreview(field(bodyOf(req), 'releaseId'))));

  app.post('/cleanup/apply', async (req, reply) => {
    const b = bodyOf(req);
    return started(d, req, reply, await orchestrator.requestCleanupApply(field(b, 'releaseId'), list(b, 'rules')));
  });

  app.post('/cleanup/dismiss', async (req, reply) => {
    const id = field(bodyOf(req), 'releaseId');
    await orchestrator.dismissCleanup(id);
    return panelOr404(d, req, reply, id);
  });

  app.post('/approve', async (req, reply) => {
    const b = bodyOf(req);
    const i = langOf(req);
    const env = await repo.getEnv(field(b, 'envId'));
    if (!env) return rejection(reply, i, 'INVALID_REQUEST', {});
    if (env.isProduction && field(b, 'confirm') !== 'yes') return rejection(reply, i, 'INVALID_REQUEST', { env: env.name });
    const sha = field(b, 'commitSha');
    try {
      await orchestrator.approveDestructive(env.id, sha);
    } catch {
      return rejection(reply, i, 'INVALID_REQUEST', { env: env.name });
    }
    const rel = (await repo.listReleases(env.id)).find((r) => r.commitSha === sha)!;
    return panelOr404(d, req, reply, rel.id);
  });

  app.post('/contract/retry', async (req, reply) => {
    const b = bodyOf(req);
    const rel = await repo.getRelease(field(b, 'releaseId'));
    const envId = rel?.envId ?? field(b, 'envId');
    return started(d, req, reply, await orchestrator.retryContract(envId));
  });

  app.post('/lang', async (req, reply) => {
    const lang = field(bodyOf(req), 'lang');
    if (isLang(lang)) {
      setLangCookie(reply, lang, config.secureCookies);
    }
    let back = '/';
    try {
      const ref = new URL(req.headers.referer ?? '');
      if (ref.host === req.headers.host) back = `${ref.pathname}${ref.search}`;
    } catch {}
    return reply.redirect(back, 303);
  });

  app.get<{ Querystring: { server_id?: string } }>('/settings/servers/block', async (req, reply) => {
    const server = await repo.getServer(req.query.server_id ?? '');
    if (!server) return noBlock(reply);
    return sendHtml(reply, await blockFor(d, req, server.id));
  });

  app.post('/settings/servers', async (req, reply) => {
    const b = bodyOf(req);
    const name = field(b, 'server_name');
    const i = langOf(req);
    const picked = field(b, 'server_id');
    const keep = async () => ((await repo.getServer(picked)) ? picked : await defaultServer(d));
    if (!name) return sendHtml(reply, await blockFor(d, req, await keep(), { error: i.t('settings.err.required') }), 422);
    if ((await repo.listServers()).some((s) => s.name === name)) {
      return sendHtml(reply, await blockFor(d, req, await keep(), { error: i.t('settings.err.serverTaken') }), 422);
    }
    const token = newToken();
    const server = await repo.createServer({ name, agentTokenHash: hashToken(token), builtin: false });
    const proxy = field(b, 'proxy_mode');
    if (isProxyMode(proxy)) await repo.updateServer(server.id, { proxyMode: proxy });
    return sendHtml(reply, await blockFor(d, req, server.id, { created: { name, token, command: agentCommand(d, token) } }));
  });

  app.post<{ Params: { id: string } }>('/settings/servers/:id/token', async (req, reply) => {
    const server = await repo.getServer(req.params.id);
    if (!server || server.builtin) return noBlock(reply);
    const token = newToken();
    await repo.updateServer(server.id, { agentTokenHash: hashToken(token) });
    d.hub.disconnect(server.id);
    return sendHtml(reply, await blockFor(d, req, server.id, { created: { name: server.name, token, command: agentCommand(d, token) } }));
  });

  app.post<{ Params: { id: string } }>('/settings/servers/:id/proxy', async (req, reply) => {
    const server = await repo.getServer(req.params.id);
    if (!server) return noBlock(reply);
    const mode = field(bodyOf(req), 'proxy_mode');
    if (isProxyMode(mode)) await repo.updateServer(server.id, { proxyMode: mode });
    return sendHtml(reply, await blockFor(d, req, server.id));
  });

  app.post<{ Params: { id: string } }>('/settings/servers/:id/delete', async (req, reply) => {
    const server = await repo.getServer(req.params.id);
    if (!server) return noBlock(reply);
    const i = langOf(req);
    const refuse = async (error: string, status: number) => sendHtml(reply, await blockFor(d, req, server.id, { error }), status);
    if (field(bodyOf(req), 'confirm_name') !== server.name) return refuse(i.text('settings.confirmName', { name: server.name }), 400);
    const res = await repo.deleteServer(server.id);
    if (res === 'missing') return noBlock(reply);
    if (res === 'builtin') return refuse(i.text('settings.servers.deleteBuiltin'), 409);
    if (res === 'has-envs') {
      const n = await repo.countEnvsOnServer(server.id);
      return refuse(i.text('settings.servers.deleteHasEnvs', { name: server.name, n }), 409);
    }
    d.hub.disconnect(server.id);
    return sendHtml(reply, await blockFor(d, req, await defaultServer(d)));
  });

  app.post<{ Params: { id: string } }>('/settings/env/:id/delete', async (req, reply) => {
    const env = await repo.getEnv(req.params.id);
    if (!env) return reply.code(404).send();
    const i = langOf(req);
    const again = (deleteError: string, status: number) =>
      envPage(d, req, reply, env, { values: toValues(d, env), errors: {}, isNew: false, deleteError }, status);
    if (field(bodyOf(req), 'confirm_name') !== env.name) return again(i.text('settings.confirmName', { name: env.name }), 400);
    const res = await repo.deleteEnv(env.id);
    if (res === 'missing') return reply.code(404).send();
    if (res === 'busy') return again(i.text('settings.env.deleteBusy', { name: env.name }), 409);
    return reply.redirect('/', 303);
  });

  app.post('/settings/env', async (req, reply) => {
    const b = bodyOf(req);
    const id = field(b, 'id');
    const existing = id ? await repo.getEnv(id) : null;
    if (id && !existing) return reply.code(404).send();
    const values = bodyValues(b);
    const rejected = (errors: Record<string, string>) =>
      existing
        ? envPage(d, req, reply, existing, { values, errors, isNew: false, storedName: existing.name }, 422)
        : newEnvPage(d, req, reply, { values, errors, isNew: true }, 422);
    const parsed = parseEnvForm(b);
    if (!parsed.ok) return rejected(parsed.errors);
    const taken = await uniquenessErrors(d, parsed.value, existing?.id);
    if (taken) return rejected(taken);
    const rolling = await rollingCheck(d, parsed.value);
    if (rolling.errors) return rejected(rolling.errors);
    const { storageConfig, ...rest } = parsed.value;
    const storage = keepSecrets(storageConfig, existing ? readStorage(d, existing) : null);
    const token = existing ? undefined : newToken();
    const saved = await repo.saveEnv({
      ...rest,
      storageConfigEnc: encrypt(config.secretKey, JSON.stringify(storage)),
      deployTokenHash: existing ? existing.deployTokenHash : hashToken(token!),
      ...(existing ? { id: existing.id } : {}),
    });
    return envPage(d, req, reply, saved, { values: toValues(d, saved), errors: {}, isNew: false, deployToken: token, rollingHint: rolling.unknown });
  });

  app.post<{ Params: { id: string } }>('/settings/env/:id/bind', async (req, reply) => {
    const env = await repo.getEnv(req.params.id);
    if (!env) return reply.code(404).send();
    const i = langOf(req);
    const res = await orchestrator.bindDatabase(env.id);
    const text = res.ok
      ? `${i.text('settings.env.bind')}: ${i.text('common.yes')}`
      : codePlain(i, res.code, { env: env.name, svc: env.migrationService, ...res.params });
    const fresh = (await repo.getEnv(env.id))!;
    return envPage(d, req, reply, fresh, { values: toValues(d, fresh), errors: {}, isNew: false, bind: { ok: res.ok, text } });
  });

  app.post<{ Params: { id: string } }>('/settings/env/:id/token', async (req, reply) => {
    const env = await repo.getEnv(req.params.id);
    if (!env) return reply.code(404).send();
    const token = newToken();
    await repo.saveEnv({ ...env, deployTokenHash: hashToken(token) });
    return envPage(d, req, reply, env, { values: toValues(d, env), errors: {}, isNew: false, deployToken: token });
  });
}
