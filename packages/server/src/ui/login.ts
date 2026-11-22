import type { I18n } from '@microrun/core/i18n';
import { html, tr } from './html.ts';

export function loginView(i: I18n, p: { error: boolean; csrf?: string }): string {
  return html`<!doctype html>
<html lang="${i.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${i.t('login.title')} · microrun</title>
<link rel="stylesheet" href="/static/app.css">
</head><body><main class="login">
<h1>microrun</h1>
<form method="post" action="/login">${p.csrf ? html`<input type="hidden" name="_csrf" value="${p.csrf}">` : ''}
${p.error ? html`<div class="alert" role="alert" data-testid="login-error">${tr(i, 'login.error')}</div>` : ''}
<label>${tr(i, 'login.username')}<input id="username" name="username" autocomplete="username" required autofocus></label>
<label>${tr(i, 'login.password')}<input id="password" name="password" type="password" autocomplete="current-password" required></label>
<button type="submit" data-testid="login-submit">${tr(i, 'login.submit')}</button>
</form></main></body></html>`.__html;
}
