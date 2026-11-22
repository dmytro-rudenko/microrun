import { describe, expect, test } from 'vitest';
import { LANGS, allKeys, i18n, type Lang } from '@microrun/core/i18n';
import { envFormView, parseEnvForm, serverBlock, type EnvFormValues } from './settings.ts';
import { html } from './html.ts';
import { loginView } from './login.ts';

const EVIL = '<img src=x onerror=alert(1)>';
const EVIL_ESCAPED = '&lt;img src=x onerror=alert(1)&gt;';

type Body = Record<string, string | string[]>;

function body(over: Body = {}): Body {
  return {
    name: 'staging',
    branch: 'staging',
    server_id: 'srv-1',
    position: '1',
    compose_project: 'shop',
    compose_dir: '/srv/shop',
    compose_files: 'docker-compose.yml',
    services: 'web:rolling:shop.example.com:3000\nworker:recreate',
    migration_service: 'web',
    db_kind: 'postgres',
    db_url_env: 'DATABASE_URL',
    migration_tables: '_migrations',
    expand_cmd: 'npm run migrate',
    contract_cmd: '',
    cleanup_cmd: '',
    health_timeout_s: '120',
    storage_kind: 'local',
    storage_path: '/var/lib/microrun/images',
    retention_value: '7',
    retention_unit: 'days',
    ...over,
  };
}

function parsed(over: Body = {}) {
  const r = parseEnvForm(body(over));
  if (!r.ok) throw new Error(`expected ok, got errors ${JSON.stringify(r.errors)}`);
  return r.value;
}

function failed(over: Body = {}) {
  const r = parseEnvForm(body(over));
  if (r.ok) throw new Error('expected errors, got ok');
  return r.errors;
}

const tagOf = (out: string, testid: string) => new RegExp(`<[^>]*data-testid="${testid}"[^>]*>`).exec(out)?.[0];
const textOf = (out: string, testid: string) =>
  new RegExp(`<[^>]*data-testid="${testid}"[^>]*>([\\s\\S]*?)</`).exec(out)?.[1];
const inputTag = (out: string, name: string) => new RegExp(`<input[^>]*\\bname="${name}"[^>]*>`).exec(out)?.[0];
const hasAttr = (tag: string, attr: string) => new RegExp(`\\s${attr}(?=[\\s=>/])`).test(tag);

function expectNoRawKeys(lang: Lang, view: string, out: string) {
  const keys = allKeys()[lang].filter((k) => /^[A-Za-z]\w*(\.\w+)+$/.test(k));
  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys) expect(out, `${view}: ${key}`).not.toContain(key);
  expect(out, `${view}: undefined`).not.toMatch(/undefined|NaN/);
}

describe('parseEnvForm', () => {
  test('a complete body parses into the typed env fields', () => {
    expect(parsed()).toEqual({
      name: 'staging',
      branch: 'staging',
      isProduction: false,
      position: 1,
      serverId: 'srv-1',
      composeProject: 'shop',
      composeDir: '/srv/shop',
      composeFiles: ['docker-compose.yml'],
      composeEnvFiles: [],
      services: [
        { name: 'web', strategy: 'rolling', domain: 'shop.example.com', port: 3000 },
        { name: 'worker', strategy: 'recreate' },
      ],
      migrationService: 'web',
      dbKind: 'postgres',
      dbUrlEnv: 'DATABASE_URL',
      migrationTables: ['_migrations'],
      expandCmd: 'npm run migrate',
      contractCmd: null,
      cleanupCmd: null,
      schemaCheck: 'post_check',
      healthTimeoutS: 120,
      storageKind: 'local',
      storageConfig: { kind: 'local', path: '/var/lib/microrun/images' },
      retentionS: 7 * 86_400,
    });
  });

  test('the parsed value carries no encrypted or hashed fields', () => {
    const value = parsed() as unknown as Record<string, unknown>;
    expect(value).not.toHaveProperty('storageConfigEnc');
    expect(value).not.toHaveProperty('deployTokenHash');
  });

  describe('retention', () => {
    test('30 minutes is rejected', () => {
      expect(failed({ retention_value: '0.5', retention_unit: 'hours' })).toHaveProperty('retention_value');
    });

    test('a value under one hour is rejected', () => {
      expect(failed({ retention_value: '0', retention_unit: 'hours' })).toHaveProperty('retention_value');
    });

    test('exactly one hour is accepted', () => {
      expect(parsed({ retention_value: '1', retention_unit: 'hours' }).retentionS).toBe(3600);
    });

    test('hours and days convert to seconds', () => {
      expect(parsed({ retention_value: '48', retention_unit: 'hours' }).retentionS).toBe(172_800);
      expect(parsed({ retention_value: '2', retention_unit: 'days' }).retentionS).toBe(172_800);
    });

    test('a unit other than hours or days is rejected', () => {
      const errors = failed({ retention_value: '30', retention_unit: 'minutes' });
      expect(Object.keys(errors).some((k) => k.startsWith('retention'))).toBe(true);
    });

    test('a non-numeric value is rejected', () => {
      expect(failed({ retention_value: 'abc' })).toHaveProperty('retention_value');
    });
  });

  describe('services', () => {
    test('web:rolling and worker:recreate lines parse', () => {
      expect(parsed({ services: 'web:rolling\nworker:recreate' }).services).toEqual([
        { name: 'web', strategy: 'rolling' },
        { name: 'worker', strategy: 'recreate' },
      ]);
    });

    test('CRLF line endings and blank lines are tolerated', () => {
      expect(parsed({ services: 'web:rolling\r\n\r\nworker:recreate\r\n' }).services).toEqual([
        { name: 'web', strategy: 'rolling' },
        { name: 'worker', strategy: 'recreate' },
      ]);
    });

    test('domain and port parse from the optional tail', () => {
      expect(parsed({ services: 'web:rolling:shop.example.com:8080' }).services).toEqual([
        { name: 'web', strategy: 'rolling', domain: 'shop.example.com', port: 8080 },
      ]);
    });

    test('an unknown strategy is rejected', () => {
      expect(failed({ services: 'web:bluegreen' })).toHaveProperty('services');
    });

    test('one bad line rejects the whole field', () => {
      expect(failed({ services: 'web:rolling\nworker:bluegreen' })).toHaveProperty('services');
    });
  });

  describe('schema_check default', () => {
    test('production defaults to dry_run', () => {
      expect(parsed({ is_production: 'on' }).schemaCheck).toBe('dry_run');
    });

    test('a non-production environment defaults to post_check', () => {
      expect(parsed().schemaCheck).toBe('post_check');
    });

    test('an explicit choice wins over the default', () => {
      expect(parsed({ is_production: 'on', schema_check: 'post_check' }).schemaCheck).toBe('post_check');
      expect(parsed({ schema_check: 'dry_run' }).schemaCheck).toBe('dry_run');
    });
  });

  describe('plain fields', () => {
    test('the is_production checkbox is on when present and off when absent', () => {
      expect(parsed({ is_production: 'on' }).isProduction).toBe(true);
      expect(parsed().isProduction).toBe(false);
    });

    test('textareas split one entry per line and drop blanks', () => {
      const value = parsed({
        compose_files: 'docker-compose.yml\r\ndocker-compose.prod.yml\n\n',
        compose_env_files: '/etc/shop/.env\n\nprod.env\r\n',
        migration_tables: '_migrations\nschema_history',
      });
      expect(value.composeFiles).toEqual(['docker-compose.yml', 'docker-compose.prod.yml']);
      expect(value.composeEnvFiles).toEqual(['/etc/shop/.env', 'prod.env']);
      expect(value.migrationTables).toEqual(['_migrations', 'schema_history']);
    });

    test('non-empty contract and cleanup commands are kept', () => {
      const value = parsed({ contract_cmd: 'npm run contract', cleanup_cmd: 'npm run cleanup' });
      expect(value.contractCmd).toBe('npm run contract');
      expect(value.cleanupCmd).toBe('npm run cleanup');
    });

    test('an unknown db_kind is rejected', () => {
      expect(failed({ db_kind: 'oracle' })).toHaveProperty('db_kind');
    });

    test('a non-numeric health_timeout_s is rejected', () => {
      expect(failed({ health_timeout_s: 'abc' })).toHaveProperty('health_timeout_s');
    });

    test('an empty name or branch is rejected', () => {
      const errors = failed({ name: '', branch: '' });
      expect(errors).toHaveProperty('name');
      expect(errors).toHaveProperty('branch');
    });

    test('every invalid field is reported together', () => {
      const errors = failed({ retention_value: '0.5', retention_unit: 'hours', services: 'web:bluegreen', db_kind: 'oracle' });
      expect(Object.keys(errors)).toEqual(expect.arrayContaining(['retention_value', 'services', 'db_kind']));
    });
  });

  describe('consistency rules', () => {
    const localized = (key: string) => {
      for (const lang of LANGS) expect(i18n(lang).t(key), `${lang}: ${key}`).not.toBe(key);
    };

    test('a migration_service that is not one of the services is rejected', () => {
      const errors = failed({ migration_service: 'api' });
      expect(Object.keys(errors)).toEqual(['migration_service']);
      expect(errors.migration_service).not.toBe('settings.err.required');
      localized(errors.migration_service!);
      expect(parsed({ migration_service: 'worker' }).migrationService).toBe('worker');
    });

    test('a health_timeout_s under 5 seconds is rejected and 5 is accepted', () => {
      const errors = failed({ health_timeout_s: '4' });
      expect(Object.keys(errors)).toEqual(['health_timeout_s']);
      expect(errors.health_timeout_s).not.toBe('settings.err.number');
      localized(errors.health_timeout_s!);
      expect(failed({ health_timeout_s: '0' })).toHaveProperty('health_timeout_s');
      expect(parsed({ health_timeout_s: '5' }).healthTimeoutS).toBe(5);
    });

    test.each(['Staging', 'my_env', '-stage', 'stage.eu', 'stage env', 'ü', 'a'.repeat(64)])('the env name %s is not a lowercase slug and is rejected', (name) => {
      const errors = failed({ name });
      expect(Object.keys(errors)).toEqual(['name']);
      expect(errors.name).not.toBe('settings.err.required');
      localized(errors.name!);
    });

    test.each(['stage', 'stage-2', '2-eu', 'a', 'a'.repeat(63)])('the env name %s is a valid slug', (name) => {
      expect(parsed({ name }).name).toBe(name);
    });
  });

  describe('defaults and required fields', () => {
    test('an empty position and health_timeout_s fall back to 0 and 120', () => {
      expect(parsed({ position: '', health_timeout_s: '' })).toMatchObject({ position: 0, healthTimeoutS: 120 });
    });

    test('every required text field is reported when empty', () => {
      const required = ['name', 'branch', 'server_id', 'compose_project', 'compose_dir', 'migration_service', 'db_url_env', 'expand_cmd'];
      const errors = failed(Object.fromEntries(required.map((k) => [k, ''])));
      expect(Object.keys(errors).sort()).toEqual([...required].sort());
    });
  });

  describe('storage', () => {
    test('registry fields map into the registry config', () => {
      const value = parsed({
        storage_kind: 'registry',
        storage_registry: 'ghcr.io',
        storage_repository: 'acme/shop',
        storage_username: 'bot',
        storage_password: 'hunter2',
      });
      expect(value.storageKind).toBe('registry');
      expect(value.storageConfig).toEqual({
        kind: 'registry',
        registry: 'ghcr.io',
        repository: 'acme/shop',
        username: 'bot',
        password: 'hunter2',
      });
    });

    test('an empty registry password yields an empty string, meaning keep the stored one', () => {
      const value = parsed({
        storage_kind: 'registry',
        storage_registry: 'ghcr.io',
        storage_repository: 'acme/shop',
        storage_username: 'bot',
        storage_password: '',
      });
      expect(value.storageConfig).toMatchObject({ kind: 'registry', password: '' });
    });

    test('s3 fields map into the s3 config', () => {
      const value = parsed({
        storage_kind: 's3',
        storage_endpoint: 'https://s3.example.com',
        storage_region: 'eu-central-1',
        storage_bucket: 'releases',
        storage_prefix: 'shop',
        storage_access_key: 'AKIA',
        storage_secret_key: 'sekret',
        storage_force_path_style: 'on',
      });
      expect(value.storageKind).toBe('s3');
      expect(value.storageConfig).toEqual({
        kind: 's3',
        endpoint: 'https://s3.example.com',
        region: 'eu-central-1',
        bucket: 'releases',
        prefix: 'shop',
        accessKey: 'AKIA',
        secretKey: 'sekret',
        forcePathStyle: true,
      });
    });

    test('s3 force-path-style is off when the checkbox is absent and an empty secret key stays empty', () => {
      const value = parsed({
        storage_kind: 's3',
        storage_endpoint: 'https://s3.example.com',
        storage_region: 'eu-central-1',
        storage_bucket: 'releases',
        storage_prefix: '',
        storage_access_key: 'AKIA',
        storage_secret_key: '',
      });
      expect(value.storageConfig).toMatchObject({ kind: 's3', forcePathStyle: false, secretKey: '' });
    });

    test('an unknown storage_kind is rejected', () => {
      expect(failed({ storage_kind: 'ftp' })).toHaveProperty('storage_kind');
    });
  });
});

describe('loginView', () => {
  const en = i18n('en');

  test('renders a full page with username, password and submit posting to /login', () => {
    const out = loginView(en, { error: false });
    expect(out).toMatch(/^<!doctype html>/i);
    expect(out).toMatch(/<form[^>]*action="\/login"/);
    expect(out).toMatch(/<form[^>]*method="post"/i);
    expect(out).toMatch(/<input[^>]*\bid="username"/);
    expect(out).toMatch(/<input[^>]*\bid="password"/);
    expect(inputTag(out, 'password')).toMatch(/type="password"/);
    expect(tagOf(out, 'login-submit')).toBeDefined();
  });

  test('shows login-error only when the login failed', () => {
    expect(tagOf(loginView(en, { error: true }), 'login-error')).toBeDefined();
    expect(tagOf(loginView(en, { error: false }), 'login-error')).toBeUndefined();
  });

  test('has no navigation, since nobody is logged in', () => {
    const out = loginView(en, { error: false });
    expect(out).not.toContain('href="/settings/servers"');
    expect(out).not.toContain('href="/history"');
  });

  test('carries the csrf token as a hidden _csrf field when given', () => {
    expect(loginView(en, { error: false, csrf: 'tok-123' })).toMatch(/<input[^>]*name="_csrf"[^>]*value="tok-123"|<input[^>]*value="tok-123"[^>]*name="_csrf"/);
  });

  test('escapes the csrf token', () => {
    const out = loginView(en, { error: false, csrf: EVIL });
    expect(out).not.toContain('<img');
    expect(out).toContain(EVIL_ESCAPED);
  });

  test.each(LANGS)('renders in %s without raw catalog keys', (lang) => {
    const out = loginView(i18n(lang), { error: true, csrf: 'tok' });
    expect(out).toContain(`lang="${lang}"`);
    expectNoRawKeys(lang, 'loginView', out);
    if (lang !== 'en') expect(out).not.toBe(loginView(en, { error: true, csrf: 'tok' }));
  });
});

describe('serverBlock', () => {
  const en = i18n('en');
  const servers = [
    { id: 's1', name: 'local', online: true, builtin: true, agentVersion: '1.2.0', proxyMode: 'external' },
    { id: 's2', name: 'edge', online: false, builtin: false, agentVersion: null, proxyMode: 'bundled' },
  ];
  const created = {
    name: 'edge-2',
    token: 'tok_abc123',
    command: 'npm i -g microrun && MICRORUN_AGENT_TOKEN=tok_abc123 microrun agent --url https://hub:3000',
  };
  const block = (over: Partial<Parameters<typeof serverBlock>[1]> = {}, i = en) =>
    serverBlock(i, { servers, selected: 's2', usedBy: [], csrf: 'csrf-1', ...over }).__html;
  const optionTag = (out: string, id: string) => new RegExp(`<option[^>]*value="${id}"[^>]*>`).exec(out)?.[0];
  const serverSelect = (out: string) => /<select[^>]*\bname="server_id"[^>]*>/.exec(out)?.[0];
  const proxySelect = (out: string) => /<select[^>]*\bname="proxy_mode"[^>]*>/.exec(out)?.[0];
  const hdr = '{&quot;x-csrf-token&quot;:&quot;csrf-1&quot;}';

  test('is a #srv container with the server-block test id', () => {
    expect(tagOf(block(), 'server-block')).toContain('id="srv"');
  });

  test('lists every server and marks only the selected one', () => {
    const out = block({ selected: 's2' });
    expect(hasAttr(optionTag(out, 's2')!, 'selected')).toBe(true);
    expect(hasAttr(optionTag(out, 's1')!, 'selected')).toBe(false);
  });

  test('falls back to the first server when the selected id is unknown', () => {
    const out = block({ selected: 'gone' });
    expect(hasAttr(optionTag(out, 's1')!, 'selected')).toBe(true);
    expect(hasAttr(optionTag(out, 's2')!, 'selected')).toBe(false);
    expect(tagOf(out, 'agent-status')).toMatch(/data-status="online"/);
  });

  test('the server select reloads the block through hx-get', () => {
    const tag = serverSelect(block())!;
    expect(tag).toContain('hx-get="/settings/servers/block"');
    expect(tag).toContain('hx-target="#srv"');
    expect(tag).toContain('hx-swap="outerHTML"');
  });

  test('agent-status shows offline for an offline server', () => {
    const out = block({ selected: 's2' });
    expect(tagOf(out, 'agent-status')).toMatch(/data-status="offline"/);
    expect(textOf(out, 'agent-status')).toContain(en.t('agent.offline'));
  });

  test('agent-status shows online for an online server', () => {
    const out = block({ selected: 's1' });
    expect(tagOf(out, 'agent-status')).toMatch(/data-status="online"/);
    expect(textOf(out, 'agent-status')).toContain(en.t('agent.online'));
  });

  test('shows the agent version of the selected server and a dash when there is none', () => {
    expect(block({ selected: 's1' })).toContain('1.2.0');
    const out = block({ selected: 's2' });
    expect(out).toContain('—');
    expect(out).not.toContain('null');
    expect(out).not.toContain('1.2.0');
  });

  test('the builtin server has no reissue button', () => {
    expect(tagOf(block({ selected: 's1' }), 'server-reissue')).toBeUndefined();
  });

  test('a remote server has a reissue button posting to its own token route', () => {
    const tag = tagOf(block({ selected: 's2' }), 'server-reissue')!;
    expect(tag).toBeDefined();
    expect(tag).toContain('hx-post="/settings/servers/s2/token"');
    expect(tag).toContain('hx-params="none"');
    expect(tag).toContain('hx-target="#srv"');
  });

  test('the proxy select posts to the selected server and selects its current mode', () => {
    const out = block({ selected: 's2' });
    const tag = proxySelect(out)!;
    expect(tag).toContain('hx-post="/settings/servers/s2/proxy"');
    expect(tag).toContain('hx-trigger="change"');
    expect(tag).toContain('hx-params="proxy_mode"');
    expect(tag).toContain('hx-target="#srv"');
    expect(hasAttr(optionTag(out, 'bundled')!, 'selected')).toBe(true);
    expect(hasAttr(optionTag(out, 'external')!, 'selected')).toBe(false);
  });

  test('the builtin server also has a proxy select', () => {
    expect(proxySelect(block({ selected: 's1' }))).toContain('hx-post="/settings/servers/s1/proxy"');
  });

  test('mutating requests carry the csrf token in hx-headers', () => {
    const out = block({ selected: 's2' });
    expect(proxySelect(out)).toContain(`hx-headers="${hdr}"`);
    expect(tagOf(out, 'server-reissue')).toContain(`hx-headers="${hdr}"`);
    expect(tagOf(out, 'server-create')).toContain(`hx-headers="${hdr}"`);
  });

  test('server-used-by lists the environments using the server', () => {
    expect(textOf(block({ usedBy: ['prod', 'stage'] }), 'server-used-by')).toContain('prod, stage');
  });

  test('server-used-by is absent when no environment uses the server', () => {
    expect(tagOf(block({ usedBy: [] }), 'server-used-by')).toBeUndefined();
  });

  test('shows the new agent token and install command when a server was just created', () => {
    const out = block({ created });
    expect(textOf(out, 'agent-token')).toContain('tok_abc123');
    expect(textOf(out, 'agent-command')).toContain(
      'npm i -g microrun &amp;&amp; MICRORUN_AGENT_TOKEN=tok_abc123 microrun agent --url https://hub:3000',
    );
    expect(out).toContain('edge-2');
  });

  test('shows neither the token nor the command on a later render', () => {
    const out = block();
    expect(tagOf(out, 'agent-token')).toBeUndefined();
    expect(tagOf(out, 'agent-command')).toBeUndefined();
    expect(out).not.toContain('tok_abc123');
  });

  test('shows server-error only when an error is passed', () => {
    expect(tagOf(block(), 'server-error')).toBeUndefined();
    const out = block({ error: 'name taken' });
    expect(tagOf(out, 'server-error')).toMatch(/role="alert"/);
    expect(textOf(out, 'server-error')).toContain('name taken');
  });

  test('escapes the error text', () => {
    const out = block({ error: EVIL });
    expect(out).not.toContain('<img');
    expect(out).toContain(EVIL_ESCAPED);
  });

  test('every button in the block is type="button" so it cannot submit the env form', () => {
    const out = block({ selected: 's2', created, error: 'x', usedBy: ['prod'] });
    const buttons = out.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const b of buttons) expect(b).toContain('type="button"');
  });

  test('the create button posts server_name and the selected server_id', () => {
    const tag = tagOf(block(), 'server-create')!;
    expect(tag).toContain('hx-post="/settings/servers"');
    expect(tag).toContain('hx-params="server_name,server_id"');
    expect(tag).toContain('hx-include="#srv [name=server_name], #srv [name=server_id]"');
    expect(tag).toContain('hx-target="#srv"');
  });

  test('the server_name input does not submit the env form on Enter', () => {
    const tag = inputTag(block(), 'server_name')!;
    expect(tag).toContain('data-testid="server-name"');
    expect(tag).toContain('type="text"');
    expect(tag).toContain('preventDefault');
  });

  test('contains no nested form, so it can sit inside the env form', () => {
    expect(block({ created, error: 'x' })).not.toContain('<form');
  });

  test('escapes server names', () => {
    const out = block({ servers: [{ ...servers[0]!, name: EVIL }], selected: 's1' });
    expect(out).not.toContain('<img');
    expect(out).toContain(EVIL_ESCAPED);
  });

  test('escapes the used-by list', () => {
    const out = block({ usedBy: [EVIL] });
    expect(out).not.toContain('<img');
    expect(out).toContain(EVIL_ESCAPED);
  });

  test.each(LANGS)('renders in %s without raw catalog keys', (lang) => {
    const render = (l: Lang) => block({ created, error: 'x', usedBy: ['prod', 'stage'], selected: 's2' }, i18n(l));
    expectNoRawKeys(lang, 'serverBlock', render(lang));
    if (lang !== 'en') expect(render(lang)).not.toBe(render('en'));
  });
});

describe('envFormView', () => {
  const en = i18n('en');
  const serverBlockHtml = html`<div id="srv"></div>`;

  function values(over: Record<string, string> = {}): EnvFormValues {
    return {
      name: 'staging',
      branch: 'staging',
      server_id: 'srv-1',
      position: '1',
      compose_project: 'shop',
      compose_dir: '/srv/shop',
      compose_files: 'docker-compose.yml',
      services: 'web:rolling\nworker:recreate',
      migration_service: 'web',
      db_kind: 'postgres',
      db_url_env: 'DATABASE_URL',
      migration_tables: '_migrations',
      expand_cmd: 'npm run migrate',
      contract_cmd: '',
      cleanup_cmd: '',
      schema_check: 'post_check',
      health_timeout_s: '120',
      storage_kind: 'local',
      storage_path: '/var/lib/microrun/images',
      retention_value: '7',
      retention_unit: 'days',
      ...over,
    } as unknown as EnvFormValues;
  }

  const view = (over: Partial<Parameters<typeof envFormView>[1]> = {}, v: Record<string, string> = {}) =>
    envFormView(en, { values: values(v), serverBlock: serverBlockHtml, errors: {}, csrf: 'csrf-1', isNew: false, ...over }).__html;

  test('has a save button and the csrf token', () => {
    const out = view();
    expect(tagOf(out, 'env-save')).toBeDefined();
    expect(inputTag(out, '_csrf')).toContain('csrf-1');
  });

  test('prefills the text fields from values', () => {
    const out = view();
    expect(inputTag(out, 'name')).toContain('value="staging"');
    expect(inputTag(out, 'compose_project')).toContain('value="shop"');
    expect(inputTag(out, 'db_url_env')).toContain('value="DATABASE_URL"');
  });

  test('escapes user values in inputs and textareas', () => {
    const out = view({}, { branch: EVIL, services: EVIL });
    expect(out).not.toContain('<img');
    expect(out).toContain(EVIL_ESCAPED);
  });

  test('is_production renders checked only when on', () => {
    expect(hasAttr(inputTag(view({}, { is_production: 'on' }), 'is_production')!, 'checked')).toBe(true);
    expect(hasAttr(inputTag(view(), 'is_production')!, 'checked')).toBe(false);
  });

  test('embeds the server block passed in place of the server dropdown', () => {
    const out = view();
    expect(out).toContain('<div id="srv"></div>');
    expect(out).not.toContain('name="server_id"');
  });

  test('has no page heading of its own', () => {
    expect(view()).not.toContain('<h1');
    expect(view({ isNew: true })).not.toContain('<h1');
  });

  test('the env form posts to /settings/env#settings', () => {
    expect(view()).toContain('<form method="post" action="/settings/env#settings" class="envform">');
  });

  test('the bind and token actions post to their routes with the #settings anchor', () => {
    const out = view({}, { id: 'env-1' });
    expect(out).toContain('<form method="post" action="/settings/env/env-1/bind#settings">');
    expect(out).toContain('<form method="post" action="/settings/env/env-1/token#settings">');
  });

  test.each([
    ['local', ['storage_path']],
    ['registry', ['storage_registry', 'storage_repository', 'storage_username', 'storage_password']],
    ['s3', ['storage_endpoint', 'storage_region', 'storage_bucket', 'storage_prefix', 'storage_access_key', 'storage_secret_key', 'storage_force_path_style']],
  ])('storage_kind %s renders its own fields', (kind, names) => {
    const out = view({}, { storage_kind: kind });
    expect(out).toContain('name="storage_kind"');
    for (const name of names) expect(inputTag(out, name), name).toBeDefined();
  });

  test('renders every plain form field by its name', () => {
    const out = view();
    for (const name of [
      'name', 'branch', 'is_production', 'position', 'compose_project', 'compose_dir',
      'compose_files', 'compose_env_files', 'services', 'migration_service', 'db_kind', 'db_url_env', 'migration_tables',
      'expand_cmd', 'contract_cmd', 'cleanup_cmd', 'schema_check', 'health_timeout_s',
      'retention_value', 'retention_unit',
    ]) {
      expect(out, name).toMatch(new RegExp(`<(input|textarea|select)[^>]*\\bname="${name}"`));
    }
  });

  test('the registry password input renders empty with the •••• placeholder', () => {
    const out = view({}, { storage_kind: 'registry', storage_password: 'hunter2' });
    const tag = inputTag(out, 'storage_password')!;
    expect(tag).toContain('placeholder="••••"');
    expect(tag).not.toMatch(/\svalue="[^"]/);
    expect(out).not.toContain('hunter2');
  });

  test('the s3 secret key input renders empty with the •••• placeholder', () => {
    const out = view({}, { storage_kind: 's3', storage_secret_key: 'sekret' });
    const tag = inputTag(out, 'storage_secret_key')!;
    expect(tag).toContain('placeholder="••••"');
    expect(tag).not.toMatch(/\svalue="[^"]/);
    expect(out).not.toContain('sekret');
  });

  test('shows env-error only when there are errors', () => {
    expect(tagOf(view(), 'env-error')).toBeUndefined();
    expect(tagOf(view({ errors: { name: 'x' } }), 'env-error')).toBeDefined();
  });

  test('renders the errors parseEnvForm produced', () => {
    const r = parseEnvForm(body({ retention_value: '0.5', services: 'web:bluegreen' }));
    if (r.ok) throw new Error('expected errors');
    const out = view({ errors: r.errors });
    expect(tagOf(out, 'env-error')).toBeDefined();
    expect(out).not.toMatch(/undefined|NaN/);
  });

  test('shows the deploy token only when one is passed', () => {
    expect(tagOf(view(), 'deploy-token')).toBeUndefined();
    expect(textOf(view({ deployToken: 'dep_tok_9' }), 'deploy-token')).toContain('dep_tok_9');
  });

  test('an existing environment offers the bind-database action', () => {
    expect(tagOf(view({ isNew: false }), 'env-bind-db')).toBeDefined();
  });

  test('bind-result appears only after a bind attempt and carries data-ok', () => {
    expect(tagOf(view(), 'bind-result')).toBeUndefined();
    const ok = view({ bind: { ok: true, text: 'Bound to marker' } });
    expect(tagOf(ok, 'bind-result')).toMatch(/data-ok="true"/);
    expect(textOf(ok, 'bind-result')).toContain('Bound to marker');
    const bad = view({ bind: { ok: false, text: 'Cannot reach db' } });
    expect(tagOf(bad, 'bind-result')).toMatch(/data-ok="false"/);
    expect(textOf(bad, 'bind-result')).toContain('Cannot reach db');
  });

  test('escapes the bind result text', () => {
    const out = view({ bind: { ok: false, text: EVIL } });
    expect(out).not.toContain('<img');
    expect(out).toContain(EVIL_ESCAPED);
  });

  test.each(LANGS)('renders in %s without raw catalog keys', (lang) => {
    const render = (l: Lang, kind: string) =>
      envFormView(i18n(l), {
        values: values({ storage_kind: kind }),
        serverBlock: serverBlockHtml,
        errors: { name: 'x' },
        csrf: 'csrf-1',
        isNew: false,
        deployToken: 'dep_tok_9',
        bind: { ok: true, text: 'ok' },
      }).__html;
    for (const kind of ['local', 'registry', 's3']) {
      const out = render(lang, kind);
      expectNoRawKeys(lang, `envFormView ${kind}`, out);
      if (lang !== 'en') expect(out).not.toBe(render('en', kind));
    }
  });
});
