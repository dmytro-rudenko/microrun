import type { I18n } from '@microrun/core/i18n';
import { codeText, html, raw, tr, type Html } from './html.ts';
import { blockedNote, diffView, prodTag, short, releaseBadge, storageWarn, unstored, type EnvVM, type ReleaseVM } from './board.ts';
import { alert, button, checkbox } from './form.ts';

const ASK = "this.hidden=true;var a=this.nextElementSibling;a.hidden=false;a.querySelector('[type=submit]').focus()";
const BACK = "var a=this.parentNode;a.hidden=true;var g=a.previousElementSibling;g.hidden=false;g.focus()";

const SMALL = 'text-xs text-mute';
const SECT = 'mt-[18px] flex flex-col gap-2 border-t border-line pt-3.5';
const post = (url: string, csrf: string) =>
  html`hx-post="${url}" hx-headers="${JSON.stringify({ 'x-csrf-token': csrf })}" hx-target="#panel"`;

const hidden = (name: string, value: string) => html`<input type="hidden" name="${name}" value="${value}">`;

const confirmedAction = (
  i: I18n,
  env: EnvVM,
  testid: string,
  label: Html,
  variant: 'primary' | 'danger',
  disabled: boolean,
  ask: { text: Html; yes: Html },
): Html =>
  env.isProduction
    ? html`${button({ block: true, variant, type: 'button', testid, disabled, label, attrs: html` onclick="${ASK}"` })}
<div class="[&:not([hidden])]:flex flex-col gap-2" data-testid="confirm-ask" hidden>${hidden('confirm', 'yes')}<b>${ask.text}</b>
${button({ block: true, variant, testid: 'confirm-yes', label: ask.yes })}
${button({ block: true, variant: 'ghost', type: 'button', testid: 'confirm-no', label: tr(i, 'confirm.cancel'), attrs: html` onclick="${BACK}"` })}</div>`
    : button({ block: true, variant, testid, disabled, label });

function rollbackTarget(env: EnvVM, r: ReleaseVM): ReleaseVM | null {
  if (r.state === 'available') return r;
  if (r.state !== 'active') return null;
  return env.releases.filter((x) => x.state === 'available').reduce<ReleaseVM | null>((best, x) => ((x.activationSeq ?? 0) > (best?.activationSeq ?? -1) ? x : best), null);
}

function rollbackSection(i: I18n, env: EnvVM, r: ReleaseVM, target: ReleaseVM, csrf: string): Html {
  const switching = r.state === 'available';
  const targetSha = short(target.sha);
  const current = env.releases.find((x) => x.state === 'active');
  const blocked = env.releases.filter((x) => x.state === 'active' || (x.state === 'available' && (x.activationSeq ?? 0) > (target.activationSeq ?? 0)));
  const reason = !env.agentOnline ? 'rb.noAgent' : env.markerWarnings.length > 0 ? 'rb.noMarker' : null;
  return html`<form class="${SECT}" ${post('/rollback', csrf)}>${hidden('envId', env.id)}${hidden('releaseId', target.id)}
<b>${tr(i, switching ? 'rb.switchTitle' : 'rb.title', { from: current ? short(current.sha) : '—', to: targetSha })}</b>
<div class="${SMALL}">${tr(i, 'rb.willBlock')} ${blocked.flatMap((b, k) => [k ? ', ' : '', html`<span class="font-mono font-bold">${short(b.sha)}</span>`])}</div>
<div class="${SMALL}">${tr(i, 'rb.schema')}</div>
${confirmedAction(i, env, 'rollback-go', tr(i, switching ? 'rb.switch' : 'rb.go'), env.isProduction ? 'danger' : 'primary', reason !== null, {
    text: tr(i, 'rb.ask', { env: env.name, sha: targetSha }),
    yes: tr(i, 'rb.yes'),
  })}
${reason && html`<div class="mt-1.5 text-xs text-prod">${tr(i, reason, reason === 'rb.noAgent' ? { server: env.serverName } : undefined)}</div>`}</form>`;
}

function approveSection(i: I18n, env: EnvVM, r: ReleaseVM, csrf: string): Html {
  const expiring = env.releases.filter((x) => x.state === 'available').map((x) => short(x.sha));
  const params = { sha: short(r.sha), col: r.failNote?.params.col ?? '' };
  return html`<form class="${SECT}" ${post('/approve', csrf)}>${hidden('envId', env.id)}${hidden('commitSha', r.sha)}
<b>${tr(i, 'approve.title')}</b>
<div class="${SMALL}">${tr(i, 'approve.text', params)}</div>
${expiring.length > 0 && html`<div class="${SMALL}">${tr(i, 'approve.expires', { list: expiring.join(', ') })}</div>`}
${confirmedAction(i, env, 'approve-destructive', tr(i, 'approve.go'), 'danger', false, {
    text: tr(i, 'approve.ask', params),
    yes: tr(i, 'approve.yes'),
  })}</form>`;
}

function retryForm(url: string, csrf: string, releaseId: string, body: Html, testid: string, label: Html, formTestid?: string): Html {
  return html`<form class="${SECT}"${formTestid && html` data-testid="${formTestid}"`} ${post(url, csrf)}>${hidden('releaseId', releaseId)}${body}
${button({ block: true, variant: 'ghost', testid, label })}</form>`;
}

function contractSection(i: I18n, r: ReleaseVM, csrf: string): Html {
  const body = alert({ tone: 'warn', body: tr(i, 'contract.failed', { sha: short(r.sha) }) });
  return retryForm('/contract/retry', csrf, r.id, body, 'contract-retry', tr(i, 'contract.retry'));
}

function failSection(i: I18n, env: EnvVM, r: ReleaseVM, csrf: string): Html | null {
  const f = r.failNote;
  if (!f) return null;
  if (f.code === 'CONTRACT_FAILED') return contractSection(i, r, csrf);
  if (f.code === 'STORAGE_FAILED') return unstored(r) ? null : storageWarn(i);
  const text = html`<div class="text-xs text-warn">${codeText(i, f.code, f.params)}</div>`;
  return f.code === 'SCHEMA_DESTRUCTIVE' ? html`${text}${approveSection(i, env, r, csrf)}` : text;
}

const COUNT_SAMPLES = [...Array.from({ length: 200 }, (_, k) => k), 0.5, 1.5, 2.5];

function applyLabels(i: I18n): Html {
  const plural = new Intl.PluralRules(i.lang);
  return html`${plural.resolvedOptions().pluralCategories.flatMap((category) => {
    const n = COUNT_SAMPLES.find((k) => plural.select(k) === category);
    return n === undefined ? [] : [html` data-label-${category}="${i.t('cl.delete', { n }).replace(i.num(n), '{n}')}"`];
  })}`;
}

export function cleanupView(i: I18n, r: ReleaseVM, csrf: string): Html {
  const rules = r.cleanupPreview;
  if (!rules) {
    if (r.cleanupState !== 'pending') return html``;
    const f = r.cleanupFailed;
    return f
      ? retryForm(
        '/cleanup/preview', csrf, r.id,
        html`<div class="text-xs text-warn">${codeText(i, f.code, f.params)}</div>`,
        'cleanup-retry', tr(i, 'cl.retry'), 'cleanup-failed',
      )
      : html`<div class="${SECT}" data-testid="cleanup-pending" hx-get="/panel/${r.id}" hx-target="#panel" hx-trigger="every 2s" hx-swap="innerHTML"><div class="${SMALL}">${tr(i, 'cl.preparing')}</div></div>`;
  }
  if (r.cleanupState === 'applied') {
    const applied = rules.flatMap((x) => {
      const res = r.cleanupResult?.find((y) => y.rule === x.rule);
      return res ? [{ rule: x.rule, expected: x.count, deleted: res.deleted }] : [];
    });
    return html`<div class="${SECT}" data-testid="cleanup-result"><p class="font-semibold text-ok">${tr(i, 'cl.done')}</p>${applied.map(
      (x) => html`<div class="${SMALL}">${tr(i, 'cl.result', { rule: x.rule, p: i.num(x.expected), a: i.num(x.deleted) })}</div>${
        x.deleted !== x.expected && alert({ tone: 'warn', body: codeText(i, 'CLEANUP_MISMATCH', { expected: i.num(x.expected) }) })
      }`,
    )}</div>`;
  }
  if (r.cleanupState !== 'pending') return html``;
  const total = rules.reduce((n, x) => n + x.count, 0);
  const recount =
    "var b=this.querySelector('[data-testid=cleanup-apply]'),s=0,l=document.documentElement.lang;this.querySelectorAll('input:checked').forEach(function(c){s+=+c.dataset.n});b.textContent=(b.getAttribute('data-label-'+new Intl.PluralRules(l).select(s))||b.getAttribute('data-label-other')).replace('{n}',new Intl.NumberFormat(l).format(s));b.disabled=!s";
  return html`<form class="${SECT}" ${post('/cleanup/apply', csrf)} onchange="${recount}">${hidden('releaseId', r.id)}
<b>${tr(i, 'cl.title', { sha: short(r.sha) })}</b><div class="${SMALL}">${tr(i, 'cl.sub')}</div>
${rules.map(
  (x) => html`<label class="my-1.5 flex items-start gap-2 rounded-md border border-line p-2" data-testid="cleanup-rule-${x.rule}">${checkbox({
    name: 'rules',
    checked: x.count > 0,
    attrs: html` value="${x.rule}" data-n="${x.count}"${x.count ? '' : raw(' disabled')}`,
  })}<div><b>${x.rule}</b><div class="${SMALL}">${x.description}</div></div><span class="ml-auto whitespace-nowrap font-bold">${i.num(x.count)}</span></label>`,
)}
${button({ block: true, variant: 'danger', testid: 'cleanup-apply', disabled: !total, attrs: applyLabels(i), label: tr(i, 'cl.delete', { n: total }) })}
${button({ block: true, variant: 'ghost', type: 'button', testid: 'cleanup-skip', attrs: html` hx-post="/cleanup/dismiss"`, label: tr(i, 'cl.skip') })}</form>`;
}

function rollbackBlock(i: I18n, env: EnvVM, r: ReleaseVM, csrf: string): Html | null {
  const target = rollbackTarget(env, r);
  return target && rollbackSection(i, env, r, target, csrf);
}

export function panelView(i: I18n, env: EnvVM, r: ReleaseVM, csrf: string, history: Html): Html {
  return html`<div class="${env.isProduction ? 'in prod p-5' : 'in p-5'}" data-testid="panel" data-release="${r.id}">
<button class="float-right border-0 bg-transparent px-1 text-[22px] text-mute" type="button" onclick="this.closest('#panel').replaceChildren()" aria-label="${i.t('close')}">×</button>
<div class="${SMALL}"><a href="/env/${env.id}" class="text-accent no-underline hover:underline">${env.name}</a> ${prodTag(i, env)}</div>
<div id="panel-alert"></div>
<h2 class="my-1 text-2xl font-bold"><span class="font-mono font-bold">${short(r.sha)}</span> ${releaseBadge(i, r.state)}</h2><div>${r.message}</div>
<div class="mt-1 mb-3 text-xs text-mute">${r.author} · ${i.date(r.deployedAt)}</div>${blockedNote(i, r)}${unstored(r) && storageWarn(i)}
<div class="mt-2.5 mb-1 text-xs text-mute">${tr(i, 'col.schema')}</div>${diffView(i, r, true)}
${rollbackBlock(i, env, r, csrf)}
${failSection(i, env, r, csrf)}${cleanupView(i, r, csrf)}${history}</div>`;
}

const watchOperation = (opId: string) =>
  html`<script>(function(){var s=new EventSource(${raw(JSON.stringify(`/ops/${encodeURIComponent(opId)}/events`))});s.addEventListener('steps',function(e){document.getElementById('steps').innerHTML=e.data});s.addEventListener('done',function(e){s.close();htmx.swap('#panel',e.data,{swapStyle:'innerHTML'})})})()</script>`;

export function opProgressView(i: I18n, opId: string, steps: { label: string; done: boolean }[], doneSeconds: number | null): Html {
  const head =
    doneSeconds === null
      ? html`<h2 class="my-1 text-2xl font-bold">${tr(i, 'rb.running')}</h2>`
      : html`<h2 class="my-1 text-2xl font-bold text-ok" data-testid="rollback-done" data-seconds="${doneSeconds}">${tr(i, 'rb.done', { s: i.unit(doneSeconds, 'second') })}</h2>`;
  // routes/ui.ts extracts the step items with /<ul class="steps" id="steps">/.
  return html`<div class="in p-5" data-testid="panel">${head}<ul class="steps" id="steps">${steps.map(
    (s) => html`<li class="${s.done ? "py-0.5 text-ink before:text-ok before:content-['✓_']" : 'py-0.5 text-mute'}">${s.label}</li>`,
  )}</ul>${doneSeconds === null && watchOperation(opId)}</div>`;
}
