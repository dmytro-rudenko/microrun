import { LANGS, LANG_NAMES, type I18n } from '@microrun/core/i18n';
import { CONTROL, select } from './form.ts';
import { fontLinks, html, tr, type Html } from './html.ts';

const HTMX_CONFIG = {
  responseHandling: [
    { code: '204', swap: false },
    { code: '[23]..', swap: true },
    { code: '[45]..', swap: true, error: true },
  ],
};

export function layout(p: { i: I18n; title: string; csrf: string; body: Html; q?: string }): string {
  const { i } = p;
  return html`<!doctype html>
<html lang="${i.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${p.title} · microrun</title>
<meta name="htmx-config" content="${JSON.stringify(HTMX_CONFIG)}">
<link rel="stylesheet" href="/static/app.css">${fontLinks}
<script src="/static/htmx.min.js" defer></script>
</head><body class="min-h-screen bg-bg font-sans text-sm text-ink">
<header class="sticky top-0 z-10 border-b border-line bg-surface py-2.5">
<div class="top-in mx-auto flex max-w-[1320px] flex-wrap items-center gap-x-3.5 gap-y-2.5 px-4 min-[761px]:flex-nowrap">
<a href="/" class="mr-3 text-ink no-underline"><b class="font-mono text-base"><span class="text-accent">▍</span>microrun</b></a>
<form method="get" action="/" role="search" hx-get="/" hx-trigger="input changed delay:250ms from:find input, search from:find input" hx-target="#home" hx-select="#home" hx-swap="outerHTML" hx-push-url="true" class="relative order-3 basis-full min-[761px]:order-none min-[761px]:basis-auto min-[761px]:max-w-[440px] min-[761px]:flex-1">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>
<input type="search" name="q" data-testid="search" value="${p.q ?? ''}" aria-label="${i.t('search.label')}" placeholder="${i.t('search.placeholder')}" class="${CONTROL} pl-9">
</form>
<form method="post" action="/lang" class="ml-auto"><input type="hidden" name="_csrf" value="${p.csrf}">
${select({
  name: 'lang',
  testid: 'lang',
  compact: true,
  current: i.lang,
  options: LANGS.map((l) => ({ value: l, label: LANG_NAMES[l] })),
  attrs: html` aria-label="${i.t('nav.language')}" onchange="this.form.submit()"`,
})}</form>
<a href="/env/new" data-testid="env-new" aria-label="${i.t('env.newEnv')}" class="rounded-md bg-accent px-3 py-1.5 font-semibold text-on-accent no-underline hover:opacity-90"><span class="min-[761px]:hidden">${tr(i, 'env.newEnvShort')}</span><span class="max-[761px]:hidden">${tr(i, 'env.newEnv')}</span></a>
</div></header>
<script>document.addEventListener('keydown',function(e){if(e.key==='/'&&!/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)){e.preventDefault();document.querySelector('[data-testid=search]').focus()}})</script>
<main class="mx-auto min-w-0 max-w-[1320px] px-4 py-5 transition-[margin] duration-200 [&_section[id]]:mt-6 [&_section[id]]:scroll-mt-[var(--jump-top)]">${p.body}</main>
<aside id="panel" aria-live="polite"></aside>
</body></html>`.__html;
}
