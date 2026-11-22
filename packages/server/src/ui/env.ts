import type { I18n } from '@microrun/core/i18n';
import { html, maskUrl, raw, tr, type Html } from './html.ts';
import { agentBadge, diffView, markerText, notes, offlineAlert, prodTag, short, stateLabel, windowBar, windowLeft, windowText, type EnvVM, type ReleaseVM } from './board.ts';

function row(i: I18n, e: EnvVM, r: ReleaseVM): Html {
  const left = windowLeft(i, r);
  return html`<tr class="click${r.state === 'expired' ? ' dim' : ''}" data-testid="rel-${e.name}-${short(r.sha)}" data-state="${r.state}" hx-get="/panel/${r.id}" hx-target="#panel" hx-trigger="click, keydown[key=='Enter']" tabindex="0">
<td><span class="sha">${short(r.sha)}</span> ${r.message}<div class="small">${r.author} · ${i.date(r.deployedAt)}</div>${notes(i, r)}</td>
<td><span class="badge b-${r.state}">${stateLabel(i, r.state)}</span></td><td class="hide-sm">${diffView(i, r)}</td>
<td>${left ? html`${left}${windowBar(r, ' w120')}` : '—'}</td></tr>`;
}

const SCROLLSPY = raw(`<script>(function(){var l=document.querySelectorAll('.jump a');if(!('IntersectionObserver' in window))return;var o=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting)l.forEach(function(a){a.classList.toggle('on',a.getAttribute('href')==='#'+e.target.id)})})},{rootMargin:'-60px 0px -55% 0px'});document.querySelectorAll('main section[id]').forEach(function(s){o.observe(s)})})()</script>`);

export function envView(i: I18n, env: EnvVM, _now: number, parts: { history: Html; settings: Html }): Html {
  return html`<a class="back" href="/">${tr(i, 'env.back')}</a><h1>${env.name} ${prodTag(i, env)}</h1>
<div class="sub"><span>${tr(i, 'env.branch', { b: env.branch })}</span><span>${tr(i, 'meta.server')}: ${env.serverName} (${tr(i, env.builtin ? 'agent.builtin' : 'agent.remote')}) ${agentBadge(i, env)}</span>
<span>${tr(i, 'meta.compose')}: ${env.composeProject} — ${env.services.map((s) => `${s.name} · ${s.strategy}`).join(', ')}</span><span>${tr(i, 'meta.db')}: ${env.db}</span>
<span>${tr(i, 'meta.storage')}: ${tr(i, `storage.${env.storage.kind}`)} · ${maskUrl(env.storage.target)}</span><span>${tr(i, 'env.window', { w: windowText(i, env) })}</span></div>
${offlineAlert(i, env)}${env.markerWarnings.map((w) => html`<div class="alert">${markerText(i, w)}</div>`)}
<nav class="jump${env.isProduction ? ' prod' : ''}" data-testid="env-jump"><span class="ctx">${env.name} ${prodTag(i, env)}</span><a href="#releases">${tr(i, 'env.sec.releases')}</a><a href="#history">${tr(i, 'env.sec.history')}</a><a href="#settings">${tr(i, 'env.sec.settings')}</a></nav>
<section id="releases"><h2>${tr(i, 'env.sec.releases')}</h2><table><thead><tr><th>${tr(i, 'col.release')}</th><th>${tr(i, 'col.state')}</th><th class="hide-sm">${tr(i, 'col.schema')}</th><th>${tr(i, 'col.window')}</th></tr></thead>
<tbody>${env.releases.map((r) => row(i, env, r))}</tbody></table></section>
<section id="history"><h2>${tr(i, 'env.sec.history')}</h2>${parts.history}</section>
<section id="settings"><h2>${tr(i, 'env.sec.settings')}</h2>${parts.settings}</section>
${SCROLLSPY}`;
}

export function newEnvView(i: I18n, settings: Html): Html {
  return html`<a class="back" href="/">${tr(i, 'env.back')}</a><h1>${tr(i, 'settings.env.newTitle')}</h1><div class="sub">${tr(i, 'env.newHint')}</div><section id="settings">${settings}</section>`;
}
