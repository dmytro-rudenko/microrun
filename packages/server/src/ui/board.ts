import type { I18n } from '@microrun/core/i18n';
import type { ReleaseState } from '@microrun/core/state';
import type { DiffEntry } from '@microrun/core/schema';
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
  storing: boolean;
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

export const short = (sha: string) => sha.slice(0, 7);

export const prodTag = (i: I18n, e: EnvVM) => (e.isProduction ? html`<span class="tag">${tr(i, 'env.prodTag')}</span>` : null);

export const windowText = (i: I18n, e: EnvVM) => i.left(e.retentionS * 1000);

export const stateLabel = (i: I18n, s: ReleaseState) => tr(i, `state.${s}`);

export const agentBadge = (i: I18n, e: EnvVM) =>
  html`<span class="agent${e.agentOnline ? '' : ' off'}">● ${tr(i, e.agentOnline ? 'agent.online' : 'agent.offline')}</span>`;

export const markerText = (i: I18n, w: EnvVM['markerWarnings'][number]) =>
  html`<b>${tr(i, 'marker.title')}</b> ${tr(i, 'marker.text', { svc: w.svc, other: w.other, url: w.url === undefined ? '—' : maskUrl(w.url) })}`;

export const offlineAlert = (i: I18n, e: EnvVM) => (e.agentOnline ? null : html`<div class="alert w">${tr(i, 'agent.offlineLong')}</div>`);

export function diffView(i: I18n, r: ReleaseVM, box = false): Html {
  if (!r.diff.length) return html`<span class="small">${tr(i, 'schema.none')}</span>`;
  return html`<div class="diff${box ? ' box' : ''}">${r.diff.map((d) => html`<div class="${d.kind}">${SIGNS[d.kind]} ${d.object}: ${d.detail}</div>`)}</div>`;
}

export const blockedNote = (i: I18n, r: ReleaseVM) =>
  r.blocked && html`<div class="small blocked">${tr(i, 'note.blocked', { at: i.date(r.blocked.at), to: short(r.blocked.to) })}</div>`;

export const failNote = (i: I18n, r: ReleaseVM) =>
  r.failNote && html`<div class="small failed">${codeText(i, r.failNote.code, r.failNote.params)}</div>`;

export const unstored = (r: ReleaseVM) => !r.stored && !r.storing && (r.state === 'active' || r.state === 'available');

export const storageWarn = (i: I18n) => html`<div class="alert w">${tr(i, 'storage.failedWarn')}</div>`;

export const notes = (i: I18n, r: ReleaseVM) => html`${blockedNote(i, r)}${failNote(i, r)}`;

export const windowLeft = (i: I18n, r: ReleaseVM) => (r.windowLeftMs === null ? null : i.left(r.windowLeftMs));

export const windowBar = (r: ReleaseVM, cls = '') =>
  r.windowLeftMs === null || r.windowPct === null ? null : html`<div class="bar${cls}"><i style="width:${Math.round(r.windowPct)}%"></i></div>`;

function card(i: I18n, e: EnvVM, r: ReleaseVM, now: number, selected?: string): Html {
  const left = windowLeft(i, r);
  return html`<div class="rel ${r.state}${r.id === selected ? ' sel' : ''}" data-testid="rel-${e.name}-${short(r.sha)}" data-state="${r.state}" hx-get="/panel/${r.id}" hx-target="#panel" hx-trigger="click, keydown[key=='Enter']" tabindex="0" role="button">
<span class="st">${stateLabel(i, r.state)}</span><span class="sha">${short(r.sha)}</span><div>${r.message}</div>
<div class="small">${r.author} · ${i.ago(r.deployedAt, now)}${left && html` · ${tr(i, 'window.left', { t: left })}`}</div>${windowBar(r)}${unstored(r) && storageWarn(i)}</div>`;
}

function column(i: I18n, e: EnvVM, now: number, selected?: string): Html {
  return html`<section class="col${e.isProduction ? ' prod' : ''}" data-testid="col-${e.name}">
<div class="ch"><h2><a href="/env/${e.id}">${e.name}</a></h2>${prodTag(i, e)}</div>
<div class="meta">${tr(i, 'env.branch', { b: e.branch })} · ${tr(i, 'env.window', { w: windowText(i, e) })} · ${agentBadge(i, e)}</div>
${e.markerWarnings.length > 0 && html`<div class="alert">⚠ ${tr(i, 'marker.short')}</div>`}${offlineAlert(i, e)}
<div class="tl">${e.releases.map((r) => card(i, e, r, now, selected))}</div>
<div class="small more"><a class="back" href="/env/${e.id}">${tr(i, 'env.open')}</a></div></section>`;
}

export function boardView(i: I18n, envs: EnvVM[], now: number, selected?: string): Html {
  return html`<div class="cols">${envs.map((e) => column(i, e, now, selected))}</div>`;
}
