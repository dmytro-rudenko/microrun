import type { I18n } from '@microrun/core/i18n';
import { alert } from './form.ts';
import { html, maskUrl, raw, tr, type Html } from './html.ts';
import { agentBadge, diffView, markerText, notes, offlineAlert, prodTag, short, releaseBadge, windowBar, windowLeft, windowText, type EnvVM, type ReleaseVM } from './board.ts';

const CELL = 'border-b border-line px-3 py-2.5 text-left align-top max-[900px]:p-2 [overflow-wrap:anywhere]';
const HEAD = `${CELL} text-xs font-semibold text-mute`;
const ROW = 'cursor-pointer [&:hover>td]:bg-bg [&:focus-visible>td]:bg-bg';
const BACK = 'text-accent no-underline hover:underline';
const H1 = 'mt-2 mb-1 font-display text-2xl font-bold';
const H2 = 'mt-0 mb-2.5 text-[17px] font-semibold';
const SUB = 'mb-4 flex flex-wrap gap-x-3.5 gap-y-1 text-[13px] text-mute [overflow-wrap:anywhere]';
const JUMP =
  'sticky top-0 z-[3] flex flex-wrap items-center gap-1.5 bg-bg py-2 [&>a]:rounded-md [&>a]:border [&>a]:border-line [&>a]:bg-card [&>a]:px-3 [&>a]:py-1.5 [&>a]:text-ink [&>a]:no-underline [&>a.on]:border-accent [&>a.on]:bg-accent [&>a.on]:text-on-accent';

function row(i: I18n, e: EnvVM, r: ReleaseVM): Html {
  const left = windowLeft(i, r);
  return html`<tr class="${ROW}${r.state === 'expired' ? ' [&>td]:text-mute' : ''}" data-testid="rel-${e.name}-${short(r.sha)}" data-state="${r.state}" hx-get="/panel/${r.id}" hx-target="#panel" hx-trigger="click, keydown[key=='Enter']" tabindex="0">
<td class="${CELL}"><span class="font-mono font-bold">${short(r.sha)}</span> ${r.message}<div class="text-xs text-mute">${r.author} · ${i.date(r.deployedAt)}</div>${notes(i, r)}</td>
<td class="${CELL}">${releaseBadge(i, r.state)}</td><td class="${CELL} max-[900px]:hidden">${diffView(i, r)}</td>
<td class="${CELL}">${left ? html`${left}${windowBar(r, ' w-[120px] max-[900px]:w-full')}` : '—'}</td></tr>`;
}

const SCROLLSPY = raw(`<script>(function(){var l=document.querySelectorAll('.jump a');if(!('IntersectionObserver' in window))return;var o=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting)l.forEach(function(a){a.classList.toggle('on',a.getAttribute('href')==='#'+e.target.id)})})},{rootMargin:'-60px 0px -55% 0px'});document.querySelectorAll('main section[id]').forEach(function(s){o.observe(s)})})()</script>`);

export function envView(i: I18n, env: EnvVM, _now: number, parts: { settings: Html }): Html {
  return html`<a href="/" class="${BACK}">${tr(i, 'env.back')}</a><h1 class="${H1}">${env.name} ${prodTag(i, env)}</h1>
<div class="${SUB}"><span>${tr(i, 'env.branch', { b: env.branch })}</span><span>${tr(i, 'meta.server')}: ${env.serverName} (${tr(i, env.builtin ? 'agent.builtin' : 'agent.remote')}) ${agentBadge(i, env)}</span>
<span>${tr(i, 'meta.compose')}: ${env.composeProject} — ${env.services.map((s) => `${s.name} · ${s.strategy}`).join(', ')}</span><span>${tr(i, 'meta.db')}: ${env.db}</span>
<span>${tr(i, 'meta.storage')}: ${tr(i, `storage.${env.storage.kind}`)} · ${maskUrl(env.storage.target)}</span><span>${tr(i, 'env.window', { w: windowText(i, env) })}</span></div>
<div class="mb-2.5 flex flex-col gap-2.5 empty:hidden">${offlineAlert(i, env)}${env.markerWarnings.map((w) => alert({ tone: 'error', body: markerText(i, w) }))}</div>
<nav class="jump${env.isProduction ? ' prod' : ''} ${JUMP} ${env.isProduction ? 'border-b-2 border-prod' : 'border-b border-line'}" data-testid="env-jump"><span class="mr-2 flex items-center gap-1.5 font-bold">${env.name} ${prodTag(i, env)}</span><a href="#releases">${tr(i, 'env.sec.releases')}</a><a href="#settings">${tr(i, 'env.sec.settings')}</a></nav>
<section id="releases"><h2 class="${H2}">${tr(i, 'env.sec.releases')}</h2><table class="w-full border-collapse overflow-hidden rounded-[10px] border border-line bg-surface"><thead><tr><th class="${HEAD}">${tr(i, 'col.release')}</th><th class="${HEAD}">${tr(i, 'col.state')}</th><th class="${HEAD} max-[900px]:hidden">${tr(i, 'col.schema')}</th><th class="${HEAD}">${tr(i, 'col.window')}</th></tr></thead>
<tbody>${env.releases.map((r) => row(i, env, r))}</tbody></table></section>
<section id="settings"><h2 class="${H2}">${tr(i, 'env.sec.settings')}</h2>${parts.settings}</section>
${SCROLLSPY}`;
}

export function newEnvView(i: I18n, settings: Html): Html {
  return html`<a href="/" class="${BACK}">${tr(i, 'env.back')}</a><h1 class="${H1}">${tr(i, 'settings.env.newTitle')}</h1><div class="${SUB}">${tr(i, 'env.newHint')}</div><section id="settings">${settings}</section>`;
}
