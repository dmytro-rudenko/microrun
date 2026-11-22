import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { i18n, isLang, negotiate, type I18n } from '@microrun/core/i18n';
import { AgentError, type ResultCode, type ResultMap, type StorageConfig } from '@microrun/core/protocol';
import type { DiffEntry } from '@microrun/core/schema';
import { windowLeftMs } from '@microrun/core/state';
import { finished, streamOperation, type AppDeps, type Frame } from '../app.ts';
import { decrypt, encrypt, hashToken, newToken } from '../crypto.ts';
import type { EnvRow, OperationRow, ReleaseRow, ServerRow } from '../db/repo.ts';
import { boardView, short, type EnvVM, type ReleaseVM } from '../ui/board.ts';
import { envView } from '../ui/env.ts';
import { historyView, type HistoryVM } from '../ui/history.ts';
import { codeText, html, type Html } from '../ui/html.ts';
import { layout } from '../ui/layout.ts';
import { opProgressView, panelView } from '../ui/panel.ts';
import { envFormView, parseEnvForm, serversView, text as field, type EnvFormParsed, type EnvFormValues } from '../ui/settings.ts';
import { statusFor, wire } from './api.ts';

type Body = Record<string, string | string[]>;

const YEAR_S = 365 * 24 * 60 * 60;

const bodyOf = (req: FastifyRequest): Body => (req.body ?? {}) as Body;
const list = (b: Body, k: string) => {
  const v = b[k];
  return (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter(Boolean);
};
const langOf = (req: FastifyRequest) => i18n(negotiate(req.cookies.mr_lang, req.headers['accept-language']));
const oneLine = (h: Html) => h.__html.replace(/\r?\n/g, ' ');

function sendHtml(reply: FastifyReply, h: Html | string, status = 200) {
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .send(typeof h === 'string' ? h : h.__html);
}

function rejection(reply: FastifyReply, i: I18n, code: ResultCode, params: Record<string, string | number> = {}) {
  return sendHtml(reply, html`<div class="alert" role="alert">${codeText(i, code, params)}</div>`, statusFor(code));
}

type Started = { operationId: string } | { rejected: { code: ResultCode; params: Record<string, string | number> } };
type EnvFormInput = { values: EnvFormValues; errors: Record<string, string>; isNew: boolean; deployToken?: string; bind?: { ok: boolean; text: string } };

const page = (req: FastifyRequest, reply: FastifyReply, title: string, active: 'envs' | 'history' | 'settings', body: Html, status = 200) =>
  sendHtml(reply, layout({ i: langOf(req), title, active, csrf: req.csrfToken, body }), status);

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
  };
}

async function envVM(d: AppDeps, env: EnvRow, servers: ServerRow[], now: number): Promise<EnvVM> {
  const server = servers.find((s) => s.id === env.serverId);
  const rs = await d.repo.listReleases(env.id);
  const ops = await d.repo.listOperations({ envId: env.id, limit: 1000 });
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
  return panelView(langOf(req), vm, r, req.csrfToken, d.clock());
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
  `npm i -g microrun && microrun agent --url ${d.config.publicUrl.href.replace(/\/$/, '')} --token ${token}`;

async function serversPage(d: AppDeps, req: FastifyRequest, reply: FastifyReply, created?: { name: string; token: string; command: string }) {
  const i = langOf(req);
  return page(req, reply, i.t('settings.servers.title'), 'settings', serversView(i, await serverRows(d), req.csrfToken, created));
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

async function envForm(d: AppDeps, req: FastifyRequest, reply: FastifyReply, p: EnvFormInput, status = 200) {
  const i = langOf(req);
  const servers = (await d.repo.listServers()).map((s) => ({ id: s.id, name: s.name }));
  const title = i.t(p.isNew ? 'settings.env.newTitle' : 'settings.env.editTitle');
  return page(req, reply, title, 'settings', envFormView(i, { ...p, servers, csrf: req.csrfToken }), status);
}

type InspectedService = ResultMap['inspectEnv']['services'][number];

function unfitForRolling(s: EnvFormParsed['services'][number], info: InspectedService | undefined, proxyMode: string | undefined): boolean {
  const proxied = proxyMode === 'bundled' && !!s.domain && !!s.port;
  return !info || !info.hasHealthcheck || info.containerName !== null || (info.hostPorts.length > 0 && !proxied);
}

async function inspect(d: AppDeps, v: EnvFormParsed) {
  try {
    return await d.hub.call<'inspectEnv'>(v.serverId, { opId: randomUUID(), step: 'inspectEnv' }, {
      type: 'inspectEnv',
      compose: { project: v.composeProject, dir: v.composeDir, files: v.composeFiles },
      dbUrlEnv: v.dbUrlEnv,
    });
  } catch (e) {
    if (e instanceof AgentError) return null;
    throw e;
  }
}

async function rollingErrors(d: AppDeps, v: EnvFormParsed): Promise<Record<string, string> | null> {
  const rolling = v.services.filter((s) => s.strategy === 'rolling');
  if (!rolling.length || !d.hub.isOnline(v.serverId)) return null;
  const server = await d.repo.getServer(v.serverId);
  const res = await inspect(d, v);
  if (!res) return null;
  const bad = rolling.some((s) => unfitForRolling(s, res.services.find((x) => x.name === s.name), server?.proxyMode));
  return bad ? { services: 'settings.h.services' } : null;
}

function keepSecrets(next: StorageConfig, old: StorageConfig | null): StorageConfig {
  if (next.kind === 'registry' && old?.kind === 'registry' && !next.password) return { ...next, password: old.password };
  if (next.kind === 's3' && old?.kind === 's3' && !next.secretKey) return { ...next, secretKey: old.secretKey };
  return next;
}

function historyRow(o: OperationRow, envs: EnvRow[], shas: Map<string, string>): HistoryVM[] {
  const env = envs.find((e) => e.id === o.envId);
  if (!env) return [];
  const sha = (id: string | null) => (id && shas.get(id)) || '—';
  return [{
    at: o.startedAt,
    env: env.name,
    isProduction: env.isProduction,
    kind: o.kind,
    from: sha(o.fromReleaseId),
    to: sha(o.toReleaseId),
    actor: o.actor,
    status: o.status === 'succeeded' ? 'ok' : o.status,
    durationS: o.finishedAt === null ? null : seconds(o),
    reason: o.code && o.status !== 'succeeded' ? { code: o.code, params: wire(o.params) } : null,
  }];
}

export function registerUi(app: FastifyInstance, d: AppDeps): void {
  const { repo, orchestrator, config, clock } = d;

  app.addHook('preHandler', app.requireAdmin);

  app.get('/', async (req, reply) => {
    const i = langOf(req);
    const servers = await repo.listServers();
    const now = clock();
    const envs = await Promise.all((await repo.listEnvs()).map((e) => envVM(d, e, servers, now)));
    return page(req, reply, i.t('nav.envs'), 'envs', boardView(i, envs, now));
  });

  app.get<{ Params: { id: string } }>('/env/:id', async (req, reply) => {
    const env = await repo.getEnv(req.params.id);
    if (!env) return reply.code(404).send();
    return page(req, reply, env.name, 'envs', envView(langOf(req), await oneEnvVM(d, env), clock()));
  });

  app.get<{ Querystring: { env?: string } }>('/history', async (req, reply) => {
    const i = langOf(req);
    const filter = req.query.env ?? '';
    const envs = await repo.listEnvs();
    const ops = await repo.listOperations({ envId: filter && filter !== 'all' ? filter : undefined, limit: 200 });
    const shas = new Map<string, string>();
    for (const e of envs) for (const r of await repo.listReleases(e.id)) shas.set(r.id, r.commitSha);
    const rows = ops.filter(finished).flatMap((o) => historyRow(o, envs, shas));
    return page(req, reply, i.t('nav.history'), 'history', historyView(i, rows, envs.map((e) => ({ id: e.id, name: e.name })), filter));
  });

  app.get<{ Params: { releaseId: string } }>('/panel/:releaseId', async (req, reply) => panelOr404(d, req, reply, req.params.releaseId));

  app.post('/rollback', async (req, reply) => {
    const b = bodyOf(req);
    const i = langOf(req);
    const env = await repo.getEnv(field(b, 'envId'));
    if (!env) return rejection(reply, i, 'INVALID_REQUEST');
    if (env.isProduction && field(b, 'confirm') !== env.name) return rejection(reply, i, 'INVALID_REQUEST', { env: env.name });
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
      return ['steps', inner.replace(/\r?\n/g, ' ')];
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
    if (!env || field(b, 'confirm') !== env.name) return rejection(reply, i, 'INVALID_REQUEST', env ? { env: env.name } : {});
    const sha = field(b, 'commitSha');
    try {
      await orchestrator.approveDestructive(env.id, sha);
    } catch {
      return rejection(reply, i, 'INVALID_REQUEST', { env: env.name });
    }
    const rel = (await repo.listReleases(env.id)).find((r) => r.commitSha === sha)!;
    return panelOr404(d, req, reply, rel.id);
  });

  app.post('/close-window', async (req, reply) => {
    const id = field(bodyOf(req), 'releaseId');
    if (!(await repo.getRelease(id))) return rejection(reply, langOf(req), 'INVALID_REQUEST');
    await orchestrator.closeWindow(id);
    return panelOr404(d, req, reply, id);
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
      reply.setCookie('mr_lang', lang, { path: '/', maxAge: YEAR_S, sameSite: 'lax', httpOnly: true, secure: config.secureCookies });
    }
    let back = '/';
    try {
      const ref = new URL(req.headers.referer ?? '');
      if (ref.host === req.headers.host) back = `${ref.pathname}${ref.search}`;
    } catch {}
    return reply.redirect(back, 303);
  });

  app.get('/settings/servers', async (req, reply) => serversPage(d, req, reply));

  app.post('/settings/servers', async (req, reply) => {
    const b = bodyOf(req);
    const name = field(b, 'name');
    if (!name) return serversPage(d, req, reply);
    const token = newToken();
    const server = await repo.createServer({ name, agentTokenHash: hashToken(token), builtin: false });
    const proxy = field(b, 'proxy_mode');
    if (proxy === 'external' || proxy === 'bundled') await repo.updateServer(server.id, { proxyMode: proxy });
    return serversPage(d, req, reply, { name, token, command: agentCommand(d, token) });
  });

  app.post<{ Params: { id: string } }>('/settings/servers/:id/token', async (req, reply) => {
    const server = await repo.getServer(req.params.id);
    if (!server || server.builtin) return reply.code(404).send();
    const token = newToken();
    await repo.updateServer(server.id, { agentTokenHash: hashToken(token) });
    return serversPage(d, req, reply, { name: server.name, token, command: agentCommand(d, token) });
  });

  app.get('/settings/env/new', async (req, reply) => envForm(d, req, reply, { values: {}, errors: {}, isNew: true }));

  app.get<{ Params: { id: string } }>('/settings/env/:id', async (req, reply) => {
    const env = await repo.getEnv(req.params.id);
    if (!env) return reply.code(404).send();
    return envForm(d, req, reply, { values: toValues(d, env), errors: {}, isNew: false });
  });

  app.post('/settings/env', async (req, reply) => {
    const b = bodyOf(req);
    const id = field(b, 'id');
    const existing = id ? await repo.getEnv(id) : null;
    if (id && !existing) return reply.code(404).send();
    const values = bodyValues(b);
    const parsed = parseEnvForm(b);
    if (!parsed.ok) return envForm(d, req, reply, { values, errors: parsed.errors, isNew: !existing }, 422);
    const errors = await rollingErrors(d, parsed.value);
    if (errors) return envForm(d, req, reply, { values, errors, isNew: !existing }, 422);
    const { storageConfig, ...rest } = parsed.value;
    const storage = keepSecrets(storageConfig, existing ? readStorage(d, existing) : null);
    const token = existing ? undefined : newToken();
    const saved = await repo.saveEnv({
      ...rest,
      storageConfigEnc: encrypt(config.secretKey, JSON.stringify(storage)),
      deployTokenHash: existing ? existing.deployTokenHash : hashToken(token!),
      ...(existing ? { id: existing.id } : {}),
    });
    return envForm(d, req, reply, { values: toValues(d, saved), errors: {}, isNew: false, deployToken: token });
  });

  app.post<{ Params: { id: string } }>('/settings/env/:id/bind', async (req, reply) => {
    const env = await repo.getEnv(req.params.id);
    if (!env) return reply.code(404).send();
    const i = langOf(req);
    const res = await orchestrator.bindDatabase(env.id);
    const text = res.ok
      ? `${i.t('settings.env.bind')}: ${i.t('common.yes')}`
      : codeText(i, res.code, { env: env.name, svc: env.migrationService, ...res.params }).__html;
    return envForm(d, req, reply, { values: toValues(d, (await repo.getEnv(env.id))!), errors: {}, isNew: false, bind: { ok: res.ok, text } });
  });

  app.post<{ Params: { id: string } }>('/settings/env/:id/token', async (req, reply) => {
    const env = await repo.getEnv(req.params.id);
    if (!env) return reply.code(404).send();
    const token = newToken();
    await repo.saveEnv({ ...env, deployTokenHash: hashToken(token) });
    return envForm(d, req, reply, { values: toValues(d, env), errors: {}, isNew: false, deployToken: token });
  });
}
