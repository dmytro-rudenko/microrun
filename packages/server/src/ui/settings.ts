import type { I18n } from '@microrun/core/i18n';
import type { StorageConfig } from '@microrun/core/protocol';
import type { EnvInput, ServiceSpec } from '../db/repo.ts';
import { html, raw, tr, type Html } from './html.ts';

const DB_KINDS = ['postgres', 'mysql', 'sqlite', 'mongodb'] as const;
const STRATEGIES = ['rolling', 'recreate'] as const;
const STORAGE_KINDS = ['local', 'registry', 's3'] as const;
const SCHEMA_CHECKS = ['dry_run', 'post_check'] as const;
const PROXY_MODES = ['external', 'bundled'] as const;
const UNIT_SECONDS = { hours: 3600, days: 86_400 };
const UNITS = ['hours', 'days'] as const;
const MIN_RETENTION_S = 3600;

const REQUIRED = 'settings.err.required';
const NUMBER = 'settings.err.number';
const RETENTION = 'settings.err.retention';
const UNIT = 'settings.err.unit';
const SERVICES = 'settings.err.services';
const CHOICE = 'settings.err.choice';

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

  const value: EnvFormParsed = {
    name: req('name'),
    branch: req('branch'),
    isProduction,
    position: whole('position', 0),
    serverId: req('server_id'),
    composeProject: req('compose_project'),
    composeDir: req('compose_dir'),
    composeFiles: lines(text(body, 'compose_files')),
    services: services ?? [],
    migrationService: req('migration_service'),
    dbKind: choice(DB_KINDS, 'db_kind', text(body, 'db_kind'), 'postgres'),
    dbUrlEnv: req('db_url_env'),
    migrationTables: lines(text(body, 'migration_tables')),
    expandCmd: req('expand_cmd'),
    contractCmd: text(body, 'contract_cmd') || null,
    cleanupCmd: text(body, 'cleanup_cmd') || null,
    schemaCheck: choice(SCHEMA_CHECKS, 'schema_check', text(body, 'schema_check') || (isProduction ? 'dry_run' : 'post_check'), 'post_check'),
    healthTimeoutS: whole('health_timeout_s', 120),
    storageKind,
    storageConfig: parseStorage(body, storageKind, errors),
    retentionS,
  };
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

const fieldLabel = (i: I18n, name: string) => tr(i, `settings.f.${name}`);

export function serversView(
  i: I18n,
  servers: { id: string; name: string; online: boolean; builtin: boolean; agentVersion: string | null; proxyMode: string }[],
  csrf: string,
  created?: { name: string; token: string; command: string },
): Html {
  const token = html`<input type="hidden" name="_csrf" value="${csrf}">`;
  const row = (s: (typeof servers)[number]) => html`<tr data-testid="server-row-${s.name}" data-status="${s.online ? 'online' : 'offline'}">
<td>${s.name}</td><td>${tr(i, s.online ? 'agent.online' : 'agent.offline')}${s.builtin ? html` · ${tr(i, 'agent.builtin')}` : ''}</td>
<td>${s.agentVersion ?? '—'}</td><td>${s.proxyMode}</td>
<td>${s.builtin ? '' : html`<form method="post" action="/settings/servers/${s.id}/token">${token}<button type="submit">${tr(i, 'settings.servers.reissue')}</button></form>`}</td></tr>`;
  return html`<h1>${tr(i, 'settings.servers.title')}</h1>
${created
  ? html`<div class="alert ok" role="status"><p>${tr(i, 'settings.servers.created', { name: created.name })}</p>
<code data-testid="agent-token">${created.token}</code>
<p>${tr(i, 'settings.servers.command')}</p><pre data-testid="agent-command">${created.command}</pre></div>`
  : ''}
<form method="post" action="/settings/servers" class="row">${token}
<label>${tr(i, 'settings.servers.name')}<input name="name" data-testid="server-name" required></label>
<label>${tr(i, 'settings.servers.proxy')}<select name="proxy_mode">${PROXY_MODES.map((m) => html`<option value="${m}">${m}</option>`)}</select></label>
<button type="submit" data-testid="server-create">${tr(i, 'settings.servers.create')}</button></form>
<table><thead><tr><th>${tr(i, 'settings.servers.colName')}</th><th>${tr(i, 'settings.servers.colStatus')}</th><th>${tr(i, 'settings.servers.colVersion')}</th><th>${tr(i, 'settings.servers.proxy')}</th><th></th></tr></thead>
<tbody>${servers.map(row)}</tbody></table>`;
}

interface Option {
  value: string;
  label: Html | string;
}

const dropdown = (name: string, current: string, options: Option[], attrs = raw('')) =>
  html`<select name="${name}"${attrs}>${options.map((o) => html`<option value="${o.value}"${o.value === current ? ' selected' : ''}>${o.label}</option>`)}</select>`;

const entry = (name: string, value: string, type = 'text') => html`<input type="${type}" name="${name}" value="${value}">`;

const password = (name: string) => html`<input type="password" name="${name}" placeholder="••••" autocomplete="new-password">`;

const checkbox = (name: string, on: boolean) => html`<input type="checkbox" name="${name}"${on ? ' checked' : ''}>`;

function errorsBlock(i: I18n, errors: Record<string, string>): Html | string {
  const entries = Object.entries(errors);
  if (!entries.length) return '';
  return html`<div class="alert" role="alert" data-testid="env-error"><p>${tr(i, 'settings.env.errors')}</p>
<ul>${entries.map(([f, m]) => html`<li><b>${fieldLabel(i, f.startsWith('retention') ? 'retention' : f)}</b>: ${i.t(m)}</li>`)}</ul></div>`;
}

const bindResult = (bind: { ok: boolean; text: string }) =>
  html`<div class="alert${bind.ok ? ' ok' : ''}" data-testid="bind-result" data-ok="${bind.ok ? 'true' : 'false'}">${bind.text}</div>`;

const envActions = (i: I18n, id: string | undefined, csrf: Html, bind: { ok: boolean; text: string } | undefined) =>
  html`<form method="post" action="/settings/env/${id}/bind">${csrf}<button type="submit" data-testid="env-bind-db">${tr(i, 'settings.env.bind')}</button></form>
${bind ? bindResult(bind) : ''}
<form method="post" action="/settings/env/${id}/token">${csrf}<button type="submit">${tr(i, 'settings.env.reissue')}</button></form>`;

const deployTokenBlock = (i: I18n, token: string) =>
  html`<div class="alert ok" role="status"><p>${tr(i, 'settings.env.tokenShown')}</p><code data-testid="deploy-token">${token}</code></div>`;

export function envFormView(
  i: I18n,
  p: {
    values: EnvFormValues;
    servers: { id: string; name: string }[];
    errors: Record<string, string>;
    csrf: string;
    isNew: boolean;
    deployToken?: string;
    bind?: { ok: boolean; text: string };
  },
): Html {
  const v = (k: keyof EnvFormValues) => p.values[k] ?? '';
  const csrf = html`<input type="hidden" name="_csrf" value="${p.csrf}">`;
  const label = (name: string) => fieldLabel(i, name);
  const field = (name: string, control: Html, hint?: string) =>
    html`<label class="f"><span>${label(name)}</span>${control}${hint ? html`<small>${tr(i, `settings.h.${hint}`)}</small>` : ''}</label>`;
  const kind = v('storage_kind') || 'local';
  const id = p.values.id;
  const isProduction = v('is_production') !== '';

  const group = (k: (typeof STORAGE_KINDS)[number], body: Html) =>
    html`<div class="kind" data-kind="${k}"${k === kind ? '' : ' hidden'}>${body}</div>`;

  return html`<h1>${tr(i, p.isNew ? 'settings.env.newTitle' : 'settings.env.editTitle')}</h1>
${errorsBlock(i, p.errors)}
<form method="post" action="/settings/env" class="envform">${csrf}${id ? html`<input type="hidden" name="id" value="${id}">` : ''}
<fieldset><legend>${tr(i, 'settings.sec.general')}</legend>
${field('name', entry('name', v('name')))}
${field('branch', entry('branch', v('branch')))}
${field('is_production', checkbox('is_production', isProduction))}
${field('server_id', dropdown('server_id', v('server_id'), p.servers.map((s) => ({ value: s.id, label: s.name }))))}
${field('position', entry('position', v('position'), 'number'))}
</fieldset>
<fieldset><legend>${tr(i, 'settings.sec.compose')}</legend>
${field('compose_project', entry('compose_project', v('compose_project')))}
${field('compose_dir', entry('compose_dir', v('compose_dir')))}
${field('compose_files', html`<textarea name="compose_files" rows="3">${v('compose_files')}</textarea>`, 'compose_files')}
${field('services', html`<textarea name="services" rows="4">${v('services')}</textarea>`, 'services')}
</fieldset>
<fieldset><legend>${tr(i, 'settings.sec.database')}</legend>
${field('migration_service', entry('migration_service', v('migration_service')))}
${field('db_kind', dropdown('db_kind', v('db_kind'), DB_KINDS.map((k) => ({ value: k, label: k }))))}
${field('db_url_env', entry('db_url_env', v('db_url_env')))}
${field('migration_tables', html`<textarea name="migration_tables" rows="3">${v('migration_tables')}</textarea>`, 'migration_tables')}
${field('schema_check', dropdown('schema_check', v('schema_check') || (isProduction ? 'dry_run' : 'post_check'), SCHEMA_CHECKS.map((k) => ({ value: k, label: tr(i, `settings.opt.${k}`) }))), 'schema_check')}
</fieldset>
<fieldset><legend>${tr(i, 'settings.sec.commands')}</legend>
${field('expand_cmd', entry('expand_cmd', v('expand_cmd')))}
${field('contract_cmd', entry('contract_cmd', v('contract_cmd')))}
${field('cleanup_cmd', entry('cleanup_cmd', v('cleanup_cmd')))}
${field('health_timeout_s', entry('health_timeout_s', v('health_timeout_s'), 'number'))}
</fieldset>
<fieldset><legend>${tr(i, 'settings.sec.storage')}</legend>
${field('storage_kind', dropdown('storage_kind', kind, STORAGE_KINDS.map((k) => ({ value: k, label: tr(i, `storage.${k}`) })), raw(` onchange="for(const g of this.form.querySelectorAll('.kind'))g.hidden=g.dataset.kind!==this.value"`)))}
${group('local', field('storage_path', entry('storage_path', v('storage_path'))))}
${group('registry', html`${field('storage_registry', entry('storage_registry', v('storage_registry')))}${field('storage_repository', entry('storage_repository', v('storage_repository')))}${field('storage_username', entry('storage_username', v('storage_username')))}${field('storage_password', password('storage_password'), 'secret')}`)}
${group('s3', html`${field('storage_endpoint', entry('storage_endpoint', v('storage_endpoint')))}${field('storage_region', entry('storage_region', v('storage_region')))}${field('storage_bucket', entry('storage_bucket', v('storage_bucket')))}${field('storage_prefix', entry('storage_prefix', v('storage_prefix')))}${field('storage_access_key', entry('storage_access_key', v('storage_access_key')))}${field('storage_secret_key', password('storage_secret_key'), 'secret')}${field('storage_force_path_style', checkbox('storage_force_path_style', v('storage_force_path_style') !== ''))}`)}
${field('retention', html`<span class="inline">${entry('retention_value', v('retention_value'), 'number')}${dropdown('retention_unit', v('retention_unit') || 'days', UNITS.map((u) => ({ value: u, label: tr(i, `settings.opt.${u}`) })))}</span>`, 'retention')}
</fieldset>
<button type="submit" data-testid="env-save">${tr(i, 'settings.env.save')}</button></form>
${p.isNew ? '' : envActions(i, id, csrf, p.bind)}
${p.deployToken ? deployTokenBlock(i, p.deployToken) : ''}`;
}
