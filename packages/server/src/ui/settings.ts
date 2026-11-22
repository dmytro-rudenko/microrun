import type { I18n } from '@microrun/core/i18n';
import type { StorageConfig } from '@microrun/core/protocol';
import type { EnvInput, ServiceSpec } from '../db/repo.ts';
import { alert, button, checkbox, confirmName, field, input, select, textarea } from './form.ts';
import { html, raw, tr, type Html } from './html.ts';

const DB_KINDS = ['postgres', 'mysql', 'sqlite', 'mongodb'] as const;
const STRATEGIES = ['rolling', 'recreate'] as const;
const STORAGE_KINDS = ['local', 'registry', 's3'] as const;
const SCHEMA_CHECKS = ['dry_run', 'post_check'] as const;
const PROXY_MODES = ['external', 'bundled'] as const;
const UNIT_SECONDS = { hours: 3600, days: 86_400 };
const UNITS = ['hours', 'days'] as const;
const MIN_RETENTION_S = 3600;
const MIN_HEALTH_TIMEOUT_S = 5;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

const REQUIRED = 'settings.err.required';
const NUMBER = 'settings.err.number';
const RETENTION = 'settings.err.retention';
const UNIT = 'settings.err.unit';
const SERVICES = 'settings.err.services';
const CHOICE = 'settings.err.choice';
const MIGRATION_SERVICE = 'settings.err.migrationService';
const HEALTH_TIMEOUT = 'settings.err.healthTimeout';
const NAME_SLUG = 'settings.err.slug';

type Body = Record<string, string | string[]>;
type Errors = Record<string, string>;

export type EnvFormParsed = Omit<EnvInput, 'storageConfigEnc' | 'deployTokenHash'> & { storageConfig: StorageConfig };

export type EnvFormValues = Partial<
  Record<
    | 'name' | 'branch' | 'is_production' | 'server_id' | 'position' | 'compose_project' | 'compose_dir'
    | 'compose_files' | 'services' | 'migration_service' | 'db_kind' | 'db_url_env' | 'migration_tables'
    | 'expand_cmd' | 'contract_cmd' | 'cleanup_cmd' | 'schema_check' | 'health_timeout_s'
    | 'storage_kind' | 'storage_path' | 'storage_registry' | 'storage_repository' | 'storage_username'
    | 'storage_password' | 'storage_endpoint' | 'storage_region' | 'storage_bucket' | 'storage_prefix'
    | 'storage_access_key' | 'storage_secret_key' | 'storage_force_path_style'
    | 'retention_value' | 'retention_unit',
    string
  >
> & { id?: string };

const oneOf = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);

export const text = (b: Body, k: string) => {
  const v = b[k];
  return (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();
};

const lines = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

function parseServices(src: string): ServiceSpec[] | null {
  const out: ServiceSpec[] = [];
  for (const line of lines(src)) {
    const [name, strategy = '', domain, port, ...rest] = line.split(/:/).map((p) => p.trim());
    if (!name || !oneOf(STRATEGIES, strategy) || rest.length) return null;
    if (domain === undefined) {
      out.push({ name, strategy });
      continue;
    }
    if (!domain || !port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) return null;
    out.push({ name, strategy, domain, port: Number(port) });
  }
  return out.length ? out : null;
}

function parseStorage(b: Body, kind: (typeof STORAGE_KINDS)[number], errors: Errors): StorageConfig {
  const req = (k: string) => {
    const v = text(b, k);
    if (!v) errors[k] = REQUIRED;
    return v;
  };
  if (kind === 'registry') {
    return {
      kind,
      registry: req('storage_registry'),
      repository: req('storage_repository'),
      username: req('storage_username'),
      password: text(b, 'storage_password'),
    };
  }
  if (kind === 's3') {
    return {
      kind,
      endpoint: text(b, 'storage_endpoint'),
      region: text(b, 'storage_region'),
      bucket: req('storage_bucket'),
      prefix: text(b, 'storage_prefix'),
      accessKey: req('storage_access_key'),
      secretKey: text(b, 'storage_secret_key'),
      forcePathStyle: text(b, 'storage_force_path_style') !== '',
    };
  }
  return { kind, path: req('storage_path') };
}

function parseRetention(body: Body, errors: Errors): number {
  const unit = text(body, 'retention_unit');
  const amount = text(body, 'retention_value');
  if (!oneOf(UNITS, unit)) {
    errors.retention_unit = UNIT;
    return 0;
  }
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    errors.retention_value = NUMBER;
    return 0;
  }
  const retentionS = Math.round(Number(amount) * UNIT_SECONDS[unit]);
  if (retentionS < MIN_RETENTION_S) errors.retention_value = RETENTION;
  return retentionS;
}

export function parseEnvForm(body: Body): { ok: true; value: EnvFormParsed } | { ok: false; errors: Errors } {
  const errors: Errors = {};
  const req = (k: string) => {
    const v = text(body, k);
    if (!v) errors[k] = REQUIRED;
    return v;
  };
  const whole = (k: string, fallback: number) => {
    const v = text(body, k);
    if (v === '') return fallback;
    if (!/^\d+$/.test(v)) {
      errors[k] = NUMBER;
      return fallback;
    }
    return Number(v);
  };
  const choice = <T extends string>(list: readonly T[], k: string, v: string, fallback: T): T => {
    if (oneOf(list, v)) return v;
    errors[k] = CHOICE;
    return fallback;
  };

  const isProduction = text(body, 'is_production') !== '';
  const services = parseServices(text(body, 'services'));
  if (!services) errors.services = SERVICES;

  const storageKind = choice(STORAGE_KINDS, 'storage_kind', text(body, 'storage_kind'), 'local');

  const retentionS = parseRetention(body, errors);

  const name = req('name');
  if (name && !SLUG.test(name)) errors.name = NAME_SLUG;
  const migrationService = req('migration_service');
  if (services && migrationService && !services.some((s) => s.name === migrationService)) errors.migration_service = MIGRATION_SERVICE;
  const healthTimeoutS = whole('health_timeout_s', 120);
  if (!errors.health_timeout_s && healthTimeoutS < MIN_HEALTH_TIMEOUT_S) errors.health_timeout_s = HEALTH_TIMEOUT;

  const value: EnvFormParsed = {
    name,
    branch: req('branch'),
    isProduction,
    position: whole('position', 0),
    serverId: req('server_id'),
    composeProject: req('compose_project'),
    composeDir: req('compose_dir'),
    composeFiles: lines(text(body, 'compose_files')),
    services: services ?? [],
    migrationService,
    dbKind: choice(DB_KINDS, 'db_kind', text(body, 'db_kind'), 'postgres'),
    dbUrlEnv: req('db_url_env'),
    migrationTables: lines(text(body, 'migration_tables')),
    expandCmd: req('expand_cmd'),
    contractCmd: text(body, 'contract_cmd') || null,
    cleanupCmd: text(body, 'cleanup_cmd') || null,
    schemaCheck: choice(SCHEMA_CHECKS, 'schema_check', text(body, 'schema_check') || (isProduction ? 'dry_run' : 'post_check'), 'post_check'),
    healthTimeoutS,
    storageKind,
    storageConfig: parseStorage(body, storageKind, errors),
    retentionS,
  };
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

const fieldLabel = (i: I18n, name: string) => tr(i, `settings.f.${name}`);

const H1 = 'mt-2 mb-1 font-display text-2xl font-bold';
const TABLE = 'w-full border-collapse overflow-hidden rounded-[10px] border border-line bg-surface';
const TH = 'border-b border-line px-3 py-2.5 text-left align-middle text-xs font-semibold text-mute max-[900px]:p-2';
const TD = 'border-b border-line px-3 py-2.5 text-left align-middle max-[900px]:p-2';
const PROXY_OPTIONS = PROXY_MODES.map((m) => ({ value: m, label: m }));

function deleteDialog(
  i: I18n,
  p: { base: string; suffix: string; action: string; csrf: Html; title: Html; body: Html; expected: string },
): Html {
  return html`${button({
    type: 'button',
    variant: 'danger',
    testid: p.base + p.suffix,
    label: tr(i, 'settings.delete'),
    attrs: raw(' onclick="this.nextElementSibling.showModal()"'),
  })}<dialog data-testid="${p.base}-dialog${p.suffix}" class="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-6 text-ink shadow-xl backdrop:bg-black/50">
<form method="post" action="${p.action}" class="flex flex-col gap-4">${p.csrf}
<h2 class="font-display text-lg font-semibold">${p.title}</h2>
<p class="text-sm text-mute">${p.body}</p>
${confirmName({ label: tr(i, 'settings.confirmName', { name: p.expected }), expected: p.expected, name: 'confirm_name', testid: `${p.base}-name${p.suffix}` })}
<div class="flex justify-end gap-2">${button({
    type: 'button',
    variant: 'ghost',
    label: tr(i, 'common.cancel'),
    attrs: raw(` onclick="this.closest('dialog').close()"`),
  })}${button({ variant: 'danger', testid: `${p.base}-go${p.suffix}`, disabled: true, label: tr(i, 'settings.delete') })}</div>
</form></dialog>`;
}

export function serversView(
  i: I18n,
  servers: { id: string; name: string; online: boolean; builtin: boolean; agentVersion: string | null; proxyMode: string }[],
  csrf: string,
  created?: { name: string; token: string; command: string },
  error?: string,
): Html {
  const token = html`<input type="hidden" name="_csrf" value="${csrf}">`;
  const proxyForm = (s: (typeof servers)[number]) =>
    html`<form method="post" action="/settings/servers/${s.id}/proxy">${token}${select({
      name: 'proxy_mode',
      compact: true,
      current: s.proxyMode,
      options: PROXY_OPTIONS,
      attrs: html` aria-label="${i.t('settings.servers.proxy')}" onchange="this.form.submit()"`,
    })}</form>`;
  const actions = (s: (typeof servers)[number]) =>
    html`<div class="flex flex-wrap gap-2"><form method="post" action="/settings/servers/${s.id}/token">${token}${button({
      variant: 'ghost',
      label: tr(i, 'settings.servers.reissue'),
    })}</form>${deleteDialog(i, {
      base: 'server-delete',
      suffix: `-${s.name}`,
      action: `/settings/servers/${s.id}/delete`,
      csrf: token,
      title: tr(i, 'settings.servers.deleteTitle', { name: s.name }),
      body: tr(i, 'settings.servers.deleteBody'),
      expected: s.name,
    })}</div>`;
  const row = (s: (typeof servers)[number]) => html`<tr data-testid="server-row-${s.name}" data-status="${s.online ? 'online' : 'offline'}">
<td class="${TD}">${s.name}</td><td class="${TD}"><span class="${s.online ? 'text-ok' : 'text-mute'}">${tr(i, s.online ? 'agent.online' : 'agent.offline')}</span>${s.builtin ? html` · ${tr(i, 'agent.builtin')}` : ''}</td>
<td class="${TD}">${s.agentVersion ?? '—'}</td><td class="${TD}">${proxyForm(s)}</td>
<td class="${TD}">${s.builtin ? '' : actions(s)}</td></tr>`;
  const alerts = [
    created
      ? alert({
          tone: 'ok',
          role: 'status',
          body: html`<p>${tr(i, 'settings.servers.created', { name: created.name })}</p>
<code data-testid="agent-token" class="mt-1.5 block font-mono text-[13px] [overflow-wrap:anywhere]">${created.token}</code>
<p class="mt-2.5">${tr(i, 'settings.servers.command')}</p><pre data-testid="agent-command" class="mt-1.5 overflow-x-auto rounded-md bg-code p-2 font-mono text-xs">${created.command}</pre>`,
        })
      : '',
    error ? alert({ tone: 'error', role: 'alert', testid: 'server-error', body: html`${error}` }) : '',
  ].filter(Boolean);
  return html`<h1 class="${H1}">${tr(i, 'settings.servers.title')}</h1>
<div class="mt-4 flex flex-col gap-4">
${alerts.length ? html`<div class="flex flex-col gap-3">${alerts}</div>` : ''}
<form method="post" action="/settings/servers" class="flex flex-wrap items-end gap-4 rounded-xl border border-line bg-surface p-5">${token}
${field({ id: 'f-server-name', label: tr(i, 'settings.servers.name'), control: input({ name: 'name', id: 'f-server-name', testid: 'server-name', required: true }) })}
${field({ id: 'f-server-proxy', label: tr(i, 'settings.servers.proxy'), control: select({ name: 'proxy_mode', id: 'f-server-proxy', options: PROXY_OPTIONS }) })}
${button({ testid: 'server-create', label: tr(i, 'settings.servers.create') })}</form>
<div class="overflow-x-auto"><table class="${TABLE}"><thead><tr><th class="${TH}">${tr(i, 'settings.servers.colName')}</th><th class="${TH}">${tr(i, 'settings.servers.colStatus')}</th><th class="${TH}">${tr(i, 'settings.servers.colVersion')}</th><th class="${TH}">${tr(i, 'settings.servers.proxy')}</th><th class="${TH}"></th></tr></thead>
<tbody>${servers.map(row)}</tbody></table>
</div>`;
}

function errorsBlock(i: I18n, errors: Record<string, string>): Html | string {
  const entries = Object.entries(errors);
  if (!entries.length) return '';
  return alert({
    tone: 'error',
    role: 'alert',
    testid: 'env-error',
    body: html`<p>${tr(i, 'settings.env.errors')}</p>
<ul class="mt-1.5 list-disc pl-5">${entries.map(([f, m]) => html`<li><b>${fieldLabel(i, f.startsWith('retention') ? 'retention' : f)}</b>: ${i.t(m)}</li>`)}</ul>`,
  });
}

type BindResult = { ok: boolean; text: string };

const bindResult = (bind: BindResult) =>
  alert({ tone: bind.ok ? 'ok' : 'error', testid: 'bind-result', attrs: raw(` data-ok="${bind.ok ? 'true' : 'false'}"`), body: html`${bind.text}` });

const envActions = (i: I18n, id: string | undefined, csrf: Html, bind: BindResult | undefined) =>
  html`<div class="flex max-w-3xl flex-col gap-3"><div class="flex flex-wrap gap-2"><form method="post" action="/settings/env/${id}/bind">${csrf}${button({
    variant: 'ghost',
    testid: 'env-bind-db',
    label: tr(i, 'settings.env.bind'),
  })}</form>
<form method="post" action="/settings/env/${id}/token">${csrf}${button({ variant: 'ghost', label: tr(i, 'settings.env.reissue') })}</form></div>
${bind ? bindResult(bind) : ''}</div>`;

const deployTokenBlock = (i: I18n, token: string) =>
  alert({
    tone: 'ok',
    role: 'status',
    body: html`<p>${tr(i, 'settings.env.tokenShown')}</p><code data-testid="deploy-token" class="mt-1.5 block font-mono text-[13px] [overflow-wrap:anywhere]">${token}</code>`,
  });

export function envFormView(
  i: I18n,
  p: {
    values: EnvFormValues;
    servers: { id: string; name: string }[];
    errors: Record<string, string>;
    csrf: string;
    isNew: boolean;
    deployToken?: string;
    bind?: BindResult;
    rollingHint?: boolean;
    deleteError?: string;
    storedName?: string;
  },
): Html {
  const v = (k: keyof EnvFormValues) => p.values[k] ?? '';
  const csrf = html`<input type="hidden" name="_csrf" value="${p.csrf}">`;
  const label = (name: string) => fieldLabel(i, name);
  const fld = (name: string, control: Html, hint?: string) =>
    field({ id: `f-${name}`, label: label(name), control, hint: hint ? tr(i, `settings.h.${hint}`) : undefined });
  const text = (name: keyof EnvFormValues, type?: 'number') => input({ name, id: `f-${name}`, value: v(name), type });
  const secret = (name: string) => input({ name, id: `f-${name}`, type: 'password', placeholder: '••••', autocomplete: 'new-password' });
  const area = (name: keyof EnvFormValues, rows: number) => textarea({ name, id: `f-${name}`, value: v(name), rows });
  const check = (name: keyof EnvFormValues, checked: boolean) => checkbox({ name, id: `f-${name}`, checked, label: label(name) });
  const kind = v('storage_kind') || 'local';
  const id = p.values.id;
  const isProduction = v('is_production') !== '';

  const section = (title: Html, body: Html) =>
    html`<fieldset class="flex flex-col gap-5 rounded-xl border border-line bg-surface p-5"><legend class="px-1 font-display text-sm font-semibold">${title}</legend>
<div class="grid gap-5 sm:grid-cols-2">${body}</div></fieldset>`;
  const group = (k: (typeof STORAGE_KINDS)[number], body: Html) =>
    html`<div data-kind="${k}" class="gap-5 sm:col-span-2 sm:grid-cols-2 [&:not([hidden])]:grid"${k === kind ? '' : raw(' hidden')}>${body}</div>`;

  const alerts = [
    errorsBlock(i, p.errors),
    p.rollingHint ? alert({ tone: 'warn', role: 'status', testid: 'rolling-hint', body: tr(i, 'settings.env.rollingHint') }) : '',
    p.deleteError ? alert({ tone: 'error', role: 'alert', testid: 'env-delete-error', body: html`${p.deleteError}` }) : '',
  ].filter(Boolean);

  return html`<h1 class="${H1}">${tr(i, p.isNew ? 'settings.env.newTitle' : 'settings.env.editTitle')}</h1>
<div class="mt-4 flex flex-col gap-4">
${alerts.length ? html`<div class="flex max-w-3xl flex-col gap-3">${alerts}</div>` : ''}
<form method="post" action="/settings/env" class="flex max-w-3xl flex-col gap-6">${csrf}${id ? html`<input type="hidden" name="id" value="${id}">` : ''}
${section(tr(i, 'settings.sec.general'), html`${fld('name', text('name'))}
${fld('branch', text('branch'))}
${check('is_production', isProduction)}
${fld('server_id', select({ name: 'server_id', id: 'f-server_id', current: v('server_id'), options: p.servers.map((s) => ({ value: s.id, label: s.name })) }))}
${fld('position', text('position', 'number'))}`)}
${section(tr(i, 'settings.sec.compose'), html`${fld('compose_project', text('compose_project'))}
${fld('compose_dir', text('compose_dir'))}
${fld('compose_files', area('compose_files', 3), 'compose_files')}
${fld('services', area('services', 4), 'services')}`)}
${section(tr(i, 'settings.sec.database'), html`${fld('migration_service', text('migration_service'))}
${fld('db_kind', select({ name: 'db_kind', id: 'f-db_kind', current: v('db_kind'), options: DB_KINDS.map((k) => ({ value: k, label: k })) }))}
${fld('db_url_env', text('db_url_env'))}
${fld('migration_tables', area('migration_tables', 3), 'migration_tables')}
${fld('schema_check', select({ name: 'schema_check', id: 'f-schema_check', current: v('schema_check') || (isProduction ? 'dry_run' : 'post_check'), options: SCHEMA_CHECKS.map((k) => ({ value: k, label: tr(i, `settings.opt.${k}`) })) }), 'schema_check')}`)}
${section(tr(i, 'settings.sec.commands'), html`${fld('expand_cmd', text('expand_cmd'))}
${fld('contract_cmd', text('contract_cmd'))}
${fld('cleanup_cmd', text('cleanup_cmd'))}
${fld('health_timeout_s', text('health_timeout_s', 'number'))}`)}
${section(tr(i, 'settings.sec.storage'), html`${fld('storage_kind', select({
    name: 'storage_kind',
    id: 'f-storage_kind',
    current: kind,
    options: STORAGE_KINDS.map((k) => ({ value: k, label: tr(i, `storage.${k}`) })),
    attrs: raw(` onchange="for(const g of this.form.querySelectorAll('[data-kind]'))g.hidden=g.dataset.kind!==this.value"`),
  }))}
${group('local', fld('storage_path', text('storage_path')))}
${group('registry', html`${fld('storage_registry', text('storage_registry'))}${fld('storage_repository', text('storage_repository'))}${fld('storage_username', text('storage_username'))}${fld('storage_password', secret('storage_password'), 'secret')}`)}
${group('s3', html`${fld('storage_endpoint', text('storage_endpoint'))}${fld('storage_region', text('storage_region'))}${fld('storage_bucket', text('storage_bucket'))}${fld('storage_prefix', text('storage_prefix'))}${fld('storage_access_key', text('storage_access_key'))}${fld('storage_secret_key', secret('storage_secret_key'), 'secret')}${check('storage_force_path_style', v('storage_force_path_style') !== '')}`)}
${field({
    id: 'f-retention',
    label: label('retention'),
    hint: tr(i, 'settings.h.retention'),
    control: html`<div class="flex gap-2">${input({ name: 'retention_value', id: 'f-retention', type: 'number', value: v('retention_value') })}${select({
      name: 'retention_unit',
      compact: true,
      current: v('retention_unit') || 'days',
      options: UNITS.map((u) => ({ value: u, label: tr(i, `settings.opt.${u}`) })),
    })}</div>`,
  })}`)}
${button({ testid: 'env-save', label: tr(i, 'settings.env.save') })}</form>
${p.isNew ? '' : envActions(i, id, csrf, p.bind)}
${p.deployToken ? deployTokenBlock(i, p.deployToken) : ''}
${
  !p.isNew && id
    ? html`<section class="mt-8 flex max-w-3xl flex-col gap-3 rounded-xl border border-prod p-5"><h2 class="font-display text-base font-semibold text-prod">${tr(i, 'settings.env.dangerZone')}</h2><p class="text-sm text-mute">${tr(i, 'settings.env.deleteBody')}</p>${deleteDialog(i, {
        base: 'env-delete',
        suffix: '',
        action: `/settings/env/${id}/delete`,
        title: tr(i, 'settings.env.deleteTitle', { name: p.storedName ?? v('name') }),
        body: tr(i, 'settings.env.deleteBody'),
        expected: p.storedName ?? v('name'),
        csrf,
      })}</section>`
    : ''
}
</div>`;
}
