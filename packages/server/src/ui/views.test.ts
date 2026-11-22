import { describe, expect, test } from 'vitest';
import { LANGS, allKeys, i18n, type Lang } from '@microrun/core/i18n';
import { esc, html, maskUrl, raw } from './html.ts';
import type { EnvVM } from './board.ts';
import { envView, newEnvView } from './env.ts';
import { releaseHistory } from './history.ts';
import { homeView, type HomeVM } from './home.ts';
import { layout } from './layout.ts';
import { cleanupView, opProgressView, panelView } from './panel.ts';

type ReleaseVM = Parameters<typeof panelView>[2];
type HistoryVM = Parameters<typeof releaseHistory>[1][number];

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EVIL = '<img src=x onerror=alert(1)>';
const EVIL_ESCAPED = '&lt;img src=x onerror=alert(1)&gt;';

const sha = (head: string) => head.padEnd(40, '0');

function release(over: Partial<ReleaseVM> = {}): ReleaseVM {
  return {
    id: 'rel-1',
    sha: sha('a1b2c3d'),
    message: 'Fix login redirect',
    author: 'dmytro',
    deployedAt: NOW - HOUR,
    state: 'available',
    windowLeftMs: 5 * DAY,
    windowPct: 70,
    diff: [],
    blocked: null,
    failNote: null,
    cleanupState: 'none',
    cleanupPreview: null,
    cleanupResult: null,
    activationSeq: null,
    imagePurged: false,
    stored: true,
    storing: false,
    cleanupFailed: null,
    ...over,
  };
}

function op(over: Partial<HistoryVM> = {}): HistoryVM {
  return {
    at: NOW - HOUR,
    kind: 'deploy',
    from: sha('1111111'),
    to: sha('2222222'),
    actor: 'admin',
    status: 'ok',
    durationS: 12,
    reason: null,
    ...over,
  };
}

const RULES = [
  { rule: 'promo-notifications', description: 'Promo notifications', count: 50 },
  { rule: 'stale-sessions', description: 'Expired sessions', count: 7 },
  { rule: 'empty-rule', description: 'Nothing to delete', count: 0 },
];

const CREDENTIAL_URLS: [string, string, string][] = [
  ['postgres://u:secret@h/db', 'postgres://u:***@h/db', 'secret'],
  ['postgres://u:p@ss@h/db', 'postgres://u:***@h/db', 'p@ss'],
  ['postgres://u:pa/ss@host/db', 'postgres://u:***@host/db', 'pa/ss'],
  ['mysql://u:p#w?x@h:3306/db', 'mysql://u:***@h:3306/db', 'p#w?x'],
  ['postgres://h/db?user=u&password=s3cr3t&sslmode=require', 'postgres://h/db?user=u&password=***&sslmode=require', 's3cr3t'],
  ['u:s3cr3t@h:5432/db', 'u:***@h:5432/db', 's3cr3t'],
  ['host=h user=u password=s3cr3t dbname=d', 'host=h user=u password=*** dbname=d', 's3cr3t'],
  ['mongodb://u:s3cr3t@h1,h2/db?replicaSet=rs', 'mongodb://u:***@h1,h2/db?replicaSet=rs', 's3cr3t'],
];

const PLAIN_URLS = [
  'postgres://u@h/db',
  'postgres://db-host/shop',
  's3://releases/shop',
  'postgres://h/db?user=u&sslmode=require',
  'h:5432/db',
  'host=h user=u dbname=d',
  'mongodb://h1,h2/db?replicaSet=rs',
];

const REQUIRED_KEYS = ['nav.envs', 'state.active', 'rb.noMarker', 'approve.title', 'storage.failedWarn', 'contract.retry', 'approve.expires', 'cl.preparing', 'kind.approve'];

const KEY_SHAPED = /^[A-Za-z]\w*(\.\w+)+$/;

function expectNoRawKeys(lang: Lang, view: string, out: string) {
  const keys = allKeys()[lang];
  for (const required of REQUIRED_KEYS) expect(keys).toContain(required);
  const keyShaped = keys.filter((k) => /^[a-z]+\.\w+$/.test(k));
  expect(keyShaped.length).toBeGreaterThan(0);
  for (const key of keyShaped) expect(out, `${view}: ${key}`).not.toContain(key);
  expect(out, `${view}: undefined`).not.toMatch(/undefined|NaN/);
}

function env(name: string, over: Partial<EnvVM> = {}): EnvVM {
  return {
    id: `env-${name}`,
    name,
    branch: name === 'prod' ? 'main' : name,
    isProduction: name === 'prod',
    retentionS: 7 * 86_400,
    agentOnline: true,
    serverName: 'build-host',
    builtin: false,
    composeProject: `shop-${name}`,
    services: [{ name: 'api', strategy: 'recreate' }],
    db: 'postgres',
    storage: { kind: 's3', target: 'releases' },
    markerWarnings: [],
    releases: [release({ id: `rel-${name}`, sha: sha('a1b2c3d') })],
    ...over,
  };
}

function homeVmFrom(envs: EnvVM[]): HomeVM {
  return {
    q: '',
    only: 'all',
    feed: envs.flatMap((e) => e.releases.map((r) => ({
      ...r,
      envId: e.id,
      envName: e.name,
      isProduction: e.isProduction,
      schemaChange: r.diff.length > 0,
    }))),
    rest: 0,
    next: null,
    envs: envs.map(({ id, name, isProduction }) => ({ id, name, isProduction, dot: 'ok' })),
  };
}

const tagOf = (out: string, testid: string) =>
  new RegExp(`<[^>]*data-testid="${testid}"[^>]*>`).exec(out)?.[0];

const isDisabled = (tag: string) => /\sdisabled(?=[\s=>/])/.test(tag);

const parts = { settings: html`<p>S</p>` };
const tdTags = (out: string) => out.match(/<td[\s>][^>]*>/g) ?? [];

describe('html and raw', () => {
  test('html escapes markup in interpolated values', () => {
    const out = html`<p>${'<script>alert(1)</script>'}</p>`.__html;
    expect(out).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  test('html escapes quotes so a value cannot break out of an attribute', () => {
    const out = html`<a title="${'" onmouseover="x'}">y</a>`.__html;
    expect(out).not.toContain('" onmouseover="x');
    expect(out).toContain('&quot; onmouseover=&quot;x');
  });

  test('raw passes markup through unescaped', () => {
    const out = html`<div>${raw('<b>bold</b>')}</div>`.__html;
    expect(out).toBe('<div><b>bold</b></div>');
  });

  test('an Html value nested in html is not escaped a second time', () => {
    const inner = html`<i>${'a & b'}</i>`;
    expect(html`<p>${inner}</p>`.__html).toBe('<p><i>a &amp; b</i></p>');
  });
});

describe('envView', () => {
  const i = i18n('en');

  test('renders one row per release with testid rel-<env>-<sha7> and data-state', () => {
    const e = env('stage', {
      releases: [
        release({ id: 'r-a', sha: sha('1111111'), state: 'active' }),
        release({ id: 'r-b', sha: sha('2222222'), state: 'blocked', blocked: { at: NOW - HOUR, to: sha('1111111') } }),
        release({ id: 'r-c', sha: sha('3333333'), state: 'expired', windowLeftMs: null, windowPct: null }),
      ],
    });
    const out = envView(i, e, NOW, parts).__html;
    expect(out.match(/data-testid="rel-stage-/g)).toHaveLength(3);
    expect(tagOf(out, 'rel-stage-1111111')).toContain('data-state="active"');
    expect(tagOf(out, 'rel-stage-2222222')).toContain('data-state="blocked"');
    expect(tagOf(out, 'rel-stage-3333333')).toContain('data-state="expired"');
    expect(tagOf(out, 'rel-stage-1111111')).toContain('hx-get="/panel/r-a"');
    expect(tagOf(out, 'rel-stage-1111111')).toContain('hx-target="#panel"');
  });

  test('renders the releases and settings sections in that order, with no history section', () => {
    const out = envView(i, env('stage'), NOW, parts).__html;
    const at = (id: string) => out.indexOf(`<section id="${id}">`);
    expect(at('releases')).toBeGreaterThanOrEqual(0);
    expect(at('releases')).toBeLessThan(at('settings'));
    expect(out.match(/<section id=/g)).toHaveLength(2);
    expect(out).not.toContain('<section id="history">');
  });

  test('the releases table sits inside the releases section', () => {
    const out = envView(i, env('stage'), NOW, parts).__html;
    const releases = out.slice(out.indexOf('<section id="releases">'), out.indexOf('<section id="settings">'));
    expect(releases).toContain('<table');
    expect(releases).toContain('data-testid="rel-stage-');
  });

  test('a production env gets a prod jump nav carrying the PRODUCTION tag', () => {
    const out = envView(i, env('prod'), NOW, parts).__html;
    expect(tagOf(out, 'env-jump')).toContain('class="jump prod ');
    const nav = out.slice(out.indexOf('data-testid="env-jump"'), out.indexOf('</nav>'));
    expect(nav).toContain(i.t('env.prodTag'));
  });

  test('a non-production env gets a plain jump nav without the prod tag', () => {
    const out = envView(i, env('stage'), NOW, parts).__html;
    const tag = tagOf(out, 'env-jump');
    expect(tag).toContain('class="jump ');
    expect(tag).not.toContain('jump prod');
    const nav = out.slice(out.indexOf('data-testid="env-jump"'), out.indexOf('</nav>'));
    expect(nav).not.toContain(i.t('env.prodTag'));
  });

  test('the jump nav links to the releases and settings sections', () => {
    const out = envView(i, env('stage'), NOW, parts).__html;
    const nav = out.slice(out.indexOf('data-testid="env-jump"'), out.indexOf('</nav>'));
    expect(nav).toContain(`<a href="#releases">${i.t('env.sec.releases')}</a>`);
    expect(nav).not.toContain('href="#history"');
    expect(nav).toContain(`<a href="#settings">${i.t('env.sec.settings')}</a>`);
  });

  test('shows the marker warning text only when the env has one', () => {
    const warning = { svc: 'api', other: 'prod', url: 'postgres://db-host/shop' };
    const text = i.t('marker.text', warning);
    expect(text).not.toBe('marker.text');

    const warned = envView(i, env('stage', { markerWarnings: [warning] }), NOW, parts).__html;
    expect(warned).toContain(i.t('marker.title'));
    expect(warned).toContain(text);

    const clean = envView(i, env('stage'), NOW, parts).__html;
    expect(clean).not.toContain(text);
  });

  test('a commit message with markup is escaped in the table', () => {
    const e = env('stage', { releases: [release({ message: EVIL })] });
    const out = envView(i, e, NOW, parts).__html;
    expect(out).not.toContain('<img');
    expect(out).toContain(EVIL_ESCAPED);
  });

  test.each(CREDENTIAL_URLS)('the marker warning url %s is shown without its secret', (url, masked, secret) => {
    const e = env('stage', { markerWarnings: [{ svc: 'api', other: 'prod', url }] });
    const out = envView(i, e, NOW, parts).__html;
    expect(out).not.toContain(secret);
    expect(out).toContain(esc(masked));
    const vm = homeVmFrom([e]);
    vm.envs[0]!.dot = 'mismatch';
    expect(homeView(i, vm, NOW).__html).not.toContain(secret);
    expect(panelView(i, e, e.releases[0]!, 'csrf-token', html``).__html).not.toContain(secret);
  });

  test.each([
    ...CREDENTIAL_URLS,
    ['https://ci:hunter2@registry.example.com/shop', 'https://ci:***@registry.example.com/shop', 'hunter2'],
  ])('the storage target %s is shown without its secret', (target, masked, secret) => {
    const e = env('stage', { storage: { kind: 'registry', target } });
    const out = envView(i, e, NOW, parts).__html;
    expect(out).not.toContain(secret);
    expect(out).toContain(esc(masked));
  });

  test.each(PLAIN_URLS)('the url %s without credentials is shown unchanged', (url) => {
    const e = env('stage', { markerWarnings: [{ svc: 'api', other: 'prod', url }], storage: { kind: 's3', target: url } });
    const out = envView(i, e, NOW, parts).__html;
    expect(out.split(esc(url)).length - 1).toBeGreaterThanOrEqual(2);
  });

  test('every table cell wraps long text with overflow-wrap:anywhere', () => {
    const cells = tdTags(envView(i, env('stage'), NOW, parts).__html);
    expect(cells.length).toBeGreaterThan(0);
    for (const td of cells) expect(td).toContain('[overflow-wrap:anywhere]');
  });
});

describe('newEnvView', () => {
  const i = i18n('en');

  test('shows a back link, the new-environment title, the hint and the settings part in the settings section', () => {
    const out = newEnvView(i, html`<p>S</p>`).__html;
    expect(out).toMatch(new RegExp(`<a href="/"[^>]*>${i.t('env.back')}</a>`));
    expect(out).toMatch(new RegExp(`<h1[^>]*>${i.t('settings.env.newTitle')}</h1>`));
    expect(out).toContain(i.t('env.newHint'));
    expect(out).toContain('<section id="settings"><p>S</p></section>');
    expect(out).not.toContain('data-testid="env-jump"');
  });
});

describe('maskUrl', () => {
  test.each(CREDENTIAL_URLS)('masks the secret in %s', (url, masked, secret) => {
    const out = maskUrl(url);
    expect(out).not.toContain(secret);
    expect(out).toBe(masked);
  });

  test.each(PLAIN_URLS)('leaves %s unchanged', (url) => {
    expect(maskUrl(url)).toBe(url);
  });
});

describe('releaseHistory', () => {
  const i = i18n('en');
  const items = (out: string) => out.match(/data-testid="history-item"/g) ?? [];

  test('renders one item per operation under the history heading', () => {
    const ops = [
      op({ to: sha('2222222') }),
      op({ kind: 'rollback', from: sha('2222222'), to: sha('3333333') }),
      op({ kind: 'cleanup', from: sha('4444444'), to: sha('4444444') }),
    ];
    const out = releaseHistory(i, ops).__html;
    expect(tagOf(out, 'release-history')).toBeDefined();
    expect(out).toContain(i.t('env.sec.history'));
    expect(items(out)).toHaveLength(ops.length);
    for (const head of ['2222222 → 3333333', '4444444']) expect(out).toContain(head);
    expect(out).not.toContain('history-all');
  });

  test('shows the empty message and no list when there are no operations', () => {
    const out = releaseHistory(i, []).__html;
    expect(tagOf(out, 'history-empty')).toBeDefined();
    expect(out).toContain(i.t('env.historyEmpty'));
    expect(out).not.toContain('<ul');
  });

  test('shows the actor, status and duration of an operation', () => {
    const out = releaseHistory(i, [op({ actor: 'ci:alice', durationS: 12 })]).__html;
    expect(out).toContain(i.t('actor.ci', { name: 'alice' }));
    expect(out).toContain('data-status="ok"');
    expect(out).toContain(i.unit(12, 'second'));
  });

  test.each(['en', 'uk', 'de'] as const)('a failure reason is localized through codes.* in %s', (lang) => {
    const li = i18n(lang);
    const params = { col: 'users.email' };
    const text = li.t('codes.SCHEMA_DESTRUCTIVE', params);
    expect(text).not.toBe('codes.SCHEMA_DESTRUCTIVE');
    expect(releaseHistory(li, [op({ status: 'rejected', reason: { code: 'SCHEMA_DESTRUCTIVE', params } })]).__html).toContain(text);
  });

  test.each(LANGS)('an approve operation is labelled from the catalog in %s', (lang) => {
    const li = i18n(lang);
    const label = li.t('kind.approve');
    expect(label).not.toBe('kind.approve');
    const out = releaseHistory(li, [op({ kind: 'approve', from: '—', to: sha('2222222') })]).__html;
    expect(out).toContain(label);
    expect(out).not.toContain('kind.approve');
  });

  test('a hostile actor name is escaped', () => {
    const out = releaseHistory(i, [op({ actor: `ci:${EVIL}` })]).__html;
    expect(out).not.toContain('<img');
    expect(out).toContain(EVIL_ESCAPED);
  });

  test('a hostile reason parameter is escaped exactly once', () => {
    const reason = { code: 'SCHEMA_DESTRUCTIVE', params: { col: EVIL } };
    const out = releaseHistory(i, [op({ status: 'rejected', reason })]).__html;
    expect(out).not.toContain('<img');
    expect(out).toContain(EVIL_ESCAPED);
    expect(out).not.toContain('&amp;lt;');
  });

  test('items wrap long text with overflow-wrap:anywhere', () => {
    expect(tagOf(releaseHistory(i, [op()]).__html, 'history-item')).toContain('[overflow-wrap:anywhere]');
  });

  test('panelView places the history last in the panel', () => {
    const r = release({ id: 'r-a', sha: sha('1111111'), state: 'active' });
    const out = panelView(i, env('stage', { releases: [r] }), r, 'csrf', releaseHistory(i, [op()])).__html;
    expect(out).toContain('data-testid="release-history"');
    expect(out.indexOf('data-testid="release-history"')).toBeGreaterThan(out.indexOf(i.t('col.schema')));
  });
});

describe('layout', () => {
  const i = i18n('de');
  const params = { i, title: 'Environments', csrf: 'tok-123', body: raw('<p id="body-marker">hi</p>') };
  const page = layout(params);
  const header = /<header\b[\s\S]*?<\/header>/.exec(page)?.[0] ?? '';
  const newEnvLink = /<a\b[^>]*\bdata-testid="env-new"[^>]*>[\s\S]*?<\/a>/.exec(header)?.[0] ?? '';

  test('the header has a brand link home and a New environment link to /env/new', () => {
    expect(header).toMatch(/<a href="\/"[^>]*><b[^>]*>(?:<span[^>]*>[^<]*<\/span>)?microrun<\/b><\/a>/);
    expect(tagOf(newEnvLink, 'env-new')).toContain('href="/env/new"');
    expect(newEnvLink).toContain(`>${i.t('env.newEnv')}<`);
  });

  test('the header no longer links to the history or servers pages', () => {
    expect(header).not.toContain('href="/history"');
    expect(header).not.toContain('href="/settings/servers"');
  });

  test('the header search submits q and selects the home region', () => {
    const form = /<form\b[^>]*\brole="search"[^>]*>[\s\S]*?<\/form>/.exec(header)?.[0] ?? '';
    expect(form).toContain('data-testid="search"');
    expect(tagOf(form, 'search')).toContain('name="q"');
    expect(/^<form\b[^>]*>/.exec(form)?.[0]).toContain('hx-select="#home"');
  });

  test('the header wraps its content in a 1320 px column', () => {
    const classes = /^<header\b[^>]*>\s*<div\b[^>]*\bclass="([^"]*)"[^>]*>[\s\S]*<\/div>\s*<\/header>$/.exec(header)?.[1];
    expect(classes?.split(/\s+/) ?? []).toContain('max-w-[1320px]');
  });

  test('the main content is capped at 1320 px', () => {
    const classes = /<main\b[^>]*\bclass="([^"]*)"/.exec(page)?.[1];
    expect(classes?.split(/\s+/) ?? []).toContain('max-w-[1320px]');
  });

  test('the search input shows the current query', () => {
    const searchParams = { ...params, q: 'abc' };
    expect(tagOf(layout(searchParams), 'search') ?? '').toContain('value="abc"');
  });

  test('the New environment link shows the short label and keeps the full accessible name', () => {
    expect(newEnvLink).toContain(`>${i.t('env.newEnvShort')}</span>`);
    expect(tagOf(newEnvLink, 'env-new')).toContain(`aria-label="${i.t('env.newEnv')}"`);
  });

  test('has a lang select offering all 8 languages, the current one selected', () => {
    expect(tagOf(page, 'lang')).toMatch(/^<select/);
    const select = page.slice(page.indexOf('data-testid="lang"'), page.indexOf('</select>'));
    expect(select.match(/<option/g)).toHaveLength(LANGS.length);
    for (const lang of LANGS) expect(select).toContain(`value="${lang}"`);
    expect(/<option[^>]*value="de"[^>]*selected/.exec(select)).not.toBeNull();
  });

  test('the lang select posts to /lang with the csrf token as a hidden _csrf field', () => {
    expect(/<form[^>]*action="\/lang"[^>]*>/.exec(page)?.[0]).toMatch(/method="post"/i);
    const field = /<input[^>]*name="_csrf"[^>]*>/.exec(page)?.[0];
    expect(field).toContain('type="hidden"');
    expect(field).toContain('value="tok-123"');
  });

  test.each(LANGS)('the lang select is labelled from the catalog in %s', (lang) => {
    const li = i18n(lang);
    const label = li.t('nav.language');
    expect(label).not.toBe('nav.language');
    const out = layout({ i: li, title: 'Environments', csrf: 'tok-123', body: raw('') });
    expect(tagOf(out, 'lang')).toContain(`aria-label="${label}"`);
    if (lang !== 'en') expect(out).not.toContain('aria-label="Language"');
  });

  test('configures htmx to swap 4xx and 5xx responses as errors and skip 204', () => {
    const meta = /<meta[^>]*name="htmx-config"[^>]*>/.exec(page)?.[0];
    expect(meta).toBeDefined();
    const content = /content=(?:'([^']*)'|"([^"]*)")/.exec(meta!);
    const json = (content?.[1] ?? content?.[2] ?? '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    expect(JSON.parse(json)).toEqual({
      responseHandling: [
        { code: '204', swap: false },
        { code: '[23]..', swap: true },
        { code: '[45]..', swap: true, error: true },
      ],
    });
  });

  test('references the stylesheet and htmx and renders the body', () => {
    expect(page).toContain('/static/app.css');
    expect(page).toContain('/static/htmx.min.js');
    expect(page).toContain('id="body-marker"');
  });
});

describe('opProgressView', () => {
  const i = i18n('en');
  const steps = [
    { label: 'Pull image', done: true },
    { label: 'Recreate api', done: false },
  ];

  test('without doneSeconds there is no rollback-done and the running title shows', () => {
    const out = opProgressView(i, 'op-42', steps, null).__html;
    expect(out).not.toContain('rollback-done');
    expect(out).toContain(i.t('rb.running'));
    expect(out).toContain('Pull image');
    expect(out).toContain('Recreate api');
  });

  test('a done step is marked differently from a pending one', () => {
    const out = opProgressView(i, 'op-42', steps, null).__html;
    const items = out.match(/<li[^>]*>/g)!;
    expect(items).toHaveLength(2);
    expect(items[0]).not.toBe(items[1]);
  });

  test('with doneSeconds 12 rollback-done carries data-seconds and the finished text', () => {
    const out = opProgressView(i, 'op-42', steps, 12).__html;
    const done = tagOf(out, 'rollback-done');
    expect(done).toBeDefined();
    expect(done).toContain('data-seconds="12"');
    expect(out).toContain(i.t('rb.done', { s: i.unit(12, 'second') }));
  });

  test('listens to /ops/<opId>/events', () => {
    const out = opProgressView(i, 'op-42', steps, null).__html;
    expect(out).toContain('/ops/op-42/events');
  });

  test('a step label with markup is escaped', () => {
    const out = opProgressView(i, 'op-42', [{ label: EVIL, done: false }], null).__html;
    expect(out).not.toContain('<img');
    expect(out).toContain(EVIL_ESCAPED);
  });
});

describe('cleanupView', () => {
  const i = i18n('en');
  const pending = release({ id: 'r-blocked', sha: sha('3333333'), state: 'blocked', cleanupState: 'pending', cleanupPreview: RULES });
  const applied = (result: { rule: string; deleted: number }[]) =>
    release({ id: 'r-blocked', sha: sha('3333333'), state: 'blocked', cleanupState: 'applied', cleanupPreview: RULES, cleanupResult: result });
  const mismatch = i.t('codes.CLEANUP_MISMATCH', { expected: 50 });

  test('pending shows each rule with its count, an apply button with the total and a skip button', () => {
    const out = cleanupView(i, pending, 'csrf-token').__html;
    const at = (rule: string) => out.indexOf(`data-testid="cleanup-rule-${rule}"`);
    expect(at('promo-notifications')).toBeGreaterThanOrEqual(0);
    expect(at('promo-notifications')).toBeLessThan(at('stale-sessions'));
    expect(out.slice(at('promo-notifications'), at('stale-sessions'))).toContain('50');
    expect(out.slice(at('stale-sessions'), at('empty-rule'))).toContain('7');

    const apply = tagOf(out, 'cleanup-apply');
    expect(apply).toBeDefined();
    expect(isDisabled(apply!)).toBe(false);
    expect(out).toContain(i.t('cl.delete', { n: 57 }));
    expect(tagOf(out, 'cleanup-skip')).toBeDefined();
    expect(out).not.toContain('cleanup-result');
  });

  test('pending without a preview polls the panel of this release until the preview exists', () => {
    const waiting = release({ id: 'r-blocked', sha: sha('3333333'), state: 'blocked', cleanupState: 'pending', cleanupPreview: null });
    const out = cleanupView(i, waiting, 'csrf-token').__html;
    const tag = tagOf(out, 'cleanup-pending');
    expect(tag).toBeDefined();
    expect(tag).toContain('hx-get="/panel/r-blocked"');
    expect(tag).toContain('hx-target="#panel"');
    expect(tag).toContain('hx-trigger="every 2s"');
    expect(tag).toContain('hx-swap="innerHTML"');
    expect(i.t('cl.preparing')).not.toBe('cl.preparing');
    expect(out).toContain(i.t('cl.preparing'));
    expect(out).not.toContain('data-testid="cleanup-apply"');
    expect(tagOf(panelView(i, env('stage'), waiting, 'csrf-token', html``).__html, 'cleanup-pending')).toContain('hx-get="/panel/r-blocked"');
  });

  test('a failed dry-run shows the failure and a retry-preview button and does not poll', () => {
    const r = release({
      id: 'r-blocked',
      sha: sha('3333333'),
      state: 'blocked',
      cleanupState: 'pending',
      cleanupPreview: null,
      cleanupFailed: { code: 'MIGRATION_FAILED', params: { sha: '3333333', env: 'stage' } },
    });
    const out = cleanupView(i, r, 'csrf-token').__html;
    expect(out).not.toContain('data-testid="cleanup-pending"');
    expect(out).not.toContain('hx-trigger="every');
    expect(out).toContain(i.t('codes.MIGRATION_FAILED', { sha: '3333333', env: 'stage' }));
    const retry = tagOf(out, 'cleanup-retry');
    expect(retry).toBeDefined();
    expect(out).toContain('hx-post="/cleanup/preview"');
    expect(out).toMatch(/<input type="hidden" name="releaseId" value="r-blocked">/);
    expect(out).toContain('csrf-token');
  });

  test.each(LANGS)('the retry-preview button is labelled from the catalog in %s', (lang) => {
    const r = release({ cleanupState: 'pending', cleanupPreview: null, cleanupFailed: { code: 'MIGRATION_FAILED', params: {} } });
    const out = cleanupView(i18n(lang), r, 'csrf-token').__html;
    const label = new RegExp('<[^>]*data-testid="cleanup-retry"[^>]*>([^<]*)<').exec(out)?.[1]?.trim();
    expect(label).toBeTruthy();
    expect(label).not.toMatch(KEY_SHAPED);
  });

  test('a hostile parameter of a failed dry-run is escaped exactly once', () => {
    const r = release({ cleanupState: 'pending', cleanupPreview: null, cleanupFailed: { code: 'MIGRATION_FAILED', params: { sha: EVIL, env: 'stage' } } });
    const out = cleanupView(i, r, 'csrf-token').__html;
    expect(out).not.toContain('<img');
    expect(out).toContain(EVIL_ESCAPED);
    expect(out).not.toContain('&amp;lt;');
  });

  test('pending with a preview renders the rules and stops polling', () => {
    const out = cleanupView(i, pending, 'csrf-token').__html;
    expect(out).toContain('data-testid="cleanup-rule-promo-notifications"');
    expect(out).toContain('data-testid="cleanup-apply"');
    expect(out).not.toContain('data-testid="cleanup-pending"');
    expect(out).not.toContain('hx-trigger="every');
  });

  test('a rule description with markup is escaped', () => {
    const r = release({ cleanupState: 'pending', cleanupPreview: [{ rule: 'x', description: EVIL, count: 1 }] });
    const out = cleanupView(i, r, 'csrf-token').__html;
    expect(out).not.toContain('<img');
    expect(out).toContain(EVIL_ESCAPED);
  });

  test('applied shows cleanup-result with expected and deleted only for applied rules', () => {
    const out = cleanupView(i, applied([{ rule: 'promo-notifications', deleted: 50 }]), 'csrf-token').__html;
    expect(tagOf(out, 'cleanup-result')).toBeDefined();
    expect(out).toContain(i.t('cl.result', { rule: 'promo-notifications', p: 50, a: 50 }));
    expect(out).not.toContain('stale-sessions');
    expect(out).not.toContain('cleanup-apply');
  });

  test('applied without a mismatch shows no warning', () => {
    expect(mismatch).not.toBe('codes.CLEANUP_MISMATCH');
    const out = cleanupView(i, applied([{ rule: 'promo-notifications', deleted: 50 }]), 'csrf-token').__html;
    expect(out).not.toContain(mismatch);
  });

  test('applied with deleted different from the preview shows both numbers and the mismatch warning', () => {
    const out = cleanupView(i, applied([{ rule: 'promo-notifications', deleted: 43 }]), 'csrf-token').__html;
    expect(out).toContain(i.t('cl.result', { rule: 'promo-notifications', p: 50, a: 43 }));
    expect(out).toContain(mismatch);
  });

  test('applied with several rules warns only about the one that differs', () => {
    const out = cleanupView(
      i,
      applied([
        { rule: 'promo-notifications', deleted: 50 },
        { rule: 'stale-sessions', deleted: 5 },
      ]),
      'csrf-token',
    ).__html;
    expect(out).toContain(i.t('cl.result', { rule: 'stale-sessions', p: 7, a: 5 }));
    expect(out).toContain(i.t('codes.CLEANUP_MISMATCH', { expected: 7 }));
    expect(out).not.toContain(mismatch);
  });

  const categoryTemplate = (lang: Lang, category: string) => {
    const li = i18n(lang);
    const rules = new Intl.PluralRules(lang);
    const n = Array.from({ length: 200 }, (_, k) => k).find((k) => rules.select(k) === category);
    return n === undefined ? undefined : li.t('cl.delete', { n }).replace(li.num(n), '{n}');
  };

  test.each(['en', 'uk', 'zh-CN'] as const)('the apply label carries one {n} template per plural category in %s and no subset map', (lang) => {
    const out = cleanupView(i18n(lang), pending, 'csrf-token').__html;
    expect(out).not.toContain('data-labels');
    expect(out).toContain('Intl.PluralRules');
    for (const category of new Intl.PluralRules(lang).resolvedOptions().pluralCategories) {
      const value = new RegExp(`data-label-${category}="([^"]*)"`).exec(out)?.[1];
      expect(value, category).toBeDefined();
      expect(value, category).toContain('{n}');
      const expected = categoryTemplate(lang, category);
      if (expected !== undefined) expect(value, category).toBe(expected);
    }
  });

  test('30 rules render in under 200 ms', () => {
    const rules = Array.from({ length: 30 }, (_, k) => ({ rule: `rule-${k}`, description: `Rule ${k}`, count: k < 18 ? 2 ** k : k - 17 }));
    const r = release({ cleanupState: 'pending', cleanupPreview: rules });
    const started = performance.now();
    const out = cleanupView(i, r, 'csrf-token').__html;
    expect(performance.now() - started).toBeLessThan(200);
    expect(out.match(/data-testid="cleanup-rule-/g)).toHaveLength(30);
    expect(out).not.toContain('data-labels');
  });
});

describe('panelView', () => {
  const i = i18n('en');

  test('for production rollback-go asks for confirmation before submitting', () => {
    const prod = env('prod');
    const out = panelView(i, prod, prod.releases[0]!, 'csrf-token', html``).__html;
    expect(tagOf(out, 'confirm-ask')).toMatch(/\bhidden\b/);
    expect(tagOf(out, 'confirm-yes')).toContain('type="submit"');
    expect(tagOf(out, 'rollback-go')).toContain('type="button"');
    expect(out).toContain(i.t('confirm.ask'));
  });

  test('for production the confirm step moves focus to Yes and back to the main button', () => {
    const prod = env('prod');
    const out = panelView(i, prod, prod.releases[0]!, 'csrf-token', html``).__html;
    expect(tagOf(out, 'rollback-go')).toContain('querySelector(&#39;[type=submit]&#39;).focus()');
    expect(tagOf(out, 'confirm-no')).toContain('focus()');
  });

  test('the active release rolls back to the available one with the highest activationSeq', () => {
    const first = release({ id: 'r-seq1', state: 'available', activationSeq: 1 });
    const third = release({ id: 'r-seq3', state: 'available', activationSeq: 3 });
    const active = release({ id: 'r-act', state: 'active', activationSeq: 4 });
    const stage = env('stage', { releases: [active, first, third] });
    const out = panelView(i, stage, active, 'csrf-token', html``).__html;
    expect(out).toContain('<input type="hidden" name="releaseId" value="r-seq3">');
    expect(out).not.toContain('name="releaseId" value="r-seq1"');
  });

  test('the active release offers no rollback without an available release', () => {
    const active = release({ id: 'r-act', state: 'active', activationSeq: 2 });
    const stage = env('stage', { releases: [active, release({ id: 'r-exp', state: 'expired', activationSeq: 1 })] });
    const out = panelView(i, stage, active, 'csrf-token', html``).__html;
    expect(out).not.toContain('data-testid="rollback-go"');
  });

  test('an available release offers switching, the active one offers rollback to the previous build', () => {
    const older = release({ id: 'r-old', state: 'available', activationSeq: 1 });
    const active = release({ id: 'r-act', state: 'active', activationSeq: 2 });
    const stage = env('stage', { releases: [active, older] });
    const onOld = panelView(i, stage, older, 'csrf-token', html``).__html;
    expect(onOld).toContain(i.t('rb.switch'));
    const onActive = panelView(i, stage, active, 'csrf-token', html``).__html;
    expect(onActive).toContain(i.t('rb.go'));
    expect(onActive).toContain('value="r-old"');
    expect(onActive).not.toContain(i.t('rb.switch'));
  });

  test('has an empty alert slot that rejections are retargeted into', () => {
    const stage = env('stage');
    const out = panelView(i, stage, stage.releases[0]!, 'csrf-token', html``).__html;
    expect(out).toMatch(/<div[^>]*id="panel-alert"[^>]*><\/div>/);
    expect(out.match(/id="panel-alert"/g)).toHaveLength(1);
  });

  test.each([
    ['active', false, true],
    ['available', false, true],
    ['available', true, false],
    ['expired', false, false],
    ['blocked', false, false],
  ] as const)('a %s release with stored=%s shows the storage warning: %s', (state, stored, shown) => {
    const r = release({ state, stored });
    const out = panelView(i, env('stage', { releases: [r] }), r, 'csrf-token', html``).__html;
    expect(out.includes(i.t('storage.failedWarn'))).toBe(shown);
  });

  test('for stage rollback-go is enabled', () => {
    const stage = env('stage');
    const out = panelView(i, stage, stage.releases[0]!, 'csrf-token', html``).__html;
    const go = tagOf(out, 'rollback-go');
    expect(go).toBeDefined();
    expect(isDisabled(go!)).toBe(false);
  });

  test('a marker warning disables rollback and shows the rb.noMarker text', () => {
    const noMarker = i.t('rb.noMarker');
    expect(noMarker).not.toBe('rb.noMarker');

    const stage = env('stage', { markerWarnings: [{ svc: 'api', other: 'prod', url: 'postgres://db-host/shop' }] });
    const out = panelView(i, stage, stage.releases[0]!, 'csrf-token', html``).__html;
    const go = tagOf(out, 'rollback-go');
    expect(go).toBeDefined();
    expect(isDisabled(go!)).toBe(true);
    expect(out).toContain(noMarker);

    const clean = env('stage');
    const cleanOut = panelView(i, clean, clean.releases[0]!, 'csrf-token', html``).__html;
    expect(cleanOut).not.toContain(noMarker);
  });

  test('a commit message with markup is escaped in the panel', () => {
    const stage = env('stage', { releases: [release({ message: EVIL })] });
    const out = panelView(i, stage, stage.releases[0]!, 'csrf-token', html``).__html;
    expect(out).not.toContain('<img');
    expect(out).toContain(EVIL_ESCAPED);
  });

  test('a failed release rejected for a destructive schema change offers approve-destructive', () => {
    const failed = release({
      id: 'r-bad',
      state: 'failed',
      windowLeftMs: null,
      windowPct: null,
      failNote: { code: 'SCHEMA_DESTRUCTIVE', params: { col: 'users.email' } },
    });
    const stage = env('stage', { releases: [failed] });
    const out = panelView(i, stage, failed, 'csrf-token', html``).__html;
    expect(tagOf(out, 'approve-destructive')).toBeDefined();
    expect(out).toContain(i.t('codes.SCHEMA_DESTRUCTIVE', { col: 'users.email' }));
    expect(out).not.toContain('data-testid="rollback-go"');
  });

  test('an available release does not offer approve-destructive', () => {
    const stage = env('stage');
    const out = panelView(i, stage, stage.releases[0]!, 'csrf-token', html``).__html;
    expect(out).not.toContain('approve-destructive');
  });

  test('an available release does not offer to close the rollback window', () => {
    const stage = env('stage');
    const out = panelView(i, stage, stage.releases[0]!, 'csrf-token', html``).__html;
    expect(out).not.toContain('/close-window');
    expect(out).not.toContain('data-testid="close-window"');
  });

  test('the will-block list is the active release plus available releases activated after the target', () => {
    const target = release({ id: 'r-t', sha: sha('2222222'), state: 'available', deployedAt: NOW - 2 * DAY, activationSeq: 2 });
    const active = release({ id: 'r-a', sha: sha('1111111'), state: 'active', deployedAt: NOW - 5 * DAY, activationSeq: 5, windowLeftMs: null, windowPct: null });
    const later = release({ id: 'r-b', sha: sha('3333333'), state: 'available', deployedAt: NOW - 3 * DAY, activationSeq: 4 });
    const earlier = release({ id: 'r-c', sha: sha('4444444'), state: 'available', deployedAt: NOW - HOUR, activationSeq: 1 });
    const stage = env('stage', { releases: [earlier, active, later, target] });
    const out = panelView(i, stage, target, 'csrf-token', html``).__html;
    const from = out.indexOf(i.t('rb.willBlock'));
    expect(from).toBeGreaterThanOrEqual(0);
    const list = out.slice(from, out.indexOf('</div>', from));
    expect(list).toContain('1111111');
    expect(list).toContain('3333333');
    expect(list).not.toContain('4444444');
    expect(list).not.toContain('2222222');
  });

  test('a missing activationSeq counts as 0 when choosing what the rollback blocks', () => {
    const target = release({ id: 'r-t', sha: sha('2222222'), state: 'available', activationSeq: null });
    const activated = release({ id: 'r-b', sha: sha('3333333'), state: 'available', activationSeq: 1 });
    const never = release({ id: 'r-c', sha: sha('4444444'), state: 'available', activationSeq: null });
    const active = release({ id: 'r-a', sha: sha('1111111'), state: 'active', activationSeq: null, windowLeftMs: null, windowPct: null });
    const stage = env('stage', { releases: [active, activated, never, target] });
    const out = panelView(i, stage, target, 'csrf-token', html``).__html;
    const from = out.indexOf(i.t('rb.willBlock'));
    const list = out.slice(from, out.indexOf('</div>', from));
    expect(list).toContain('1111111');
    expect(list).toContain('3333333');
    expect(list).not.toContain('4444444');
  });

  test('the approval warning lists every available release of the env and no other', () => {
    const quiet = { windowLeftMs: null, windowPct: null };
    const bad = release({ id: 'r-bad', sha: sha('fffffff'), state: 'failed', ...quiet, failNote: { code: 'SCHEMA_DESTRUCTIVE', params: { col: 'users.email' } } });
    const stage = env('stage', {
      releases: [
        bad,
        release({ id: 'r-act', sha: sha('3333333'), state: 'active', ...quiet }),
        release({ id: 'r-a1', sha: sha('1111111'), state: 'available' }),
        release({ id: 'r-a2', sha: sha('2222222'), state: 'available' }),
        release({ id: 'r-exp', sha: sha('4444444'), state: 'expired', ...quiet }),
        release({ id: 'r-blk', sha: sha('5555555'), state: 'blocked', ...quiet }),
      ],
    });
    const out = panelView(i, stage, bad, 'csrf-token', html``).__html;
    const at = out.lastIndexOf(i.t('approve.title'));
    expect(at).toBeGreaterThanOrEqual(0);
    const section = out.slice(at);
    expect(section).toContain(i.t('approve.expires', { list: '1111111, 2222222' }));
    for (const other of ['3333333', '4444444', '5555555']) expect(section).not.toContain(other);
  });
});

describe('production tag', () => {
  test.each(LANGS)('env.prodTag marks production only, in %s', (lang) => {
    const li = i18n(lang);
    const tag = li.t('env.prodTag');
    expect(tag).not.toBe('env.prodTag');
    const prod = env('prod');
    const stage = env('stage');
    const homeIndex = (e: EnvVM) => {
      const out = homeView(li, homeVmFrom([e]), NOW).__html;
      return out.slice(out.indexOf('data-testid="env-index"'));
    };
    const prodViews = [
      homeIndex(prod),
      envView(li, prod, NOW, parts).__html,
      panelView(li, prod, prod.releases[0]!, 'csrf-token', html``).__html,
    ];
    for (const out of prodViews) expect(out).toContain(`>${tag}<`);
    const stageViews = [
      homeIndex(stage),
      envView(li, stage, NOW, parts).__html,
      panelView(li, stage, stage.releases[0]!, 'csrf-token', html``).__html,
    ];
    for (const out of stageViews) expect(out).not.toContain(`>${tag}<`);
  });
});

describe('every view in every language', () => {
  const failed = (id: string, code: string, params: Record<string, string | number> = {}) =>
    release({ id, sha: sha(id), state: 'failed', windowLeftMs: null, windowPct: null, failNote: { code, params } });

  const releases = [
    release({ id: '1111111', sha: sha('1111111'), state: 'active', windowLeftMs: null, windowPct: null }),
    release({ id: '2222222', sha: sha('2222222'), state: 'available', deployedAt: NOW - 2 * HOUR }),
    release({ id: '3333333', sha: sha('3333333'), state: 'available', deployedAt: NOW - 3 * DAY }),
    release({
      id: '4444444',
      sha: sha('4444444'),
      state: 'blocked',
      blocked: { at: NOW - HOUR, to: sha('1111111') },
      windowLeftMs: null,
      windowPct: null,
      cleanupState: 'pending',
      cleanupPreview: RULES,
    }),
    release({
      id: '5555555',
      sha: sha('5555555'),
      state: 'blocked',
      windowLeftMs: null,
      windowPct: null,
      cleanupState: 'applied',
      cleanupPreview: RULES,
      cleanupResult: [
        { rule: 'promo-notifications', deleted: 43 },
        { rule: 'stale-sessions', deleted: 7 },
      ],
    }),
    release({ id: '6666666', sha: sha('6666666'), state: 'expired', windowLeftMs: null, windowPct: null }),
    release({ id: 'bbbbbbb', sha: sha('bbbbbbb'), state: 'blocked', windowLeftMs: null, windowPct: null, cleanupState: 'pending', cleanupPreview: null }),
    failed('7777777', 'SCHEMA_DESTRUCTIVE', { col: 'users_email' }),
    failed('8888888', 'CONTRACT_FAILED', { sha: '8888888', env: 'prod' }),
    failed('9999999', 'STORAGE_FAILED'),
    failed('aaaaaaa', 'IMAGE_PULL_FAILED', { svc: 'api' }),
    release({ id: 'ccccccc', sha: sha('ccccccc'), state: 'available', stored: false, deployedAt: NOW - 4 * DAY }),
    release({
      id: 'ddddddd',
      sha: sha('ddddddd'),
      state: 'blocked',
      windowLeftMs: null,
      windowPct: null,
      cleanupState: 'pending',
      cleanupPreview: null,
      cleanupFailed: { code: 'MIGRATION_FAILED', params: { sha: 'ddddddd', env: 'prod' } },
    }),
  ];

  const ops = [
    op({ kind: 'deploy', status: 'ok' }),
    op({ kind: 'rollback', actor: 'system', durationS: 30 }),
    op({ kind: 'cleanup', actor: 'ci:github', durationS: null }),
    op({ kind: 'contract', status: 'failed', reason: { code: 'CONTRACT_FAILED', params: { sha: '8888888', env: 'prod' } } }),
    op({ kind: 'expire' }),
    op({ status: 'rejected', reason: { code: 'COMMIT_BLOCKED', params: { sha: '4444444', env: 'prod', at: NOW - DAY } } }),
    op({ status: 'rejected', reason: { code: 'SCHEMA_DESTRUCTIVE', params: { col: 'users_email' } } }),
    op({ status: 'failed', reason: { code: 'CLEANUP_MISMATCH', params: { expected: 50 } } }),
    op({ kind: 'approve', from: '—' }),
    op({ kind: 'cleanup', status: 'ok', reason: { code: 'CLEANUP_MISMATCH', params: { expected: 3, deleted: 2 } } }),
  ];

  test.each(LANGS)('renders in %s without raw catalog keys', (lang) => {
    const li = i18n(lang);
    const prod = env('prod', { releases });
    const offline = env('stage', {
      agentOnline: false,
      builtin: true,
      markerWarnings: [{ svc: 'api', other: 'prod', url: 'postgres://db-host/shop' }],
    });

    expectNoRawKeys(lang, 'envView prod', envView(li, prod, NOW, parts).__html);
    expectNoRawKeys(lang, 'envView stage', envView(li, offline, NOW, parts).__html);
    expectNoRawKeys(lang, 'releaseHistory', releaseHistory(li, ops).__html);
    expectNoRawKeys(lang, 'newEnvView', newEnvView(li, html``).__html);
    for (const r of releases) {
      expectNoRawKeys(lang, `panelView prod ${r.id}`, panelView(li, prod, r, 'csrf-token', html``).__html);
      expectNoRawKeys(lang, `cleanupView ${r.id}`, cleanupView(li, r, 'csrf-token').__html);
    }
    expectNoRawKeys(lang, 'panelView offline', panelView(li, offline, offline.releases[0]!, 'csrf-token', html``).__html);
    expectNoRawKeys(lang, 'homeView', homeView(li, homeVmFrom([prod, offline]), NOW).__html);
  });
});
