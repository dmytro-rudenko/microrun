(function () {
  const { C, fmt, esc, issues, serverOf, svcName } = MR;
  const { short, ago, left, num } = fmt;
  const PAGE = 20;

  function envHead(e) {
    const srv = serverOf(e);
    return `<div class="e-head"><h1 class="e-name">${esc(e.name)}${e.stage === 'prod' ? ' <span class="tag-prod">Production</span>' : ''}</h1>
<dl class="e-meta"><div><dt>Branch</dt><dd>${esc(e.branch)}</dd></div><div><dt>Server</dt><dd>${esc(e.server)} <span class="${e.online ? 'on' : 'off'}">● ${e.online ? 'agent online' : `agent offline, last seen ${ago(srv.lastSeen)}`}</span></dd></div><div><dt>Services</dt><dd>${e.services.map((s) => `${svcName(s)} <span class="p-meta">(${s.split(':')[1]})</span>`).join(', ')}</dd></div><div><dt>Rollback window</dt><dd>${left(e.win)}</dd></div><div><dt>Images saved to</dt><dd>${e.storage === 's3' ? 'S3 bucket' : 'Local disk'}</dd></div></dl>
${issues(e).map((i) => `<p class="note n-${i.tone === 'info' ? 'info' : 'warn'}">${i.text}</p>`).join('')}</div>`;
  }

  const relRow = (r, sel) => `<li class="r-row r-${r.state}${sel === r.id ? ' sel' : ''}" data-rel="${r.id}" tabindex="0" role="button"><span class="sha">${short(r.sha)}</span><span class="r-msg">${esc(r.message)}<small>${esc(r.author)} · ${ago(r.at)}${r.diff.length ? ' · schema change' : ''}</small></span><span class="badge s-${r.state}">${C.state[r.state]}</span><span class="r-win num">${r.windowLeft ? `${left(r.windowLeft)} left` : ''}</span></li>`;

  function releases(e, shown, sel) {
    if (!e.releases.length) return `<p class="note">${C.noReleases}</p>`;
    const live = e.releases.filter((r) => r.state !== 'expired');
    const old = e.releases.filter((r) => r.state === 'expired');
    const rest = old.length - shown;
    return `<h3 class="e-h3">Within the rollback window <span class="cnt num">${live.length}</span></h3><ul class="r-list">${live.map((r) => relRow(r, sel)).join('')}</ul>
${old.length ? `<h3 class="e-h3">Older releases <span class="cnt num">${num(old.length)}</span></h3><p class="p-meta">Kept as a record. You can’t roll back to them.</p>${shown ? `<ul class="r-list">${old.slice(0, shown).map((r) => relRow(r, sel)).join('')}</ul>` : ''}${rest > 0 ? `<button class="btn btn-ghost more" type="button" data-more>${C.showOlder(Math.min(PAGE, rest))}<span class="p-meta">${num(rest)} not shown</span></button>` : ''}` : ''}`;
  }

  const fld = (label, value, hint) => `<label class="f"><span class="f-l">${label}</span><input value="${esc(value)}" readonly>${hint ? `<span class="p-meta">${hint}</span>` : ''}</label>`;
  const area = (label, lines, hint) => `<label class="f f-wide"><span class="f-l">${label}</span><textarea rows="${Math.max(2, lines.length)}" readonly>${esc(lines.join('\n'))}</textarea>${hint ? `<span class="p-meta">${hint}</span>` : ''}</label>`;

  function settings(e) {
    const srv = serverOf(e);
    return `<form class="settings" onsubmit="return false">
<fieldset><legend>General</legend><div class="f-grid">${fld('Name', e.name)}${fld('Branch', e.branch, 'Each branch deploys to one environment.')}
<label class="f f-check"><input type="checkbox"${e.stage === 'prod' ? ' checked' : ''} disabled> Production environment</label></div>
<div class="srv"><div><b>Server</b> ${esc(e.server)}${srv.builtin ? ' <span class="p-meta">(built-in)</span>' : ''}</div><div class="${e.online ? 'on' : 'off'}">● ${e.online ? 'agent online' : 'agent offline'}</div><a href="#" onclick="return false">Change server</a></div></fieldset>
<fieldset><legend>Compose</legend><div class="f-grid">${fld('Compose project', e.name)}${fld('Compose directory', `/srv/${e.name}`)}${area('Compose files', ['compose.yml'])}${area('Services', e.services, 'One per line: name:rolling or name:recreate.')}</div></fieldset>
<fieldset><legend>Database</legend><div class="f-grid">${fld('Database type', 'PostgreSQL')}${fld('Database URL variable', 'DATABASE_URL')}</div><button class="btn btn-ghost" type="button">Verify and bind database</button></fieldset>
<fieldset><legend>Commands and checks</legend><div class="f-grid">${fld('Schema check', e.stage === 'prod' ? 'Dry run before deploy' : 'Check after deploy')}${fld('Cleanup command', e.cleanup ? 'node scripts/cleanup.mjs' : '')}</div></fieldset>
<fieldset><legend>Image storage and rollback window</legend><div class="f-grid">${fld('Image storage', e.storage === 's3' ? 'S3' : 'Local disk')}${fld('Rollback window', left(e.win), 'At least 1 hour.')}</div></fieldset>
<div class="f-save"><button class="btn btn-primary" type="button">Save changes</button><button class="btn btn-ghost" type="button">Reissue deploy token</button></div>
<fieldset class="danger"><legend>Danger zone</legend><p class="p-meta">Deleting removes this environment’s releases, history and deploy token. Containers, images and the database on the server stay.</p><button class="btn btn-danger" type="button">Delete environment</button></fieldset></form>`;
  }

  function mountEnv(host, e, opts = {}) {
    let shown = 0;
    let sel = null;
    const draw = () => {
      host.innerHTML = `${opts.top || ''}${envHead(e)}
<nav class="jump${e.stage === 'prod' ? ' j-prod' : ''}"><b>${esc(e.name)}</b><a href="#" data-to="sec-rel">Releases <span class="num">${num(e.releases.length)}</span></a><a href="#" data-to="sec-set">Settings</a></nav>
<section id="sec-rel" class="e-sec"><h2 class="e-h2">Releases</h2>${releases(e, shown, sel)}</section>
<section id="sec-set" class="e-sec"><h2 class="e-h2">Settings</h2>${settings(e)}</section>`;
      host.querySelector('[data-more]')?.addEventListener('click', () => { shown += PAGE; draw(); });
      host.querySelectorAll('[data-to]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); host.querySelector(`#${a.dataset.to}`).scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
      host.querySelectorAll('[data-rel]').forEach((li) => {
        const go = () => { sel = li.dataset.rel; host.querySelectorAll('.r-row.sel').forEach((x) => x.classList.remove('sel')); li.classList.add('sel'); opts.onRelease(e, e.releases.find((r) => r.id === sel), draw); };
        li.addEventListener('click', go);
        li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
      });
    };
    draw();
    return draw;
  }

  function openPanel(host, e, r, onDone, onClose) {
    host.innerHTML = `<button class="x" type="button" aria-label="${C.close}">×</button>${MR.panel(e, r)}`;
    host.classList.add('open');
    host.classList.toggle('prod', e.stage === 'prod');
    host.scrollTop = 0;
    host.querySelector('.x').addEventListener('click', () => { closePanel(host); onClose && onClose(); });
    MR.wirePanel(host, e, onDone);
    host.querySelector('.x').focus({ preventScroll: true });
  }
  function closePanel(host) { host.classList.remove('open'); host.innerHTML = ''; }

  Object.assign(MR, { envHead, releases, mountEnv, openPanel, closePanel, PAGE });
})();
