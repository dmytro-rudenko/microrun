(function () {
  const NOW = Date.UTC(2026, 10, 22, 19, 40);
  const MIN = 60e3, H = 60 * MIN, D = 24 * H;
  let seed = 20261122;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const sha = () => Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');

  const PROJECTS = ['billing', 'checkout', 'catalog', 'search', 'auth', 'notifications', 'media', 'reports', 'admin', 'mobile-api', 'webhooks', 'ledger'];
  const SERVERS = [
    { name: 'local', builtin: true, online: true },
    { name: 'hel-1', online: true },
    { name: 'hel-2', online: true },
    { name: 'nbg-1', online: true },
    { name: 'fsn-1', online: true },
    { name: 'fsn-2', online: false, lastSeen: NOW - 47 * MIN },
  ];
  const AUTHORS = ['olena.k', 'mark.t', 'dmytro', 'sara.v', 'ivan.p', 'lena.m', 'tom.w'];
  const VERBS = ['Fix', 'Add', 'Update', 'Remove', 'Refactor', 'Speed up', 'Handle', 'Log'];
  const THINGS = ['invoice rounding for EUR', 'retry on 502 from payment provider', 'pagination in order list', 'N+1 query on product page', 'token refresh race', 'webhook signature check', 'image resize queue', 'CSV export timeout', 'admin audit log', 'push notification batching', 'search ranking for exact SKU matches', 'ledger reconciliation job', 'empty cart crash on iOS 18', 'rate limiter for the public API', 'timezone in the daily sales report', 'stale cache after a price change', 'GDPR export for deleted users', 'missing translations in checkout emails'];
  const DIFFS = [
    { kind: 'add', object: 'orders.refund_reason', detail: 'new column, text, nullable' },
    { kind: 'add', object: 'idx_orders_created_at', detail: 'new index' },
    { kind: 'add', object: 'payouts', detail: 'new table' },
    { kind: 'warn', object: 'users.email', detail: 'type varchar(255) → text' },
    { kind: 'drop', object: 'sessions.legacy_token', detail: 'column removed' },
  ];
  const SERVICES = { billing: ['api:rolling', 'worker:recreate'], checkout: ['web:rolling', 'api:rolling', 'worker:recreate'], catalog: ['api:rolling'], search: ['api:rolling', 'indexer:recreate'], auth: ['api:rolling'], notifications: ['worker:recreate'], media: ['api:rolling', 'resizer:recreate'], reports: ['web:rolling', 'cron:recreate'], admin: ['web:rolling'], 'mobile-api': ['api:rolling'], webhooks: ['receiver:rolling', 'worker:recreate'], ledger: ['api:rolling', 'cron:recreate'] };
  const STAGES = {
    prod: { n: [24, 48], every: 0.9 * D, win: 14 * D, servers: ['hel-1', 'hel-2', 'nbg-1'] },
    stage: { n: [14, 34], every: 0.45 * D, win: 7 * D, servers: ['fsn-1', 'hel-2'] },
    dev: { n: [8, 22], every: 0.25 * D, win: 3 * D, servers: ['fsn-1', 'local'] },
    preview: { n: [1, 4], every: 3 * H, win: 2 * D, servers: ['local', 'local', 'fsn-1', 'fsn-2'] },
  };
  const FAILED = new Set(['search-prod', 'media-dev', 'ledger-stage', 'checkout-pr-1871']);
  const BLOCKED = new Set(['billing-prod', 'auth-stage']);
  const MISMATCH = new Set(['reports-stage']);
  const UNSTORED = new Set(['catalog-prod']);
  const CONTRACT = new Set(['notifications-prod']);

  function releases(env, n, every, win) {
    const out = [];
    let t = NOW - rnd() * every * 0.8;
    for (let k = 0; k < n; k++) {
      out.push({ id: `${env.name}-${k}`, sha: sha(), message: `${pick(VERBS)} ${pick(THINGS)}`, author: pick(AUTHORS), ci: rnd() < 0.8, at: Math.round(t), took: int(18, 140), diff: rnd() < 0.72 ? [] : [pick(DIFFS.slice(0, 4))] });
      t -= every * (0.35 + rnd() * 1.3);
    }
    if (FAILED.has(env.name)) out[0].diff = [DIFFS[4]];
    const top = FAILED.has(env.name) || BLOCKED.has(env.name) ? 1 : 0;
    out.forEach((r, k) => {
      if (k < top) { r.state = FAILED.has(env.name) ? 'failed' : 'blocked'; r.windowLeft = null; return; }
      if (k === top) { r.state = 'active'; r.windowLeft = null; return; }
      const left = win - (NOW - out[k - 1].at);
      r.state = left > 0 ? 'available' : 'expired';
      r.windowLeft = left > 0 ? left : null;
    });
    if (BLOCKED.has(env.name)) { out[0].blockedAt = out[0].at + 40 * MIN; out[0].blockedTo = out[1]; }
    if (UNSTORED.has(env.name)) out[0].unstored = true;
    if (CONTRACT.has(env.name)) out[0].contractFailed = true;
    return out;
  }

  const envs = [];
  for (const p of PROJECTS) {
    for (const stage of ['prod', 'stage', 'dev']) {
      const s = STAGES[stage];
      const name = `${p}-${stage}`;
      const env = { id: name, name, project: p, stage, branch: stage === 'prod' ? 'main' : stage === 'stage' ? `release/${p}` : `develop/${p}`, server: pick(s.servers), win: s.win, services: SERVICES[p], db: 'postgres · DATABASE_URL', storage: stage === 'prod' ? 's3' : 'local', cleanup: stage !== 'preview' };
      if (name === 'reports-stage') env.server = 'fsn-1';
      if (name === 'checkout-stage') env.server = 'fsn-2';
      const n = name === 'checkout-prod' ? 140 : int(...s.n);
      env.releases = releases(env, n, s.every, s.win);
      envs.push(env);
    }
  }
  const BRANCHES = ['fix-refund-rounding', 'new-onboarding', 'sku-search', 'apple-pay', 'bulk-export', 'retry-policy', 'pdf-invoices', 'faster-images', 'audit-filters', 'stripe-v3', 'sso-okta', 'tax-ids'];
  let pr = 1802;
  while (envs.length < 100) {
    const last = envs.length === 99;
    const p = last ? 'checkout' : pick(PROJECTS);
    pr += int(1, 9);
    const name = last ? 'checkout-pr-1871' : `${p}-pr-${pr}`;
    const env = { id: name, name, project: p, stage: 'preview', branch: `feature/${pick(BRANCHES)}-${pr}`, server: pick(STAGES.preview.servers), win: STAGES.preview.win, services: SERVICES[p], db: 'postgres · DATABASE_URL', storage: 'local', cleanup: false };
    env.releases = releases(env, int(...STAGES.preview.n), STAGES.preview.every, STAGES.preview.win);
    envs.push(env);
  }

  const serverOf = (e) => SERVERS.find((s) => s.name === e.server);
  const refresh = (e) => {
    e.active = e.releases.find((r) => r.state === 'active') || null;
    e.last = e.releases[0];
    e.rollbackable = e.releases.filter((r) => r.state === 'available').length;
  };
  for (const e of envs) { e.online = serverOf(e).online; e.mismatch = MISMATCH.has(e.name); refresh(e); }

  const short = (s) => s.slice(0, 7);
  const num = (n) => new Intl.NumberFormat('en').format(n);
  function ago(t) {
    const s = (NOW - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    const d = Math.round(s / 86400);
    return d === 1 ? 'yesterday' : `${d} days ago`;
  }
  function left(ms) {
    if (ms >= D) { const d = Math.floor(ms / D); return d === 1 ? '1 day' : `${d} days`; }
    if (ms >= H) return `${Math.floor(ms / H)} h`;
    return `${Math.max(1, Math.floor(ms / MIN))} min`;
  }
  const date = (t) => new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(t);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const svcName = (s) => s.split(':')[0];

  const C = {
    state: { active: 'Live', available: 'Can roll back', blocked: 'Rolled back', expired: 'Window closed', failed: 'Deploy failed' },
    search: 'Search environments, branches or commits',
    noMatch: (q) => `No environment, branch or commit matches “${q}”.`,
    clearSearch: 'Clear search',
    mismatchShort: 'Connected to another environment’s database',
    failedShort: (s) => `Deploy of ${s} failed`,
    blockedShort: (s) => `${s} was rolled back`,
    offlineShort: (srv) => `Server ${srv} is offline`,
    unstoredShort: 'Live image is not saved for rollback',
    contractShort: 'Contract step failed',
    windowLeft: (t) => `${t} left to roll back to this release.`,
    rollbackTo: (s) => `Roll back to ${s}`,
    rollbackPrev: (s) => `Roll back to ${s}`,
    rollbackFromLive: (s) => `This release is live. You can roll back to the previous one, ${s}.`,
    willBlock: 'After the rollback, these commits can’t be deployed again:',
    schemaKept: 'The database schema stays as it is. No data is deleted.',
    askProd: (n, s) => `Roll back production ${n} to ${s}?`,
    yesRollback: 'Yes, roll back',
    cancel: 'Cancel',
    offlineAction: (srv, t) => `Rollback is unavailable: server ${srv} went offline ${t}.`,
    mismatchAction: 'Rollback is unavailable until the database mismatch is fixed.',
    rollingBack: 'Rolling back…',
    rolledBack: (s, sec) => `Rolled back to ${s} in ${sec} s`,
    noPrev: 'This release is live. There is no earlier release to roll back to.',
    expiredNote: (t) => `The rollback window closed ${t}. The image is no longer stored.`,
    blockedNote: (t, to) => `Rolled back to ${to} ${t}. Deploying this commit again is refused; push the fix as a new commit.`,
    failedNote: (col) => `The dry run stopped this deploy: the migration removes ${col}. The database was not changed.`,
    approveTitle: 'Allow the column removal',
    approveText: 'Approving lets this commit deploy once, with the migration that removes the column.',
    approve: 'Approve and deploy',
    unstored: 'The image of this release could not be saved to storage, so you can’t roll back to it later. Check the storage settings.',
    contract: (s) => `The contract step of ${s} failed. It does not retry by itself.`,
    contractRetry: 'Retry contract step',
    cleanTitle: (s) => `Delete data written by ${s}?`,
    cleanSub: 'Optional. The rollback is already done. Counts come from a dry run of your cleanup command.',
    cleanDelete: (n) => (n === 1 ? 'Delete 1 record' : `Delete ${num(n)} records`),
    cleanSkip: 'Keep the data',
    cleanDone: 'Data deleted',
    schemaNone: 'No schema changes',
    history: 'History of this release',
    historyEmpty: 'No operations yet.',
    showOlder: (n) => `Show ${n} older`,
    noReleases: 'Nothing deployed yet. Releases appear after the first deploy from CI.',
    close: 'Close',
  };

  function issues(e) {
    const out = [];
    if (e.mismatch) out.push({ tone: 'bad', kind: 'mismatch', text: C.mismatchShort });
    if (e.last.state === 'failed') out.push({ tone: 'warn', kind: 'failed', text: C.failedShort(short(e.last.sha)) });
    if (e.last.state === 'blocked') out.push({ tone: 'info', kind: 'blocked', text: C.blockedShort(short(e.last.sha)) });
    if (e.active && e.active.unstored) out.push({ tone: 'warn', kind: 'unstored', text: C.unstoredShort });
    if (e.last.contractFailed) out.push({ tone: 'warn', kind: 'contract', text: C.contractShort });
    if (!e.online) out.push({ tone: 'warn', kind: 'offline', text: C.offlineShort(e.server) });
    return out;
  }

  function historyOf(e, r) {
    const k = e.releases.indexOf(r);
    const prev = e.releases[k + 1];
    const by = r.ci ? `CI: github-actions (${r.author})` : r.author;
    const h = [];
    if (r.state === 'failed') h.push({ at: r.at, kind: 'Deploy', from: prev, to: r, status: 'Refused', bad: true, by, reason: 'The dry run found a destructive schema change.' });
    else h.push({ at: r.at, kind: 'Deploy', from: prev, to: r, status: 'Succeeded', by, took: r.took });
    if (r.blockedAt) h.unshift({ at: r.blockedAt, kind: 'Rollback', from: r, to: r.blockedTo, status: 'Succeeded', by: 'admin', took: 9 });
    if (r.state === 'expired') h.unshift({ at: e.releases[k - 1].at + e.win, kind: 'Rollback window closed', status: 'Done', by: 'microrun' });
    return (r.extraHistory || []).concat(h);
  }

  function targetFor(e, r) {
    if (r.state === 'available') return r;
    if (r.state !== 'active') return null;
    return e.releases.find((x) => x.state === 'available') || null;
  }

  const diffList = (r) => (r.diff.length ? `<ul class="diff">${r.diff.map((d) => `<li class="d-${d.kind}">${d.kind === 'add' ? '+' : d.kind === 'drop' ? '−' : '!'} ${esc(d.object)}: ${esc(d.detail)}</li>`).join('')}</ul>` : `<p class="p-meta">${C.schemaNone}</p>`);

  const historyList = (e, r) => {
    const h = historyOf(e, r);
    return `<section class="p-hist"><h3 class="p-sub">${C.history}</h3>${h.length ? `<ul>${h.map((x) => `<li><div><b>${x.kind}</b>${x.from || x.to ? ` <span class="sha">${x.from ? short(x.from.sha) : '—'} → ${x.to ? short(x.to.sha) : '—'}</span>` : ''} <span class="${x.bad ? 'h-bad' : 'h-ok'}">${x.status}</span></div><div class="p-meta">${date(x.at)} · ${esc(x.by)}${x.took ? ` · ${x.took} s` : ''}</div>${x.reason ? `<div class="p-meta">${x.reason}</div>` : ''}</li>`).join('')}</ul>` : `<p class="p-meta">${C.historyEmpty}</p>`}</section>`;
  };

  function confirmed(e, label, variant, disabled, ask) {
    if (e.stage !== 'prod') return `<button class="btn btn-${variant}" type="submit"${disabled ? ' disabled' : ''}>${label}</button>`;
    return `<button class="btn btn-${variant}" type="button" data-ask${disabled ? ' disabled' : ''}>${label}</button>
<div class="ask" hidden><b>${ask}</b><div class="ask-row"><button class="btn btn-danger" type="submit">${C.yesRollback}</button><button class="btn btn-ghost" type="button" data-back>${C.cancel}</button></div></div>`;
  }

  function panel(e, r) {
    const t = targetFor(e, r);
    const prod = e.stage === 'prod';
    let out = `<div class="p-env"><a href="#env-${e.id}">${esc(e.name)}</a>${prod ? ' <span class="tag-prod">Production</span>' : ''}</div>
<h2 class="p-title" data-rid="${r.id}"><span class="sha">${short(r.sha)}</span> <span class="badge s-${r.state}">${C.state[r.state]}</span></h2>
<p class="p-msg">${esc(r.message)}</p><p class="p-meta">${esc(r.author)} · ${date(r.at)} UTC</p>`;
    if (r.state === 'blocked') out += `<p class="note n-info">${C.blockedNote(ago(r.blockedAt), short(r.blockedTo.sha))}</p>`;
    if (r.state === 'expired') out += `<p class="note">${C.expiredNote(ago(r.at))}</p>`;
    if (r.state === 'available') out += `<p class="note">${C.windowLeft(left(r.windowLeft))}</p>`;
    if (r.unstored) out += `<p class="note n-warn">${C.unstored}</p>`;
    out += `<h3 class="p-sub">Schema changes</h3>${diffList(r)}`;
    if (r.state === 'active' && !t) out += `<p class="p-meta p-gap">${C.noPrev}</p>`;
    if (t) {
      const block = e.releases.filter((x) => x.state === 'active' || (x.state === 'available' && x.at > t.at)).map((x) => `<span class="sha">${short(x.sha)}</span>`).join(', ');
      const reason = !e.online ? C.offlineAction(e.server, ago(serverOf(e).lastSeen)) : e.mismatch ? C.mismatchAction : '';
      out += `<form class="p-action" data-act="rollback" data-target="${t.id}">${r.state === 'active' ? `<p class="p-meta">${C.rollbackFromLive(`<span class="sha">${short(t.sha)}</span>`)}</p>` : ''}
<p class="p-meta">${C.willBlock} ${block}</p><p class="p-meta">${C.schemaKept}</p>
${confirmed(e, C.rollbackTo(short(t.sha)), prod ? 'danger' : 'primary', !!reason, C.askProd(esc(e.name), short(t.sha)))}
${reason ? `<p class="note n-warn">${reason}</p>` : ''}</form>`;
    }
    if (r.state === 'failed') out += `<form class="p-action" data-act="approve"><p class="note n-warn">${C.failedNote('sessions.legacy_token')}</p><b>${C.approveTitle}</b><p class="p-meta">${C.approveText}</p>${confirmed(e, C.approve, 'danger', false, `Deploy ${short(r.sha)} to production with the column removal?`)}</form>`;
    if (r.contractFailed) out += `<form class="p-action" data-act="contract"><p class="note n-warn">${C.contract(short(r.sha))}</p><button class="btn btn-ghost" type="submit">${C.contractRetry}</button></form>`;
    return out + historyList(e, r);
  }

  function cleanupForm(from) {
    const rules = [
      { rule: 'payouts_draft', d: 'Draft payouts created by the new payout flow', n: int(3, 400) },
      { rule: 'refund_reasons', d: 'Refund reasons stored in orders.refund_reason', n: int(0, 1) ? int(20, 3000) : 0 },
    ];
    const total = rules.reduce((s, x) => s + x.n, 0);
    return `<form class="p-action p-clean" data-act="cleanup"><b>${C.cleanTitle(short(from.sha))}</b><p class="p-meta">${C.cleanSub}</p>
${rules.map((x) => `<label class="rule"><input type="checkbox" value="${x.rule}" data-n="${x.n}"${x.n ? ' checked' : ' disabled'}><span><b>${x.rule}</b><span class="p-meta">${x.d}</span></span><span class="num rule-n">${num(x.n)}</span></label>`).join('')}
<button class="btn btn-danger" type="submit"${total ? '' : ' disabled'}>${C.cleanDelete(total)}</button><button class="btn btn-ghost" type="button" data-skip>${C.cleanSkip}</button></form>`;
  }

  function wirePanel(root, e, onDone) {
    root.querySelectorAll('[data-ask]').forEach((b) => b.addEventListener('click', () => { b.hidden = true; const a = b.nextElementSibling; a.hidden = false; a.querySelector('[type=submit]').focus(); }));
    root.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => { const a = b.closest('.ask'); a.hidden = true; a.previousElementSibling.hidden = false; a.previousElementSibling.focus(); }));
    const f = root.querySelector('[data-act=rollback]');
    if (!f) return;
    f.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const t = e.releases.find((x) => x.id === f.dataset.target);
      const from = e.active;
      const steps = [`Image ${short(t.sha)} restored from the saved copy`, ...e.services.flatMap((s) => (s.endsWith('rolling') ? [`${svcName(s)}: new container passed the healthcheck`, `${svcName(s)}: old container stopped`] : [`${svcName(s)}: container recreated`])), 'Newer commits blocked from deploying again'];
      const box = document.createElement('div');
      box.className = 'p-progress';
      box.innerHTML = `<h3 class="p-sub" data-head>${C.rollingBack}</h3><ol class="steps">${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`;
      f.replaceWith(box);
      const lis = box.querySelectorAll('li');
      let k = 0;
      const tick = setInterval(() => {
        lis[k++].classList.add('done');
        if (k < lis.length) return;
        clearInterval(tick);
        e.releases.forEach((x) => { if (x.state === 'active' || (x.state === 'available' && x.at > t.at)) { x.state = 'blocked'; x.blockedAt = NOW; x.blockedTo = t; x.windowLeft = null; } });
        t.state = 'active'; t.windowLeft = null;
        t.extraHistory = [{ at: NOW, kind: 'Rollback', from, to: t, status: 'Succeeded', by: 'admin', took: Math.round(lis.length * 0.5) }];
        refresh(e);
        const head = box.querySelector('[data-head]');
        head.textContent = C.rolledBack(short(t.sha), (lis.length * 0.5).toFixed(1));
        head.classList.add('ok');
        const own = e.releases.find((x) => x.id === root.querySelector('.p-title').dataset.rid);
        const badge = root.querySelector('.p-title .badge');
        badge.className = `badge s-${own.state}`;
        badge.textContent = C.state[own.state];
        root.querySelectorAll('.p-title ~ .note').forEach((n) => n.remove());
        if (e.cleanup && from) {
          box.insertAdjacentHTML('beforeend', cleanupForm(from));
          const cf = box.querySelector('[data-act=cleanup]');
          const btn = cf.querySelector('[type=submit]');
          cf.addEventListener('change', () => { const n = [...cf.querySelectorAll('input:checked')].reduce((s, c) => s + +c.dataset.n, 0); btn.textContent = C.cleanDelete(n); btn.disabled = !n; });
          cf.addEventListener('submit', (x) => { x.preventDefault(); cf.outerHTML = `<p class="p-sub ok">${C.cleanDone}</p>`; });
          cf.querySelector('[data-skip]').addEventListener('click', () => cf.remove());
        }
        onDone && onDone();
      }, 500);
    });
  }

  const total = envs.reduce((n, e) => n + e.releases.length, 0);
  window.MR = { NOW, envs, servers: SERVERS, total, C, issues, panel, wirePanel, targetFor, historyOf, fmt: { ago, left, date, short, num }, esc, serverOf, svcName };
})();
