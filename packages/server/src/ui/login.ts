import { LANG_NAMES, LANGS, type I18n } from '@microrun/core/i18n';
import { alert, button, field, input, select } from './form.ts';
import { fontLinks, html, raw, tr } from './html.ts';

type LogTone = 'text-console-mute' | 'text-console-ok' | 'text-console-accent' | 'text-console-warn';

const LOG: [LogTone, string, string][] = [
  ['text-console-mute', '12:04:11', 'pull ghcr.io/acme/web:a3f9c21'],
  ['text-console-mute', '12:04:19', 'start web-dev · port 3011'],
  ['text-console-ok', '12:04:21', 'healthcheck ok · dev'],
  ['text-console-accent', '12:05:02', 'release 7be04d8 → stage'],
  ['text-console-ok', '12:05:09', 'swap complete · stage'],
  ['text-console-warn', '12:06:40', 'cleanup: 4 images, 1.2 GB'],
  ['text-console-ok', '12:07:15', 'prod v1.8.2 · 3 replicas healthy'],
];

const LOG_SHOWN = 5;

const LOG_SCRIPT = `(function(){if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;var L=${JSON.stringify(LOG)},k=${LOG_SHOWN},log=document.getElementById('login-log');setInterval(function(){var e=L[k++%L.length],d=document.createElement('div'),t=document.createElement('span'),m=document.createElement('span');d.className='truncate';t.textContent=e[1];m.className=e[0];m.textContent=e[2];d.append(t,'  ',m);log.append(d);while(log.children.length>${LOG_SHOWN})log.firstElementChild.remove()},1800)})();`;

const RACK = raw(`<svg viewBox="0 0 360 220" class="w-full" aria-hidden="true">
<g fill="none" stroke="var(--console-line)" stroke-width="1.5">
<rect x="20" y="10" width="320" height="56" rx="8" fill="#0f1620"/>
<rect x="20" y="82" width="320" height="56" rx="8" fill="#0f1620"/>
<rect x="20" y="154" width="320" height="56" rx="8" fill="#1a1013" stroke="#5a2a2e"/>
</g>
<g font-family="JetBrains Mono, monospace" font-size="12">
<text x="40" y="43" fill="var(--console-ink)">dev</text><text x="40" y="115" fill="var(--console-ink)">stage</text><text x="40" y="187" fill="#ff8a8a">prod</text>
<text x="96" y="43" fill="var(--console-mute)">feature/billing</text><text x="96" y="115" fill="var(--console-mute)">main</text><text x="96" y="187" fill="var(--console-mute)">v1.8.2</text>
<text x="282" y="43" fill="var(--console-mute)" text-anchor="end">a3f9c21</text><text x="282" y="115" fill="var(--console-mute)" text-anchor="end">7be04d8</text><text x="282" y="187" fill="var(--console-mute)" text-anchor="end">19c6e5a</text>
</g>
<g><circle class="led" cx="316" cy="38" r="4" fill="var(--console-ok)"/><circle class="led" cx="302" cy="38" r="4" fill="var(--console-ok)"/>
<circle class="led" cx="316" cy="110" r="4" fill="var(--console-ok)"/><circle class="led" cx="302" cy="110" r="4" fill="var(--console-warn)"/>
<circle class="led" cx="316" cy="182" r="4" fill="var(--console-ok)"/><circle class="led" cx="302" cy="182" r="4" fill="var(--console-ok)"/></g>
</svg>`);

const GLOBE = raw(
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" class="text-mute" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg>',
);

const EYE = raw(
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
);

const TOGGLE_PASSWORD = "var p=document.getElementById('password');p.type=p.type==='password'?'text':'password'";

export function loginView(i: I18n, p: { error: boolean; csrf?: string }): string {
  const logo = html`<span class="text-console-accent">▍</span>microrun`;
  return html`<!doctype html>
<html lang="${i.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${i.t('login.title')} · microrun</title>
${fontLinks}<link rel="stylesheet" href="/static/app.css">
</head><body class="min-h-screen bg-bg font-sans text-sm text-ink"><div class="flex min-h-screen">
<aside data-testid="login-panel" class="hidden lg:flex w-[42%] max-w-[560px] flex-col gap-10 border-r border-console-line bg-console-bg p-10 text-console-ink">
<div class="flex items-center gap-2.5 font-mono text-[15px]">${logo}</div>
${RACK}
<div id="login-log" class="min-w-0 font-mono text-xs leading-6 text-console-mute" aria-hidden="true">${LOG.slice(0, LOG_SHOWN).map(
    ([cls, time, msg]) => html`<div class="truncate"><span>${time}</span>  <span class="${cls}">${msg}</span></div>`,
  )}</div>
<div class="mt-auto"><h2 class="font-display text-2xl font-bold text-balance">${tr(i, 'login.tagline')}</h2><p class="mt-2 text-sm text-console-mute">${tr(i, 'login.subline')}</p></div>
</aside>
<main class="relative flex flex-1 items-center justify-center px-4 py-12">
<form method="get" action="/login" class="absolute right-4 top-4 flex items-center gap-2 sm:right-6 sm:top-6">${GLOBE}${select({
    name: 'lang',
    testid: 'login-lang',
    compact: true,
    current: i.lang,
    options: LANGS.map((l) => ({ value: l, label: LANG_NAMES[l] })),
    attrs: html` aria-label="${i.t('nav.language')}" onchange="this.form.submit()"`,
  })}<noscript>${button({ label: tr(i, 'common.confirm'), variant: 'ghost' })}</noscript></form>
<div class="w-full max-w-[400px]">
<div class="mb-8 font-mono lg:hidden">${logo}</div>
<h1 class="font-display text-3xl font-bold">${tr(i, 'login.title')}</h1>
<form method="post" action="/login" class="mt-8 flex flex-col gap-6">${p.csrf ? html`<input type="hidden" name="_csrf" value="${p.csrf}">` : ''}
${p.error ? alert({ tone: 'error', role: 'alert', testid: 'login-error', body: tr(i, 'login.error') }) : ''}
${field({
    id: 'username',
    caps: true,
    label: tr(i, 'login.username'),
    control: input({ name: 'username', id: 'username', autocomplete: 'username', required: true, attrs: raw(' autofocus') }),
  })}
${field({
    id: 'password',
    caps: true,
    label: tr(i, 'login.password'),
    control: html`<div class="relative">${input({
      name: 'password',
      id: 'password',
      type: 'password',
      autocomplete: 'current-password',
      required: true,
      cls: 'pr-12',
    })}<button type="button" data-testid="login-show-password" aria-label="${i.t('login.showPassword')}" onclick="${TOGGLE_PASSWORD}" class="absolute inset-y-0 right-0 flex items-center px-3 text-mute hover:text-ink focus:outline-none focus-visible:text-accent">${EYE}</button></div>`,
  })}
${button({ label: tr(i, 'login.submit'), testid: 'login-submit', block: true })}
</form></div></main></div>
<script>${raw(LOG_SCRIPT)}</script>
</body></html>`.__html;
}
