import type { I18n } from '@microrun/core/i18n';
import type { ReleaseState } from '@microrun/core/state';
import { prodTag, releaseBadge, short } from './board.ts';
import { button } from './form.ts';
import { html, tr, type Html } from './html.ts';

export type EnvDot = 'ok' | 'warn' | 'mismatch' | 'offline';

export interface FeedRowVM {
  id: string;
  envId: string;
  envName: string;
  isProduction: boolean;
  sha: string;
  message: string;
  author: string;
  deployedAt: number;
  state: ReleaseState;
  schemaChange: boolean;
}

export interface IndexEnvVM {
  id: string;
  name: string;
  isProduction: boolean;
  dot: EnvDot;
}

export interface HomeVM {
  q: string;
  only: 'all' | 'prod';
  feed: FeedRowVM[];
  rest: number;
  next: string | null;
  envs: IndexEnvVM[];
}

export function envDot(s: { mismatch: boolean; online: boolean; busy: boolean; latest: ReleaseState | null; activeUnstored: boolean; contractFailed: boolean }): EnvDot {
  if (s.mismatch) return 'mismatch';
  if (!s.online) return 'offline';
  if (!s.busy && (s.latest === 'failed' || s.activeUnstored || s.contractFailed)) return 'warn';
  return 'ok';
}

const DOT_CLASS: Record<EnvDot, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  mismatch: 'bg-prod',
  offline: 'border-2 border-warn bg-transparent',
};

const HEADING = 'mb-2.5 flex items-baseline gap-2 font-display text-lg font-bold';
const EMPTY = 'rounded-lg border border-dashed border-line p-6 text-center text-mute';

function feedRow(i: I18n, r: FeedRowVM, now: number): Html {
  const sha = short(r.sha);
  return html`<li><a class="grid grid-cols-[74px_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1 px-3 py-2.5 hover:bg-bg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent aria-[current=true]:bg-bg aria-[current=true]:shadow-[inset_3px_0_0_var(--accent)] max-[760px]:grid-cols-[minmax(0,1fr)_auto]" data-testid="rel-${r.envName}-${sha}" data-release="${r.id}" data-state="${r.state}" hx-get="/panel/${r.id}" hx-target="#panel" hx-trigger="click, keydown[key=='Enter']" tabindex="0" role="button">
<span class="whitespace-nowrap text-xs text-mute max-[760px]:col-span-full">${i.ago(r.deployedAt, now)}</span>
<span class="wrap-anywhere"><span class="font-semibold${r.isProduction ? ' text-prod' : ''}">${r.envName}</span> <span class="font-mono">${sha}</span> ${r.message}<small class="block text-xs text-mute">${r.author}${r.schemaChange && html` · ${tr(i, 'col.schema')}`}</small></span>
${releaseBadge(i, r.state)}</a></li>`;
}

export function feedPage(i: I18n, vm: Pick<HomeVM, 'q' | 'only' | 'feed' | 'rest' | 'next'>, now: number): Html {
  const { q, only, feed, rest, next } = vm;
  return html`${feed.map((r) => feedRow(i, r, now))}${rest > 0 && next && html`<li class="p-2.5">${button({
    type: 'button',
    testid: 'feed-more',
    variant: 'ghost',
    block: true,
    label: html`${tr(i, 'home.more')} <span class="ml-auto pl-2 font-normal text-mute">${tr(i, 'home.notShown', { n: rest })}</span>`,
    attrs: html` hx-get="/feed?before=${encodeURIComponent(next)}&q=${encodeURIComponent(q.toWellFormed())}&only=${only}" hx-target="closest li" hx-swap="outerHTML"`,
  })}</li>`}`;
}

function indexGroup(i: I18n, members: IndexEnvVM[], heading: Html | null): Html | null {
  if (!members.length) return null;
  return html`<div><h3 class="mb-1 flex items-center justify-between gap-2 text-sm text-mute">${heading}<span>${i.num(members.length)}</span></h3>
<ul class="columns-2 gap-4">${members.map((e) => {
    const status = tr(i, `home.dot.${e.dot}`);
    return html`<li class="break-inside-avoid"><a href="/env/${e.id}" data-testid="env-link-${e.name}" class="flex items-center gap-2 py-0.5 hover:underline"><span class="size-2 shrink-0 rounded-full ${DOT_CLASS[e.dot]}" title="${status}"><span class="sr-only">${status}</span></span><span class="truncate">${e.name}</span></a></li>`;
  })}</ul></div>`;
}

const trackOpenRelease = html`<script>(function(){
  const home = document.currentScript.parentElement;
  function watchPanel() {
    const panel = document.getElementById('panel');
    if (!panel || !home.isConnected) return;
    function markCurrent() {
      const id = panel.firstElementChild?.dataset.release;
      const row = id && home.querySelector('[data-release="' + CSS.escape(id) + '"]');
      home.querySelector('[aria-current="true"]')?.removeAttribute('aria-current');
      if (row) row.setAttribute('aria-current', 'true');
    }
    const observer = new MutationObserver(markCurrent);
    observer.observe(panel, { childList: true });
    document.body.addEventListener('htmx:afterSwap', markCurrent);
    home.addEventListener('htmx:beforeCleanupElement', function(e) {
      if (e.target !== home) return;
      observer.disconnect();
      document.body.removeEventListener('htmx:afterSwap', markCurrent);
    });
    markCurrent();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchPanel, { once: true });
  else queueMicrotask(watchPanel);
})()</script>`;

export function homeView(i: I18n, vm: HomeVM, now: number): Html {
  const { q, only, feed, envs } = vm;
  const production = envs.filter((e) => e.isProduction);
  const other = envs.filter((e) => !e.isProduction);
  const noMatch = tr(i, 'search.none', { q });
  return html`<div id="home" class="grid grid-cols-1 gap-7 min-[901px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] items-start">
<section data-testid="feed"><h2 class="${HEADING}">${tr(i, 'home.feed')}</h2>
<div class="mb-2.5 flex flex-wrap gap-1.5">${(['all', 'prod'] as const).map((value) =>
    html`<a href="/?only=${value}&q=${encodeURIComponent(q.toWellFormed())}" aria-pressed="${String(only === value)}" class="rounded-full border border-line bg-surface px-3 py-0.5 text-sm aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-surface">${tr(i, value === 'all' ? 'home.filterAll' : 'home.filterProd')}</a>`,
  )}</div>
${feed.length ? html`<ul class="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">${feedPage(i, vm, now)}</ul>` : html`<p class="${EMPTY}">${q && !envs.length ? html`${noMatch} <a href="/" class="text-accent underline">${tr(i, 'search.clear')}</a>` : tr(i, only === 'prod' ? 'home.prodEmpty' : 'home.feedEmpty')}</p>`}</section>
<section data-testid="env-index"><h2 class="${HEADING}">${tr(i, 'home.envs')} <span class="font-sans text-sm font-medium">${i.num(envs.length)}</span></h2>
<div class="flex flex-col gap-3.5">${production[0] && indexGroup(i, production, prodTag(i, production[0]))}${indexGroup(i, other, tr(i, 'home.other'))}${q && !envs.length && html`<p class="${EMPTY}">${noMatch}</p>`}</div></section>
${trackOpenRelease}</div>`;
}
