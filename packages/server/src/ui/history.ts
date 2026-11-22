import type { I18n } from '@microrun/core/i18n';
import { codeText, html, tr, type Html } from './html.ts';
import { short } from './board.ts';

export interface HistoryVM {
  at: number;
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

const small = 'text-xs text-mute';

function item(i: I18n, h: HistoryVM): Html {
  return html`<li class="border-b border-line py-2 [overflow-wrap:anywhere] last:border-b-0" data-testid="history-item">
<div class="flex flex-wrap items-baseline gap-x-2"><span class="font-semibold">${tr(i, `kind.${h.kind}`)}</span><span class="whitespace-nowrap font-mono font-bold">${short(h.from)} → ${short(h.to)}</span>
<span data-status="${h.status}" class="${h.status === 'ok' ? 'font-semibold text-ok' : 'text-prod'}">${tr(i, `status.${h.status}`)}</span></div>
<div class="${small}">${i.date(h.at)} · ${actorText(i, h.actor)}${h.durationS !== null && html` · ${i.unit(h.durationS, 'second')}`}</div>
${h.reason && html`<div class="${small}">${codeText(i, h.reason.code, h.reason.params)}</div>`}
${h.cleanup?.map((c) => html`<div class="${small}">${tr(i, 'cl.result', { rule: c.rule, p: i.num(c.expected), a: i.num(c.deleted) })}</div>`)}</li>`;
}

export function releaseHistory(i: I18n, rows: HistoryVM[]): Html {
  const body = rows.length === 0
    ? html`<p class="${small}" data-testid="history-empty">${tr(i, 'env.historyEmpty')}</p>`
    : html`<ul class="m-0 list-none p-0">${rows.map((h) => item(i, h))}</ul>`;
  return html`<div class="mt-[18px] border-t border-line pt-3.5" data-testid="release-history"><b>${tr(i, 'env.sec.history')}</b>${body}</div>`;
}
