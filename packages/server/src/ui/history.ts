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
  cleanup?: { rule: string; expected: number; deleted: number }[];
}

const actorText = (i: I18n, actor: string) =>
  actor.startsWith('ci:') ? tr(i, 'actor.ci', { name: actor.slice(3) }) : tr(i, `actor.${actor}`);

function row(i: I18n, h: HistoryVM): Html {
  return html`<tr><td>${i.date(h.at)}</td><td>${tr(i, `kind.${h.kind}`)}</td>
<td class="sha">${short(h.from)} → ${short(h.to)}</td><td class="hide-sm">${actorText(i, h.actor)}</td>
<td><span class="${h.status === 'ok' ? 'ok' : 'bad'}">${tr(i, `status.${h.status}`)}</span>${h.durationS !== null && html` · ${i.unit(h.durationS, 'second')}`}
${h.reason && html`<div class="small">${codeText(i, h.reason.code, h.reason.params)}</div>`}
${h.cleanup?.map((c) => html`<div class="small">${tr(i, 'cl.result', { rule: c.rule, p: i.num(c.expected), a: i.num(c.deleted) })}</div>`)}</td></tr>`;
}

export function envHistory(i: I18n, rows: HistoryVM[], envId: string, all: boolean): Html {
  if (rows.length === 0) return html`<p class="small" data-testid="history-empty">${tr(i, 'env.historyEmpty')}</p>`;
  const shown = all ? rows : rows.slice(0, 5);
  return html`<table><thead><tr><th>${tr(i, 'col.when')}</th><th>${tr(i, 'col.action')}</th><th>${tr(i, 'col.fromTo')}</th><th class="hide-sm">${tr(i, 'col.who')}</th><th>${tr(i, 'col.result')}</th></tr></thead>
<tbody>${shown.map((h) => row(i, h))}</tbody></table>${!all && rows.length > 5 && html`<a class="back" href="/env/${envId}?history=all#history" data-testid="history-all">${tr(i, 'env.historyAll', { n: i.num(rows.length) })}</a>`}`;
}
