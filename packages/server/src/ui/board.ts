import type { I18n } from '@microrun/core/i18n';
import type { ReleaseState } from '@microrun/core/state';
import type { DiffEntry } from '@microrun/core/schema';
import { alert } from './form.ts';
import { codeText, html, maskUrl, tr, type Html } from './html.ts';

export interface ReleaseVM {
  id: string;
  sha: string;
  message: string;
  author: string;
  deployedAt: number;
  state: ReleaseState;
  windowLeftMs: number | null;
  windowPct: number | null;
  diff: DiffEntry[];
  blocked: { at: number; to: string } | null;
  failNote: { code: string; params: Record<string, string | number> } | null;
  cleanupState: string;
  cleanupPreview: { rule: string; description: string; count: number }[] | null;
  cleanupResult: { rule: string; deleted: number }[] | null;
  activationSeq: number | null;
  imagePurged: boolean;
  stored: boolean;
  cleanupFailed: { code: string; params: Record<string, string | number> } | null;
}

export interface EnvVM {
  id: string;
  name: string;
  branch: string;
  isProduction: boolean;
  retentionS: number;
  agentOnline: boolean;
  serverName: string;
  builtin: boolean;
  composeProject: string;
  services: { name: string; strategy: string }[];
  db: string;
  storage: { kind: string; target: string };
  markerWarnings: { svc: string; other: string; url?: string }[];
  releases: ReleaseVM[];
}

const SIGNS = { add: '+', drop: '−', warn: '!' } as const;

const DIFF_INK: Record<DiffEntry['kind'], string> = { add: 'text-ok', drop: 'text-prod', warn: 'text-warn' };

const STATE_INK: Record<ReleaseState, string> = {
  active: 'text-ok',
  available: 'text-mute',
  blocked: 'text-prod',
  expired: 'text-mute',
  failed: 'text-warn',
};

const CARD = 'rel relative mb-2.5 cursor-pointer rounded-lg border bg-card p-2.5 hover:border-accent focus-visible:border-accent';
const COLUMN = 'min-w-0 rounded-xl bg-surface p-3.5';
const COLUMN_PLAIN = 'border border-line';
const COLUMN_PROD = 'border-2 border-prod shadow-[0_0_0_4px_var(--prod-soft)] max-[900px]:order-first';

const cardBorder = (r: ReleaseVM, selected: boolean) => (r.state === 'active' ? 'border-ok' : selected ? 'border-accent' : 'border-line');

export const short = (sha: string) => sha.slice(0, 7);

export const prodTag = (i: I18n, e: EnvVM) => (e.isProduction ? html`<span class="rounded px-2 py-0.5 text-[11px] font-bold tracking-wider bg-prod text-on-prod">${tr(i, 'env.prodTag')}</span>` : null);

export const windowText = (i: I18n, e: EnvVM) => i.left(e.retentionS * 1000);

export const stateLabel = (i: I18n, s: ReleaseState) => tr(i, `state.${s}`);

export const agentBadge = (i: I18n, e: EnvVM) =>
  html`<span class="${e.agentOnline ? 'text-ok' : 'text-mute'}">● ${tr(i, e.agentOnline ? 'agent.online' : 'agent.offline')}</span>`;

export const markerText = (i: I18n, w: EnvVM['markerWarnings'][number]) =>
  html`<b>${tr(i, 'marker.title')}</b> ${tr(i, 'marker.text', { svc: w.svc, other: w.other, url: w.url === undefined ? '—' : maskUrl(w.url) })}`;

export const offlineAlert = (i: I18n, e: EnvVM) => (e.agentOnline ? null : alert({ tone: 'warn', body: tr(i, 'agent.offlineLong') }));

export function diffView(i: I18n, r: ReleaseVM, box = false): Html {
  if (!r.diff.length) return html`<span class="text-xs text-mute">${tr(i, 'schema.none')}</span>`;
  return html`<div class="font-mono text-xs${box ? ' rounded-md bg-code p-2' : ''}">${r.diff.map((d) => html`<div class="${DIFF_INK[d.kind]}">${SIGNS[d.kind]} ${d.object}: ${d.detail}</div>`)}</div>`;
}

export const blockedNote = (i: I18n, r: ReleaseVM) =>
  r.blocked && html`<div class="text-xs text-prod">${tr(i, 'note.blocked', { at: i.date(r.blocked.at), to: short(r.blocked.to) })}</div>`;

export const failNote = (i: I18n, r: ReleaseVM) =>
  r.failNote && html`<div class="text-xs text-warn">${codeText(i, r.failNote.code, r.failNote.params)}</div>`;

export const unstored = (r: ReleaseVM) => !r.stored && (r.state === 'active' || r.state === 'available');

export const storageWarn = (i: I18n) => alert({ tone: 'warn', body: tr(i, 'storage.failedWarn') });

export const notes = (i: I18n, r: ReleaseVM) => html`${blockedNote(i, r)}${failNote(i, r)}`;

export const windowLeft = (i: I18n, r: ReleaseVM) => (r.windowLeftMs === null ? null : i.left(r.windowLeftMs));

export const windowBar = (r: ReleaseVM, cls = '') =>
  r.windowLeftMs === null || r.windowPct === null ? null : html`<div class="mt-1.5 h-[3px] rounded-sm bg-line${cls}"><i class="block h-full rounded-sm bg-accent" style="width:${Math.round(r.windowPct)}%"></i></div>`;

function card(i: I18n, e: EnvVM, r: ReleaseVM, now: number, selected?: string): Html {
  const left = windowLeft(i, r);
  return html`<div class="${CARD} ${r.state} ${cardBorder(r, r.id === selected)}${r.id === selected ? ' outline outline-1 outline-accent' : ''}${r.state === 'expired' ? ' opacity-50' : ''}" data-testid="rel-${e.name}-${short(r.sha)}" data-state="${r.state}" hx-get="/panel/${r.id}" hx-target="#panel" hx-trigger="click, keydown[key=='Enter']" tabindex="0" role="button">
<span class="float-right text-[11px] ${STATE_INK[r.state]}">${stateLabel(i, r.state)}</span><span class="font-mono font-bold">${short(r.sha)}</span><div>${r.message}</div>
<div class="text-xs text-mute">${r.author} · ${i.ago(r.deployedAt, now)}${left && html` · ${tr(i, 'window.left', { t: left })}`}</div>${windowBar(r)}${unstored(r) && html`<div class="mt-2">${storageWarn(i)}</div>`}</div>`;
}

function column(i: I18n, e: EnvVM, now: number, selected?: string): Html {
  return html`<section class="${COLUMN} ${e.isProduction ? COLUMN_PROD : COLUMN_PLAIN}" data-testid="col-${e.name}">
<div class="flex items-center justify-between gap-2"><h2 class="m-0 text-lg font-semibold"><a href="/env/${e.id}" class="text-inherit no-underline hover:underline">${e.name}</a></h2>${prodTag(i, e)}</div>
<div class="mt-1 mb-3 text-xs text-mute">${tr(i, 'env.branch', { b: e.branch })} · ${tr(i, 'env.window', { w: windowText(i, e) })} · ${agentBadge(i, e)}</div>
<div class="mb-2.5 flex flex-col gap-2.5 empty:hidden">${e.markerWarnings.length > 0 && alert({ tone: 'error', body: html`⚠ ${tr(i, 'marker.short')}` })}${offlineAlert(i, e)}</div>
<div class="tl">${e.releases.map((r) => card(i, e, r, now, selected))}</div>
<div class="mt-1 text-xs text-mute"><a href="/env/${e.id}" class="text-accent no-underline hover:underline">${tr(i, 'env.open')}</a></div></section>`;
}

export function boardView(i: I18n, envs: EnvVM[], now: number, selected?: string): Html {
  return html`<div class="grid grid-cols-1 gap-4 min-[900px]:grid-cols-[repeat(3,minmax(260px,1fr))]">${envs.map((e) => column(i, e, now, selected))}</div>`;
}
