import type { I18n } from '@microrun/core/i18n';
import { alert, button } from './form.ts';
import { html, maskUrl, raw, tr, type Html } from './html.ts';
import { agentBadge, diffView, markerText, notes, offlineAlert, prodTag, short, releaseBadge, windowBar, windowLeft, windowText, type EnvVM, type ReleaseVM } from './board.ts';

const CELL = 'border-b border-line px-3 py-2.5 text-left align-top max-[900px]:p-2 [overflow-wrap:anywhere]';
const HEAD = `${CELL} text-xs font-semibold text-mute`;
const ROW = 'cursor-pointer [&:hover>td]:bg-bg [&:focus-visible>td]:bg-bg [@media(max-width:560px)]:grid [@media(max-width:560px)]:grid-cols-[auto_minmax(0,1fr)_auto] [@media(max-width:560px)]:border-b [@media(max-width:560px)]:border-line [@media(max-width:560px)]:[&>td]:border-0';
const BACK = 'text-accent no-underline hover:underline';
const H1 = 'mt-2 mb-1 font-display text-2xl font-bold';
const H2 = 'mt-0 mb-2.5 text-[17px] font-semibold';
const H3 = 'mt-4 mb-2 flex items-baseline gap-2 text-sm font-semibold';
const SUB = 'mb-4 flex flex-wrap gap-x-3.5 gap-y-1 text-[13px] text-mute [overflow-wrap:anywhere]';
const JUMP =
  'sticky top-[var(--jump-top)] z-[3] flex flex-wrap items-center gap-1.5 bg-bg py-2 [&>a]:rounded-md [&>a]:border [&>a]:border-line [&>a]:bg-card [&>a]:px-3 [&>a]:py-1.5 [&>a]:text-ink [&>a]:no-underline [&>a.on]:border-accent [&>a.on]:bg-accent [&>a.on]:text-on-accent';

export const OLDER_PAGE_SIZE = 20;

export function splitReleases(rs: ReleaseVM[]): { top: ReleaseVM[]; older: ReleaseVM[] } {
  const ordered = rs.toSorted((a, b) => b.deployedAt - a.deployedAt || (a.id === b.id ? 0 : a.id < b.id ? 1 : -1));
  const active = ordered.find((r) => r.state === 'active');
  if (!active) return { top: ordered.slice(0, 1), older: ordered.slice(1) };

  const top: ReleaseVM[] = [];
  const older: ReleaseVM[] = [];
  for (const r of ordered) {
    const inWindow = r === active || r.state === 'available'
      || ((r.state === 'failed' || r.state === 'blocked') && r.deployedAt >= active.deployedAt);
    (inWindow ? top : older).push(r);
  }
  return { top, older };
}

function row(i: I18n, e: EnvVM, r: ReleaseVM): Html {
  const left = windowLeft(i, r);
  const sha = short(r.sha);
  return html`<tr class="${ROW}${r.state === 'expired' ? ' [&>td]:text-mute' : ''}" data-testid="rel-${e.name}-${sha}" data-state="${r.state}" hx-get="/panel/${r.id}" hx-target="#panel" hx-trigger="click, keydown[key=='Enter']" tabindex="0">
<td class="${CELL} hidden font-mono font-bold [@media(max-width:560px)]:block">${sha}</td>
<td class="${CELL} [@media(max-width:560px)]:col-span-full [@media(max-width:560px)]:row-start-2 [@media(max-width:560px)]:pt-0"><span class="font-mono font-bold [@media(max-width:560px)]:hidden">${sha}</span> ${r.message}<div class="text-xs text-mute">${r.author} · ${i.date(r.deployedAt)}</div>${notes(i, r)}</td>
<td class="${CELL} [@media(max-width:560px)]:col-start-3 [@media(max-width:560px)]:row-start-1">${releaseBadge(i, r.state)}</td><td class="${CELL} max-[900px]:hidden">${diffView(i, r)}</td>
<td class="${CELL} [@media(max-width:560px)]:col-start-2 [@media(max-width:560px)]:row-start-1">${left ? html`${left}${windowBar(r, ' w-[120px] max-[900px]:w-full')}` : '—'}</td></tr>`;
}

function releaseTable(i: I18n, rows: Html[], older = false): Html {
  return html`<table class="w-full border-collapse overflow-hidden rounded-[10px] border border-line bg-surface [@media(max-width:560px)]:table-fixed${older ? ' mb-2.5' : ''}"><thead class="[@media(max-width:560px)]:hidden"><tr><th class="${HEAD}">${tr(i, 'col.release')}</th><th class="${HEAD}">${tr(i, 'col.state')}</th><th class="${HEAD} max-[900px]:hidden">${tr(i, 'col.schema')}</th><th class="${HEAD}">${tr(i, 'col.window')}</th></tr></thead>
<tbody${older ? html` id="older-rows"` : ''}>${rows}</tbody></table>`;
}

function olderMore(i: I18n, env: EnvVM, rest: number, next: string | null): Html {
  const before = next === null ? '' : `?before=${encodeURIComponent(next)}`;
  return button({
    type: 'button',
    testid: 'env-older-more',
    variant: 'ghost',
    block: true,
    label: html`${tr(i, 'env.showOlder', { n: Math.min(OLDER_PAGE_SIZE, rest) })} <span class="ml-auto pl-2 font-normal text-mute">${tr(i, 'home.notShown', { n: rest })}</span>`,
    attrs: html` id="older-more"${next !== null && html` hx-swap-oob="true"`} hx-get="/env/${env.id}/older${before}" hx-target="#older-rows" hx-swap="beforeend"`,
  });
}

export function olderPage(i: I18n, env: EnvVM, rows: ReleaseVM[], rest: number, next: string | null): Html {
  return html`${rows.map((r) => row(i, env, r))}${next === null
    ? html`<span id="older-more" hx-swap-oob="true"></span>`
    : olderMore(i, env, rest, next)}`;
}

const SCROLLSPY = raw(`<script>(function(){var l=document.querySelectorAll('.jump a'),s=document.querySelectorAll('main section[id]');if(!('IntersectionObserver' in window)||!s.length)return;var t=parseFloat(getComputedStyle(s[0]).scrollMarginTop)||0;var o=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting)l.forEach(function(a){a.classList.toggle('on',a.getAttribute('href')==='#'+e.target.id)})})},{rootMargin:'-'+t+'px 0px -55% 0px'});s.forEach(function(x){o.observe(x)})})()</script>`);

export function envView(i: I18n, env: EnvVM, _now: number, parts: { settings: Html }): Html {
  const { top, older } = splitReleases(env.releases);
  return html`<a href="/" class="${BACK}">${tr(i, 'env.back')}</a><h1 class="${H1}">${env.name} ${prodTag(i, env)}</h1>
<div class="${SUB}"><span>${tr(i, 'env.branch', { b: env.branch })}</span><span>${tr(i, 'meta.server')}: ${env.serverName} (${tr(i, env.builtin ? 'agent.builtin' : 'agent.remote')}) ${agentBadge(i, env)}</span>
<span>${tr(i, 'meta.compose')}: ${env.composeProject} — ${env.services.map((s) => `${s.name} · ${s.strategy}`).join(', ')}</span><span>${tr(i, 'meta.db')}: ${env.db}</span>
<span>${tr(i, 'meta.storage')}: ${tr(i, `storage.${env.storage.kind}`)} · ${maskUrl(env.storage.target)}</span><span>${tr(i, 'env.window', { w: windowText(i, env) })}</span></div>
<div class="mb-2.5 flex flex-col gap-2.5 empty:hidden">${offlineAlert(i, env)}${env.markerWarnings.map((w) => alert({ tone: 'error', body: markerText(i, w) }))}</div>
<nav class="jump${env.isProduction ? ' prod' : ''} ${JUMP} ${env.isProduction ? 'border-b-2 border-prod' : 'border-b border-line'}" data-testid="env-jump"><span class="mr-2 flex items-center gap-1.5 font-bold">${env.name} ${prodTag(i, env)}</span><a href="#releases">${tr(i, 'env.sec.releases')}</a><a href="#settings">${tr(i, 'env.sec.settings')}</a></nav>
<section id="releases"><h2 class="${H2}">${tr(i, 'env.sec.releases')}</h2>
<h3 data-testid="env-in-window" class="${H3}">${tr(i, 'env.inWindow')} <span class="text-mute">${i.num(top.length)}</span></h3>
${releaseTable(i, top.map((r) => row(i, env, r)))}
${older.length > 0 && html`<h3 data-testid="env-older" class="${H3}">${tr(i, 'env.older')} <span class="text-mute">${i.num(older.length)}</span></h3>
<p class="mb-2 text-xs text-mute">${tr(i, 'env.olderHint')}</p>
${releaseTable(i, [], true)}${olderMore(i, env, older.length, null)}`}</section>
<section id="settings"><h2 class="${H2}">${tr(i, 'env.sec.settings')}</h2>${parts.settings}</section>
${SCROLLSPY}`;
}

export function newEnvView(i: I18n, settings: Html): Html {
  return html`<a href="/" class="${BACK}">${tr(i, 'env.back')}</a><h1 class="${H1}">${tr(i, 'settings.env.newTitle')}</h1><div class="${SUB}">${tr(i, 'env.newHint')}</div><section id="settings">${settings}</section>`;
}
