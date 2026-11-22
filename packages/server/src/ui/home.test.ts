import { describe, expect, test } from 'vitest';
import { LANGS, allKeys, i18n, type Lang } from '@microrun/core/i18n';
import type { ReleaseState } from '@microrun/core/state';
import { html } from './html.ts';
import type { EnvVM, ReleaseVM } from './board.ts';
import { envView } from './env.ts';
import { envDot, homeView, type FeedRowVM, type HomeVM } from './home.ts';

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const sha = (k: number) => k.toString(16).padStart(7, '0').padEnd(40, 'e');

function row(k: number): FeedRowVM {
  return {
    id: `r${k}`,
    envId: `e${k % 100}`,
    envName: `env-${k % 100}`,
    isProduction: k % 100 < 10,
    sha: sha(k),
    message: `msg ${k}`,
    author: 'dev',
    deployedAt: NOW - k * MIN,
    state: 'available',
    schemaChange: false,
  };
}

const vm: HomeVM = {
  q: '',
  only: 'all',
  feed: Array.from({ length: 25 }, (_, k) => row(k)),
  rest: 975,
  next: `${NOW - 24 * MIN}.r24`,
  envs: Array.from({ length: 100 }, (_, k) => ({ id: `e${k}`, name: `env-${k}`, isProduction: k % 10 === 0, dot: 'ok' as const })),
};

const after = (out: string, marker: string) => out.slice(out.indexOf(marker));

function expectNoRawKeys(lang: Lang, out: string) {
  const keys = allKeys()[lang].filter((k) => /^[a-z]+(\.\w+)+$/.test(k));
  expect(keys).toContain('home.feed');
  for (const key of keys) expect(out, `${lang}: ${key}`).not.toContain(key);
  expect(out, `${lang}: undefined`).not.toMatch(/undefined|NaN/);
}

describe('homeView', () => {
  const i = i18n('en');
  const out = homeView(i, vm, NOW).__html;

  test('renders one page of 25 feed rows that open the release panel', () => {
    expect(out.match(/data-testid="rel-/g)).toHaveLength(25);
    expect(out).toContain(`data-testid="rel-env-0-${sha(0).slice(0, 7)}"`);
    expect(out).toContain('hx-get="/panel/r0"');
    expect(out).toContain('data-state="available"');
  });

  test('offers the next page with the count left', () => {
    expect(out).toContain('data-testid="feed-more"');
    expect(out).toContain('975 not shown');
    expect(out).toContain(`hx-get="/feed?before=${encodeURIComponent(vm.next!)}`);
  });

  test('the next page keeps the search and the filter', () => {
    const filtered = homeView(i, { ...vm, q: 'pay me', only: 'prod' }, NOW).__html;
    const tag = /<[^>]*data-testid="feed-more"[^>]*>/.exec(filtered)?.[0] ?? '';
    expect(tag).toContain('q=pay%20me');
    expect(tag).toContain('only=prod');
  });

  test('each environment shows its status as text for screen readers and on hover', () => {
    const dots = homeView(i, { ...vm, envs: [
      { id: 'e1', name: 'one', isProduction: false, dot: 'ok' },
      { id: 'e2', name: 'two', isProduction: false, dot: 'warn' },
      { id: 'e3', name: 'three', isProduction: false, dot: 'mismatch' },
      { id: 'e4', name: 'four', isProduction: false, dot: 'offline' },
    ] }, NOW).__html;
    const link = (name: string) => new RegExp(`<a[^>]*data-testid="env-link-${name}"[\\s\\S]*?</a>`).exec(dots)?.[0] ?? '';
    expect(link('one')).toContain('Running normally');
    expect(link('two')).toContain('Needs a look');
    expect(link('three')).toContain('Connected to another environment’s database');
    expect(link('four')).toContain('Agent offline');
    expect(link('two')).not.toContain('Running normally');
  });

  test('has no more button when nothing is left', () => {
    const last = homeView(i, { ...vm, rest: 0, next: null }, NOW).__html;
    expect(last).not.toContain('data-testid="feed-more"');
  });

  test('lists every environment, production group first, each group in the given order', () => {
    const index = after(out, 'data-testid="env-index"');
    expect(index.match(/data-testid="env-link-/g)).toHaveLength(100);
    expect(index.indexOf('Production')).toBeLessThan(index.indexOf('Other environments'));
    expect(index.indexOf('Other environments')).toBeLessThan(index.indexOf('data-testid="env-link-env-1"'));
    expect(index.indexOf('data-testid="env-link-env-0"')).toBeLessThan(index.indexOf('data-testid="env-link-env-10"'));
    expect(index.indexOf('data-testid="env-link-env-10"')).toBeLessThan(index.indexOf('Other environments'));
    expect(index.indexOf('data-testid="env-link-env-1"')).toBeLessThan(index.indexOf('data-testid="env-link-env-2"'));
    expect(index).toContain('href="/env/e0"');
  });

  test('explains an empty search', () => {
    const none = homeView(i, { ...vm, q: 'zz', feed: [], rest: 0, next: null, envs: [] }, NOW).__html;
    expect(none).toContain('No environment, branch or commit matches “zz”.');
    expect(none).not.toContain('data-testid="rel-');
  });

  test('every language has text for every string', () => {
    for (const lang of LANGS) {
      const li = i18n(lang);
      expectNoRawKeys(lang, homeView(li, vm, NOW).__html);
      expectNoRawKeys(lang, homeView(li, { ...vm, q: 'zz', feed: [], rest: 0, next: null, envs: [] }, NOW).__html);
      expectNoRawKeys(lang, homeView(li, { ...vm, q: '', feed: [], rest: 0, next: null }, NOW).__html);
    }
  });
});

describe('envDot', () => {
  const base = { mismatch: false, online: true, busy: false, latest: 'active' as ReleaseState | null, activeUnstored: false, contractFailed: false };

  test('follows the status priority', () => {
    expect(envDot(base)).toBe('ok');
    expect(envDot({ ...base, mismatch: true, online: false })).toBe('mismatch');
    expect(envDot({ ...base, online: false, latest: 'failed' })).toBe('offline');
    expect(envDot({ ...base, latest: 'failed' })).toBe('warn');
    expect(envDot({ ...base, activeUnstored: true })).toBe('warn');
    expect(envDot({ ...base, contractFailed: true })).toBe('warn');
    expect(envDot({ ...base, latest: null })).toBe('ok');
  });

  test('a deploy in progress and a deliberate rollback are not problems', () => {
    expect(envDot({ ...base, latest: 'failed', busy: true })).toBe('ok');
    expect(envDot({ ...base, latest: 'blocked' })).toBe('ok');
    expect(envDot({ ...base, activeUnstored: true, busy: true })).toBe('ok');
    expect(envDot({ ...base, contractFailed: true, busy: true })).toBe('ok');
  });

  test('a running operation does not hide a mismatch or an offline agent', () => {
    expect(envDot({ ...base, busy: true, online: false })).toBe('offline');
    expect(envDot({ ...base, busy: true, mismatch: true })).toBe('mismatch');
  });
});

function release(k: number, state: ReleaseState, over: Partial<ReleaseVM> = {}): ReleaseVM {
  return {
    id: `rel-${k}`,
    sha: sha(0x500 + k),
    message: `change ${k}`,
    author: 'dmytro',
    deployedAt: NOW - k * HOUR,
    state,
    windowLeftMs: state === 'available' ? 5 * DAY : null,
    windowPct: state === 'available' ? 50 : null,
    diff: [],
    blocked: null,
    failNote: null,
    cleanupState: 'none',
    cleanupPreview: null,
    cleanupResult: null,
    activationSeq: null,
    imagePurged: state === 'expired',
    stored: true,
    storing: false,
    cleanupFailed: null,
    ...over,
  };
}

function env(releases: ReleaseVM[]): EnvVM {
  return {
    id: 'env-x',
    name: 'x',
    branch: 'main',
    isProduction: false,
    retentionS: 7 * 86_400,
    agentOnline: true,
    serverName: 'build-host',
    builtin: false,
    composeProject: 'shop-x',
    services: [{ name: 'api', strategy: 'recreate' }],
    db: 'postgres',
    storage: { kind: 's3', target: 'releases' },
    markerWarnings: [],
    releases,
  };
}

const parts = { settings: html`<p>S</p>` };
const rel7 = (r: ReleaseVM) => `data-testid="rel-x-${r.sha.slice(0, 7)}"`;
const topTable = (out: string) => out.slice(out.indexOf('data-testid="env-in-window"'), out.indexOf('data-testid="env-older"'));

describe('envView release tables', () => {
  const i = i18n('en');

  test('shows the live and rollback-ready releases and folds the 125 older ones', () => {
    const rs = Array.from({ length: 140 }, (_, k) => release(k, k === 0 ? 'active' : k < 15 ? 'available' : 'expired'));
    const out = envView(i, env(rs), NOW, parts).__html;
    expect(out.match(/data-testid="rel-/g)).toHaveLength(15);
    expect(out).toContain('data-testid="env-in-window"');
    expect(out).toContain('data-testid="env-older"');
    expect(out).toContain('data-testid="env-older-more"');
    expect(out).toContain('Show 20 older');
    expect(out).toContain('125 not shown');
    expect(out).toContain('hx-get="/env/env-x/older"');
    expect(out).not.toContain(rel7(rs[15]!));
  });

  test('a failed deploy newer than the live release stays on top, an old rolled-back one is folded', () => {
    const failed = release(0, 'failed');
    const active = release(1, 'active');
    const available = release(2, 'available');
    const oldBlocked = release(3, 'blocked');
    const expired = release(4, 'expired');
    const out = envView(i, env([failed, active, available, oldBlocked, expired]), NOW, parts).__html;
    const top = topTable(out);
    for (const r of [failed, active, available]) expect(top).toContain(rel7(r));
    expect(out).not.toContain(rel7(oldBlocked));
    expect(out).not.toContain(rel7(expired));
    expect(out).toContain('2 not shown');
  });

  test('without a live release only the latest one is on top', () => {
    const rs = [release(0, 'failed'), release(1, 'failed'), release(2, 'failed')];
    const out = envView(i, env(rs), NOW, parts).__html;
    expect(out.match(/data-testid="rel-/g)).toHaveLength(1);
    expect(out).toContain(rel7(rs[0]!));
  });

  test('no older section when every release is on top', () => {
    const out = envView(i, env([release(0, 'active'), release(1, 'available')]), NOW, parts).__html;
    expect(out).not.toContain('data-testid="env-older-more"');
    expect(out).not.toContain('data-testid="env-older"');
  });
});
