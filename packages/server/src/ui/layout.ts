import { LANGS, LANG_NAMES, type I18n } from '@microrun/core/i18n';
import { html, tr, type Html } from './html.ts';

const NAV = [
  { id: 'envs', href: '/', key: 'nav.envs' },
  { id: 'history', href: '/history', key: 'nav.history' },
  { id: 'settings', href: '/settings/servers', key: 'nav.settings' },
] as const;

export function layout(p: { i: I18n; title: string; active: 'envs' | 'history' | 'settings'; csrf: string; body: Html }): string {
  const { i } = p;
  return html`<!doctype html>
<html lang="${i.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${p.title} · microrun</title>
<link rel="stylesheet" href="/static/app.css">
<script src="/static/htmx.min.js" defer></script>
</head><body>
<header><b>microrun</b>${NAV.map((n) => html`<a href="${n.href}" class="${n.id === p.active ? 'on' : ''}">${tr(i, n.key)}</a>`)}
<form method="post" action="/lang" class="lang"><input type="hidden" name="_csrf" value="${p.csrf}">
<select name="lang" data-testid="lang" aria-label="${i.t('nav.language')}" onchange="this.form.submit()">${LANGS.map((l) => html`<option value="${l}"${l === i.lang ? ' selected' : ''}>${LANG_NAMES[l]}</option>`)}</select></form></header>
<main>${p.body}</main>
<aside id="panel" aria-live="polite"></aside>
</body></html>`.__html;
}
