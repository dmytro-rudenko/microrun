import type { I18n } from '@microrun/core/i18n';
import { codeText, html, raw, tr, type Html } from './html.ts';
import { blockedNote, diffView, prodTag, short, stateLabel, storageWarn, unstored, type EnvVM, type ReleaseVM } from './board.ts';

const ASK = "this.hidden=true;this.nextElementSibling.hidden=false";
const BACK = "var a=this.parentNode;a.hidden=true;a.previousElementSibling.hidden=false";

const post = (url: string, csrf: string) =>
  html`hx-post="${url}" hx-headers="${JSON.stringify({ 'x-csrf-token': csrf })}" hx-target="#panel"`;

const hidden = (name: string, value: string) => html`<input type="hidden" name="${name}" value="${value}">`;

const confirmedAction = (i: I18n, env: EnvVM, testid: string, label: Html, cls: string, disabled: boolean): Html =>
  env.isProduction
    ? html`<button type="button" class="${cls}" data-testid="${testid}" onclick="${ASK}"${disabled ? ' disabled' : ''}>${label}</button>
<div class="ask" data-testid="confirm-ask" hidden>${hidden('confirm', 'yes')}<b>${tr(i, 'confirm.ask')}</b>
<button type="submit" class="${cls}" data-testid="confirm-yes">${tr(i, 'confirm.yes')}</button>
<button type="button" class="big ghost" data-testid="confirm-no" onclick="${BACK}">${tr(i, 'confirm.no')}</button></div>`
    : html`<button type="submit" class="${cls}" data-testid="${testid}"${disabled ? ' disabled' : ''}>${label}</button>`;

function rollbackTarget(env: EnvVM, r: ReleaseVM): ReleaseVM | null {
  if (r.state === 'available') return r;
  if (r.state !== 'active') return null;
  return env.releases.filter((x) => x.state === 'available').reduce<ReleaseVM | null>((best, x) => ((x.activationSeq ?? 0) > (best?.activationSeq ?? -1) ? x : best), null);
}

function rollbackSection(i: I18n, env: EnvVM, r: ReleaseVM, target: ReleaseVM, csrf: string): Html {
  const switching = r.state === 'available';
  const current = env.releases.find((x) => x.state === 'active');
  const blocked = env.releases.filter((x) => x.state === 'active' || (x.state === 'available' && (x.activationSeq ?? 0) > (target.activationSeq ?? 0)));
  const reason = !env.agentOnline ? 'rb.noAgent' : env.markerWarnings.length > 0 ? 'rb.noMarker' : null;
  return html`<form class="sect" ${post('/rollback', csrf)}>${hidden('envId', env.id)}${hidden('releaseId', target.id)}
<b>${tr(i, switching ? 'rb.switchTitle' : 'rb.title', { from: current ? short(current.sha) : '—', to: short(target.sha) })}</b>
<div class="small willblock">${tr(i, 'rb.willBlock')} ${blocked.flatMap((b, k) => [k ? ', ' : '', html`<span class="sha">${short(b.sha)}</span>`])}</div>
<div class="small">${tr(i, 'rb.schema')}</div>
${confirmedAction(i, env, 'rollback-go', tr(i, switching ? 'rb.switch' : 'rb.go'), `big${env.isProduction ? ' prod' : ''}`, reason !== null)}
${reason && html`<div class="small why">${tr(i, reason)}</div>`}</form>`;
}

function approveSection(i: I18n, env: EnvVM, r: ReleaseVM, csrf: string): Html {
  const expiring = env.releases.filter((x) => x.state === 'available').map((x) => short(x.sha));
  return html`<form class="sect" ${post('/approve', csrf)}>${hidden('envId', env.id)}${hidden('commitSha', r.sha)}
<b>${tr(i, 'approve.title')}</b>
<div class="small">${tr(i, 'approve.text', { sha: short(r.sha), col: r.failNote?.params.col ?? '' })}</div>
${expiring.length > 0 && html`<div class="small">${tr(i, 'closeWindow.text', { list: expiring.join(', ') })}</div>`}
${confirmedAction(i, env, 'approve-destructive', tr(i, 'approve.go'), 'big prod', false)}</form>`;
}

function closeWindowSection(i: I18n, env: EnvVM, r: ReleaseVM, csrf: string): Html {
  const expiring = env.releases.filter((x) => x.state === 'available' && x.deployedAt < r.deployedAt).map((x) => short(x.sha));
  return html`<form class="sect" ${post('/close-window', csrf)}>${hidden('releaseId', r.id)}
<div class="small">${tr(i, 'closeWindow.text', { list: expiring.join(', ') || '—' })}</div>
<button type="submit" class="big ghost" data-testid="close-window">${tr(i, 'closeWindow.go')}</button></form>`;
}

function contractSection(i: I18n, r: ReleaseVM, csrf: string): Html {
  return html`<form class="sect" ${post('/contract/retry', csrf)}>${hidden('releaseId', r.id)}
<div class="alert w">${tr(i, 'contract.failed', { sha: short(r.sha) })}</div>
<button type="submit" class="big ghost" data-testid="contract-retry">${tr(i, 'contract.retry')}</button></form>`;
}

function failSection(i: I18n, env: EnvVM, r: ReleaseVM, csrf: string): Html | null {
  const f = r.failNote;
  if (!f) return null;
  if (f.code === 'CONTRACT_FAILED') return contractSection(i, r, csrf);
  if (f.code === 'STORAGE_FAILED') return unstored(r) ? null : storageWarn(i);
  const text = html`<div class="small failed">${codeText(i, f.code, f.params)}</div>`;
  return f.code === 'SCHEMA_DESTRUCTIVE' ? html`${text}${approveSection(i, env, r, csrf)}` : text;
}

const COUNT_SAMPLES = [...Array.from({ length: 200 }, (_, k) => k), 0.5, 1.5, 2.5];

function applyLabels(i: I18n) {
  const plural = new Intl.PluralRules(i.lang);
  return plural.resolvedOptions().pluralCategories.flatMap((category) => {
    const n = COUNT_SAMPLES.find((k) => plural.select(k) === category);
    return n === undefined ? [] : [html` data-label-${category}="${i.t('cl.delete', { n }).replace(i.num(n), '{n}')}"`];
  });
}

export function cleanupView(i: I18n, r: ReleaseVM, csrf: string): Html {
  const rules = r.cleanupPreview;
  if (!rules) {
    if (r.cleanupState !== 'pending') return html``;
    const f = r.cleanupFailed;
    return f
      ? html`<form class="sect" data-testid="cleanup-failed" ${post('/cleanup/preview', csrf)}>${hidden('releaseId', r.id)}<div class="small failed">${codeText(i, f.code, f.params)}</div>
<button type="submit" class="big ghost" data-testid="cleanup-retry">${tr(i, 'cl.retry')}</button></form>`
      : html`<div class="sect" data-testid="cleanup-pending" hx-get="/panel/${r.id}" hx-target="#panel" hx-trigger="every 2s" hx-swap="innerHTML"><div class="small">${tr(i, 'cl.preparing')}</div></div>`;
  }
  if (r.cleanupState === 'applied') {
    const applied = rules.flatMap((x) => {
      const res = r.cleanupResult?.find((y) => y.rule === x.rule);
      return res ? [{ rule: x.rule, expected: x.count, deleted: res.deleted }] : [];
    });
    return html`<div class="sect" data-testid="cleanup-result"><p class="ok">${tr(i, 'cl.done')}</p>${applied.map(
      (x) => html`<div class="small">${tr(i, 'cl.result', { rule: x.rule, p: i.num(x.expected), a: i.num(x.deleted) })}</div>${
        x.deleted !== x.expected && html`<div class="alert w">${codeText(i, 'CLEANUP_MISMATCH', { expected: i.num(x.expected) })}</div>`
      }`,
    )}</div>`;
  }
  if (r.cleanupState !== 'pending') return html``;
  const total = rules.reduce((n, x) => n + x.count, 0);
  const recount =
    "var b=this.querySelector('[data-testid=cleanup-apply]'),s=0,l=document.documentElement.lang;this.querySelectorAll('input:checked').forEach(function(c){s+=+c.dataset.n});b.textContent=(b.getAttribute('data-label-'+new Intl.PluralRules(l).select(s))||b.getAttribute('data-label-other')).replace('{n}',new Intl.NumberFormat(l).format(s));b.disabled=!s";
  return html`<form class="sect" ${post('/cleanup/apply', csrf)} onchange="${recount}">${hidden('releaseId', r.id)}
<b>${tr(i, 'cl.title', { sha: short(r.sha) })}</b><div class="small">${tr(i, 'cl.sub')}</div>
${rules.map(
  (x) => html`<label class="rule" data-testid="cleanup-rule-${x.rule}"><input type="checkbox" name="rules" value="${x.rule}" data-n="${x.count}"${x.count ? ' checked' : ' disabled'}><div><b>${x.rule}</b><div class="small">${x.description}</div></div><span class="n">${i.num(x.count)}</span></label>`,
)}
<button type="submit" class="big prod" data-testid="cleanup-apply"${applyLabels(i)}${total ? '' : ' disabled'}>${tr(i, 'cl.delete', { n: total })}</button>
<button type="button" class="big ghost" data-testid="cleanup-skip" hx-post="/cleanup/dismiss">${tr(i, 'cl.skip')}</button></form>`;
}

function rollbackBlock(i: I18n, env: EnvVM, r: ReleaseVM, csrf: string): Html | null {
  const target = rollbackTarget(env, r);
  return target && rollbackSection(i, env, r, target, csrf);
}

export function panelView(i: I18n, env: EnvVM, r: ReleaseVM, csrf: string, _now: number): Html {
  return html`<div class="in${env.isProduction ? ' prod' : ''}" data-testid="panel" data-release="${r.id}">
<button class="x" type="button" onclick="this.closest('#panel').replaceChildren()" aria-label="${i.t('close')}">×</button>
<div class="small">${env.name} ${prodTag(i, env)}</div>
<div id="panel-alert"></div>
<h2><span class="sha">${short(r.sha)}</span> <span class="badge b-${r.state}">${stateLabel(i, r.state)}</span></h2><div>${r.message}</div>
<div class="small meta">${r.author} · ${i.date(r.deployedAt)}</div>${blockedNote(i, r)}${unstored(r) && storageWarn(i)}
<div class="small label">${tr(i, 'col.schema')}</div>${diffView(i, r, true)}
${rollbackBlock(i, env, r, csrf)}${r.state === 'available' && closeWindowSection(i, env, r, csrf)}
${failSection(i, env, r, csrf)}${cleanupView(i, r, csrf)}</div>`;
}

const watchOperation = (opId: string) =>
  html`<script>(function(){var s=new EventSource(${raw(JSON.stringify(`/ops/${encodeURIComponent(opId)}/events`))});s.addEventListener('steps',function(e){document.getElementById('steps').innerHTML=e.data});s.addEventListener('done',function(e){s.close();htmx.swap('#panel',e.data,{swapStyle:'innerHTML'})})})()</script>`;

export function opProgressView(i: I18n, opId: string, steps: { label: string; done: boolean }[], doneSeconds: number | null): Html {
  const head =
    doneSeconds === null
      ? html`<h2>${tr(i, 'rb.running')}</h2>`
      : html`<h2 class="ok" data-testid="rollback-done" data-seconds="${doneSeconds}">${tr(i, 'rb.done', { s: i.unit(doneSeconds, 'second') })}</h2>`;
  return html`<div class="in" data-testid="panel">${head}<ul class="steps" id="steps">${steps.map((s) => html`<li class="${s.done ? 'done' : ''}">${s.label}</li>`)}</ul>${doneSeconds === null && watchOperation(opId)}</div>`;
}
