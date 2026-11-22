import type { I18n } from '@microrun/core/i18n';
import { codeText, html, tr, type Html } from './html.ts';
import { short } from './board.ts';

export interface HistoryVM {
  at: number;
  env: string;
  isProduction: boolean;
  kind: string;
  from: string;
  to: string;
  actor: string;
  status: string;
  durationS: number | null;
  reason: { code: string; params: Record<string, string | number> } | null;
}

const actorText = (i: I18n, actor: string) =>
  actor.startsWith('ci:') ? tr(i, 'actor.ci', { name: actor.slice(3) }) : tr(i, `actor.${actor}`);

function row(i: I18n, h: HistoryVM): Html {
  return html`<tr><td>${i.date(h.at)}</td><td>${h.isProduction ? html`<span class="tag">${h.env}</span>` : h.env}</td><td>${tr(i, `kind.${h.kind}`)}</td>
<td class="sha">${short(h.from)} → ${short(h.to)}</td><td class="hide-sm">${actorText(i, h.actor)}</td>
<td><span class="${h.status === 'ok' ? 'ok' : 'bad'}">${tr(i, `status.${h.status}`)}</span>${h.durationS !== null && html` · ${i.unit(h.durationS, 'second')}`}
${h.reason && html`<div class="small">${codeText(i, h.reason.code, h.reason.params)}</div>`}</td></tr>`;
}

export function historyView(i: I18n, ops: HistoryVM[], envs: { id: string; name: string }[], filter: string): Html {
  const all = filter === '' || filter === 'all';
  return html`<h1>${tr(i, 'nav.history')}</h1><div class="sub">${tr(i, 'hist.sub')}</div>
<div class="filters"><a href="/history" class="${all ? 'on' : ''}">${tr(i, 'hist.all')}</a>${envs.map((e) => html`<a href="/history?env=${e.id}" class="${e.id === filter ? 'on' : ''}">${e.name}</a>`)}</div>
<table><thead><tr><th>${tr(i, 'col.when')}</th><th>${tr(i, 'col.env')}</th><th>${tr(i, 'col.action')}</th><th>${tr(i, 'col.fromTo')}</th><th class="hide-sm">${tr(i, 'col.who')}</th><th>${tr(i, 'col.result')}</th></tr></thead>
<tbody>${ops.map((h) => row(i, h))}</tbody></table>`;
}
