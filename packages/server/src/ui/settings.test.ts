import { describe, expect, test } from 'vitest';
import { LANGS, allKeys, i18n, type Lang } from '@microrun/core/i18n';
import { envFormView, parseEnvForm, serversView, type EnvFormValues } from './settings.ts';
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
        migration_tables: '_migrations\nschema_history',
      });
      expect(value.composeFiles).toEqual(['docker-compose.yml', 'docker-compose.prod.yml']);
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

describe('serversView', () => {
  const en = i18n('en');
  const servers = [
    { id: 's1', name: 'local', online: true, builtin: true, agentVersion: '1.2.0', proxyMode: 'external' },
    { id: 's2', name: 'edge', online: false, builtin: false, agentVersion: null, proxyMode: 'bundled' },
  ];
  const created = {
    name: 'edge-2',
    token: 'tok_abc123',
    command: 'npm i -g microrun && microrun agent --url https://hub:3000 --token tok_abc123',
  };

  test('shows the new agent token and install command when a server was just created', () => {
    const out = serversView(en, servers, 'csrf-1', created).__html;
    expect(textOf(out, 'agent-token')).toContain('tok_abc123');
    expect(textOf(out, 'agent-command')).toContain(
      'npm i -g microrun &amp;&amp; microrun agent --url https://hub:3000 --token tok_abc123',
    );
  });

  test('shows neither the token nor the command on a later render', () => {
    const out = serversView(en, servers, 'csrf-1').__html;
    expect(tagOf(out, 'agent-token')).toBeUndefined();
    expect(tagOf(out, 'agent-command')).toBeUndefined();
    expect(out).not.toContain('tok_abc123');
  });

  test('has the create form with name field, submit and csrf', () => {
    const out = serversView(en, servers, 'csrf-1').__html;
    expect(tagOf(out, 'server-name')).toBeDefined();
    expect(tagOf(out, 'server-create')).toBeDefined();
    expect(inputTag(out, '_csrf')).toContain('csrf-1');
  });

  test('renders one row per server with data-status online or offline', () => {
    const out = serversView(en, servers, 'csrf-1').__html;
    expect(tagOf(out, 'server-row-local')).toMatch(/data-status="online"/);
    expect(tagOf(out, 'server-row-edge')).toMatch(/data-status="offline"/);
    expect(out.match(/data-testid="server-row-/g)).toHaveLength(2);
  });

  test('shows the agent version and proxy mode without printing null', () => {
    const out = serversView(en, servers, 'csrf-1').__html;
    expect(out).toContain('1.2.0');
    expect(out).toContain('bundled');
    expect(out).not.toContain('null');
  });

  test('escapes server names', () => {
    const out = serversView(en, [{ ...servers[0]!, name: EVIL }], 'csrf-1').__html;
    expect(out).not.toContain('<img');
    expect(out).toContain(EVIL_ESCAPED);
  });

  test.each(LANGS)('renders in %s without raw catalog keys', (lang) => {
    const out = serversView(i18n(lang), servers, 'csrf-1', created).__html;
    expectNoRawKeys(lang, 'serversView', out);
    if (lang !== 'en') expect(out).not.toBe(serversView(en, servers, 'csrf-1', created).__html);
  });
});

describe('envFormView', () => {
  const en = i18n('en');
  const servers = [
    { id: 'srv-1', name: 'local' },
    { id: 'srv-2', name: 'edge' },
  ];

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
    envFormView(en, { values: values(v), servers, errors: {}, csrf: 'csrf-1', isNew: false, ...over }).__html;

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

  test('lists the servers and selects the current one', () => {
    const out = view({}, { server_id: 'srv-2' });
    const select = out.slice(out.indexOf('name="server_id"'));
    const selected = /<option[^>]*value="srv-2"[^>]*>/.exec(select)![0];
    const other = /<option[^>]*value="srv-1"[^>]*>/.exec(select)![0];
    expect(hasAttr(selected, 'selected')).toBe(true);
    expect(hasAttr(other, 'selected')).toBe(false);
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
      'name', 'branch', 'is_production', 'server_id', 'position', 'compose_project', 'compose_dir',
      'compose_files', 'services', 'migration_service', 'db_kind', 'db_url_env', 'migration_tables',
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
        servers,
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
