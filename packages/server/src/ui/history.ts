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

const td = 'border-b border-line px-3 py-2.5 text-left align-top max-[900px]:p-2';
const th = 'border-b border-line px-3 py-2.5 text-left align-top text-xs font-semibold text-mute max-[900px]:p-2';
const hideSm = 'max-[900px]:hidden';
const small = 'text-xs text-mute';
const filterOn = 'rounded-md border border-accent bg-accent px-3.5 py-1.5 text-on-accent no-underline';
const filterOff = 'rounded-md border border-line bg-card px-3.5 py-1.5 text-ink no-underline';

function filterLink(href: string, label: string | Html, active: boolean): Html {
  return html`<a href="${href}"${active && html` aria-current="page"`} class="${active ? filterOn : filterOff}">${label}</a>`;
}

function row(i: I18n, h: HistoryVM): Html {
  return html`<tr><td class="${td}">${i.date(h.at)}</td><td class="${td}">${h.isProduction ? html`<span class="rounded bg-prod px-2 py-0.5 text-[11px] font-bold tracking-wider text-on-prod">${h.env}</span>` : h.env}</td><td class="${td}">${tr(i, `kind.${h.kind}`)}</td>
<td class="${td} font-mono font-bold">${short(h.from)} → ${short(h.to)}</td><td class="${td} ${hideSm}">${actorText(i, h.actor)}</td>
<td class="${td}"><span data-status="${h.status}" class="${h.status === 'ok' ? 'font-semibold text-ok' : 'text-prod'}">${tr(i, `status.${h.status}`)}</span>${h.durationS !== null && html` · ${i.unit(h.durationS, 'second')}`}
${h.reason && html`<div class="${small}">${codeText(i, h.reason.code, h.reason.params)}</div>`}
${h.cleanup?.map((c) => html`<div class="${small}">${tr(i, 'cl.result', { rule: c.rule, p: i.num(c.expected), a: i.num(c.deleted) })}</div>`)}</td></tr>`;
}

export function historyView(i: I18n, ops: HistoryVM[], envs: { id: string; name: string }[], filter: string): Html {
  const all = filter === '' || filter === 'all';
  return html`<h1 class="mt-2 mb-1 font-display text-2xl font-bold">${tr(i, 'nav.history')}</h1><div class="mb-4 flex flex-wrap gap-x-3.5 gap-y-1 text-[13px] text-mute [overflow-wrap:anywhere]">${tr(i, 'hist.sub')}</div>
<div class="mb-3 flex flex-wrap gap-1.5">${filterLink('/history', tr(i, 'hist.all'), all)}${envs.map((e) => filterLink(`/history?env=${e.id}`, e.name, e.id === filter))}</div>
<table class="w-full border-collapse overflow-hidden rounded-[10px] border border-line bg-surface"><thead><tr><th class="${th}">${tr(i, 'col.when')}</th><th class="${th}">${tr(i, 'col.env')}</th><th class="${th}">${tr(i, 'col.action')}</th><th class="${th}">${tr(i, 'col.fromTo')}</th><th class="${th} ${hideSm}">${tr(i, 'col.who')}</th><th class="${th}">${tr(i, 'col.result')}</th></tr></thead>
<tbody>${ops.map((h) => row(i, h))}</tbody></table>`;
}
