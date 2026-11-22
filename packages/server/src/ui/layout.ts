import { LANGS, LANG_NAMES, type I18n } from '@microrun/core/i18n';
import { select } from './form.ts';
import { fontLinks, html, tr, type Html } from './html.ts';

const HTMX_CONFIG = {
  responseHandling: [
    { code: '204', swap: false },
    { code: '[23]..', swap: true },
    { code: '[45]..', swap: true, error: true },
  ],
};

export function layout(p: { i: I18n; title: string; csrf: string; body: Html }): string {
  const { i } = p;
  return html`<!doctype html>
<html lang="${i.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${p.title} · microrun</title>
<meta name="htmx-config" content="${JSON.stringify(HTMX_CONFIG)}">
<link rel="stylesheet" href="/static/app.css">${fontLinks}
<script src="/static/htmx.min.js" defer></script>
</head><body class="min-h-screen bg-bg font-sans text-sm text-ink">
<header class="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-5 py-2.5"><a href="/" class="mr-3 text-ink no-underline"><b class="font-mono text-base"><span class="text-accent">▍</span>microrun</b></a><a href="/env/new" data-testid="env-new" class="ml-auto rounded-md bg-accent px-3 py-1.5 font-semibold text-on-accent no-underline hover:opacity-90">${tr(i, 'env.newEnv')}</a>
<form method="post" action="/lang"><input type="hidden" name="_csrf" value="${p.csrf}">
${select({
  name: 'lang',
  testid: 'lang',
  compact: true,
  current: i.lang,
  options: LANGS.map((l) => ({ value: l, label: LANG_NAMES[l] })),
  attrs: html` aria-label="${i.t('nav.language')}" onchange="this.form.submit()"`,
})}</form></header>
<main class="min-w-0 p-5 transition-[margin] duration-200 max-[900px]:p-4 [&_section[id]]:mt-6 [&_section[id]]:scroll-mt-[60px]">${p.body}</main>
<aside id="panel" aria-live="polite"></aside>
</body></html>`.__html;
}
