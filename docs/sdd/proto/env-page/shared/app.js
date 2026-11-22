const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rtf = new Intl.RelativeTimeFormat('uk', { numeric: 'auto' });
const ago = (t) => { const m = Math.round((t - NOW) / 60e3); return Math.abs(m) < 60 ? rtf.format(m, 'minute') : Math.abs(m) < 1440 ? rtf.format(Math.round(m / 60), 'hour') : rtf.format(Math.round(m / 1440), 'day'); };
const date = (t) => new Intl.DateTimeFormat('uk', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(t);
const STATE = { active: 'Активний', available: 'Доступний', blocked: 'Заблоковано', expired: 'Вікно минуло', failed: 'Не викатано' };
const UNITS = { hours: 'годин', days: 'днів', weeks: 'тижнів' };
const envById = (id) => ENVS.find((e) => e.id === id);
const srvById = (id) => SERVERS.find((s) => s.id === id);
const activeOf = (e) => e.releases.find((r) => r.state === 'active');
const leftText = (e, r) => r.left == null ? '' : `ще ${Math.round(r.left * e.retention.v)} ${UNITS[e.retention.u]}`;
const agentBadge = (e) => { const s = srvById(e.serverId); return s.online ? `<span class="agent">● агент онлайн</span>` : `<span class="agent off">○ агент офлайн</span>`; };
const prodTag = (e) => (e.prod ? '<span class="tag">PRODUCTION</span>' : '');
const diffView = (r) => r.diff.length ? `<div class="diff">${r.diff.map(([k, t]) => `<div class="${k}">${esc(t)}</div>`).join('')}</div>` : '<span class="small">без змін</span>';

let route = { view: 'board' };
let openRelease = null;
let flash = '';
let newToken = null;

function go(hash) { location.hash = hash; }
function parseHash() {
  const h = location.hash.slice(1);
  if (h === 'new') return { view: 'new' };
  const m = /^env-([a-z]+)(?:-(releases|history|settings))?$/.exec(h);
  return m && envById(m[1]) ? { view: 'env', envId: m[1], tab: m[2] || null } : { view: 'board' };
}

function header() {
  return `<header><b onclick="go('board')">microrun</b><span class="sp"></span>
<button class="primary" onclick="go('new')">+ Нове оточення</button>
<select aria-label="Мова" id="lang"><option>Українська</option><option>English</option></select></header>
<div class="proto-note">Прототип · варіант ${VARIANT.letter}: ${esc(VARIANT.title)}. Дані вигадані, нічого не зберігається.</div>`;
}

function board() {
  return `<div class="cols">${ENVS.map((e) => `<section class="col${e.prod ? ' prod' : ''}">
<div class="ch"><h2><a href="#env-${e.id}">${esc(e.name)}</a></h2>${prodTag(e)}</div>
<div class="meta">гілка ${esc(e.branch)} · вікно ${e.retention.v} ${UNITS[e.retention.u]} · ${agentBadge(e)}</div>
<div class="tl">${e.releases.map((r) => `<div class="rel ${r.state}" tabindex="0" role="button" onclick="openPanel('${e.id}','${r.id}')" onkeydown="if(event.key==='Enter')openPanel('${e.id}','${r.id}')">
<span class="st">${STATE[r.state]}</span><span class="sha">${r.sha}</span><div>${esc(r.msg)}</div>
<div class="small">${esc(r.author)} · ${ago(r.at)}${r.left != null ? ` · ${leftText(e, r)}` : ''}</div>${r.left != null ? `<div class="bar"><i style="width:${r.left * 100}%"></i></div>` : ''}</div>`).join('')}</div>
<div class="small more"><a href="#env-${e.id}">Відкрити оточення →</a>${VARIANT.boardSettings ? ` · <a href="#env-${e.id}-settings">Налаштування</a>` : ''}</div></section>`).join('')}</div>`;
}

function envHead(e) {
  const s = srvById(e.serverId);
  return `<a class="back" href="#board">← Усі оточення</a><h1>${esc(e.name)} ${prodTag(e)}</h1>
<div class="sub"><span>гілка ${esc(e.branch)}</span><span>сервер: ${esc(s.name)} (${s.builtin ? 'вбудований' : 'віддалений'}) ${agentBadge(e)}</span><span>вікно відкату: ${e.retention.v} ${UNITS[e.retention.u]}</span></div>`;
}

function releasesTable(e) {
  return `<div class="tw"><table><thead><tr><th>Реліз</th><th>Стан</th><th class="hide-sm">Зміни схеми</th><th>Вікно</th></tr></thead><tbody>
${e.releases.map((r) => `<tr class="click${r.state === 'expired' ? ' dim' : ''}" tabindex="0" onclick="openPanel('${e.id}','${r.id}')" onkeydown="if(event.key==='Enter')openPanel('${e.id}','${r.id}')">
<td><span class="sha">${r.sha}</span> ${esc(r.msg)}<div class="small">${esc(r.author)} · ${date(r.at)}</div></td>
<td><span class="badge b-${r.state}">${STATE[r.state]}</span></td><td class="hide-sm">${diffView(r)}</td>
<td>${r.left != null ? `${leftText(e, r)}<div class="bar"><i style="width:${r.left * 100}%"></i></div>` : '—'}</td></tr>`).join('')}</tbody></table></div>`;
}

function historyTable(e, limit) {
  if (!e.ops.length) return `<p class="small">Операцій ще не було.</p>`;
  const shown = limit ? e.ops.slice(0, limit) : e.ops;
  const more = limit && e.ops.length > limit ? `<button type="button" class="more-btn" onclick="this.closest('[data-hist]').outerHTML=historyBlock(envById('${e.id}'), 0)">Показати всі (${e.ops.length})</button>` : '';
  return `<div data-hist><div class="tw"><table><thead><tr><th>Коли</th><th>Дія</th><th>Звідки → куди</th><th class="hide-sm">Хто</th><th>Результат</th></tr></thead><tbody>
${shown.map((o) => `<tr><td class="when">${date(o.at)}</td><td>${o.kind}</td><td class="sha">${o.from} → ${o.to}</td><td class="hide-sm">${esc(o.who)}</td>
<td><span class="${o.ok ? 'ok' : 'bad'}">${o.ok ? 'Успішно' : 'Помилка'}</span> · ${o.s} с${o.why ? `<div class="small">${esc(o.why)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>${more}</div>`;
}
function historyBlock(e, limit) { return historyTable(e, limit); }

function serverBlock(e) {
  const cur = srvById(e.serverId);
  const opt = (s) => `<option value="${s.id}"${s.id === cur.id ? ' selected' : ''}>${esc(s.name)}${s.builtin ? ' (вбудований)' : ''}${s.online ? '' : ' — офлайн'}</option>`;
  return `<div class="srv" id="srv">
<div class="srv-line"><select id="server_id" name="server_id" aria-label="Сервер" onchange="pickServer('${e.id}', this.value)">${SERVERS.map(opt).join('')}</select>
<button type="button" onclick="toggleNewServer()">+ Додати сервер</button></div>
<div class="srv-meta"><span>${cur.online ? '<span class="agent">● онлайн</span>' : '<span class="agent off">○ офлайн</span>'}</span><span>агент ${cur.version ?? '—'}</span>
<label>проксі <select id="proxy_mode" onchange="setProxy('${cur.id}', this.value)">${['external', 'bundled'].map((m) => `<option${m === cur.proxy ? ' selected' : ''}>${m}</option>`).join('')}</select></label>
${cur.builtin ? '' : `<button type="button" onclick="reissue('${cur.id}')">Перевипустити токен агента</button>`}
<span class="small">Сервер спільний: ${ENVS.filter((x) => x.serverId === cur.id).map((x) => esc(x.name)).join(', ')}</span></div>
${newToken ? `<div class="alert ok" role="status"><div>Токен агента для <b>${esc(newToken.name)}</b>. Скопіюйте зараз: він показується лише один раз.</div>
<code class="tok">${newToken.token}</code><div class="small">Виконайте на сервері:</div><pre>npm i -g microrun &amp;&amp; MICRORUN_AGENT_TOKEN=${newToken.token} microrun agent --url https://deploy.acme.dev</pre></div>` : ''}
<div class="newsrv" id="newsrv" hidden><label class="f"><span>Назва нового сервера</span><input type="text" id="newsrv-name" placeholder="edge-fra-2"></label>
<div class="actions"><button type="button" class="primary" onclick="createServer('${e.id}')">Створити й вибрати</button><button type="button" onclick="toggleNewServer()">Скасувати</button></div></div></div>`;
}

function settingsForm(e) {
  const v = e || { name: '', branch: '', prod: false, compose: '', composeDir: '', db: '', storage: 'local · /var/lib/microrun/images', services: '', schemaCheck: 'post_check', health: 60, retention: { v: 7, u: 'days' }, serverId: 's-local', id: 'new' };
  return `<form class="envform" onsubmit="event.preventDefault();saved()">
<fieldset><legend>Загальне</legend>
<div class="row2"><label class="f"><span>Назва</span><input type="text" id="f-name" value="${esc(v.name)}"></label>
<label class="f"><span>Гілка</span><input type="text" id="f-branch" value="${esc(v.branch)}"></label></div>
<label class="f"><span><input type="checkbox" id="f-prod"${v.prod ? ' checked' : ''}> Production</span><small>Production питає «Ви впевнені?» перед відкатом і вмикає dry-run міграцій.</small></label></fieldset>
<fieldset><legend>Сервер і агент</legend>${serverBlock(v)}</fieldset>
<fieldset><legend>Compose</legend>
<div class="row2"><label class="f"><span>Проєкт</span><input type="text" id="f-compose" value="${esc(v.compose)}"></label>
<label class="f"><span>Каталог</span><input type="text" id="f-dir" value="${esc(v.composeDir)}"></label></div>
<label class="f"><span>Сервіси й стратегії</span><input type="text" id="f-svc" value="${esc(v.services)}"></label>
<label class="f"><span>Healthcheck, с</span><input type="number" id="f-health" value="${v.health}"></label></fieldset>
<fieldset><legend>База даних</legend>
<label class="f"><span>Підключення</span><input type="text" id="f-db" value="${esc(v.db)}"></label>
<label class="f"><span>Перевірка схеми</span><select id="f-check"><option${v.schemaCheck === 'dry_run' ? ' selected' : ''} value="dry_run">dry-run перед деплоєм</option><option${v.schemaCheck === 'post_check' ? ' selected' : ''} value="post_check">перевірка після деплою</option></select></label></fieldset>
<fieldset><legend>Сховище образів і вікно відкату</legend>
<label class="f"><span>Сховище</span><input type="text" id="f-storage" value="${esc(v.storage)}"></label>
<label class="f"><span>Вікно відкату</span><span class="inline"><input type="number" id="f-ret" value="${v.retention.v}" style="max-width:110px"><select id="f-unit" style="max-width:140px">${Object.entries(UNITS).map(([k, t]) => `<option value="${k}"${k === v.retention.u ? ' selected' : ''}>${t}</option>`).join('')}</select></span><small>Скільки попередні збірки лишаються доступними для відкату. Не менше 1 години.</small></label></fieldset>
<div class="actions"><button type="submit" class="primary">${e ? 'Зберегти' : 'Створити оточення'}</button>${flash ? `<span class="saved" role="status">${flash}</span>` : ''}</div>
</form>`;
}

function panel(e, r) {
  const cur = activeOf(e);
  let target = null, mode = null;
  if (r.state === 'available') { target = r; mode = 'switch'; }
  if (r.state === 'active') { target = e.releases.filter((x) => x.state === 'available')[0] || null; mode = 'rollback'; }
  const label = mode === 'switch' ? 'Перейти на цю збірку' : 'Відкотити';
  const action = target ? `<div class="sect"><b>${mode === 'switch' ? 'Перейти' : 'Відкотити'} ${cur.sha} → ${target.sha}</b>
<div class="small">Схема БД не змінюється. Дані в існуючих полях зберігаються.</div>
${e.prod ? `<button class="big prod" id="go" onclick="this.hidden=true;document.getElementById('ask').hidden=false">${label}</button>
<div class="ask" id="ask" hidden><b>Ви впевнені?</b><div class="actions"><button class="big prod" onclick="doneAction('${label}')">Так</button><button class="big ghost" onclick="document.getElementById('ask').hidden=true;document.getElementById('go').hidden=false">Ні</button></div></div>`
    : `<button class="big" onclick="doneAction('${label}')">${label}</button>`}</div>` : '';
  return `<button class="x" onclick="closePanel()" aria-label="Закрити">×</button>
<div class="small">${esc(e.name)} ${prodTag(e)}</div>
<h2><span class="sha">${r.sha}</span> <span class="badge b-${r.state}">${STATE[r.state]}</span></h2><div>${esc(r.msg)}</div>
<div class="small">${esc(r.author)} · ${date(r.at)}</div><div class="small" style="margin-top:10px">Зміни схеми</div>${diffView(r)}${action}`;
}

function openPanel(envId, relId) { openRelease = { envId, relId }; renderPanel(); }
function closePanel() { openRelease = null; renderPanel(); }
function renderPanel() {
  const p = document.getElementById('panel');
  if (!openRelease) { p.className = ''; p.innerHTML = ''; document.body.classList.remove('panel-open'); return; }
  const e = envById(openRelease.envId), r = e.releases.find((x) => x.id === openRelease.relId);
  p.className = 'open' + (e.prod ? ' prod' : '');
  p.innerHTML = panel(e, r);
  document.body.classList.add('panel-open');
}
function doneAction(label) { document.getElementById('panel').querySelector('.sect').innerHTML = `<p class="ok">${label}: виконано за 19 с (імітація).</p>`; }

function pickServer(envId, id) { const e = envById(envId); if (e) e.serverId = id; else draft.serverId = id; newToken = null; rerenderServer(envId); }
function setProxy(id, m) { srvById(id).proxy = m; }
function reissue(id) { const s = srvById(id); newToken = { name: s.name, token: 'mra_' + Math.random().toString(36).slice(2, 14) }; rerenderServer(currentEnvId()); }
function toggleNewServer() { const n = document.getElementById('newsrv'); n.hidden = !n.hidden; if (!n.hidden) document.getElementById('newsrv-name').focus(); }
function createServer(envId) {
  const name = document.getElementById('newsrv-name').value.trim();
  if (!name) { document.getElementById('newsrv-name').focus(); return; }
  const s = { id: 's-' + name, name, builtin: false, online: false, version: null, proxy: 'external' };
  SERVERS.push(s);
  pickServer(envId, s.id);
  newToken = { name, token: 'mra_' + Math.random().toString(36).slice(2, 14) };
  rerenderServer(envId);
}
const draft = { serverId: 's-local', retention: { v: 7, u: 'days' } };
function currentEnvId() { return route.view === 'env' ? route.envId : 'new'; }
function rerenderServer(envId) {
  const e = envById(envId) || Object.assign({ id: 'new' }, draft);
  document.getElementById('srv').outerHTML = serverBlock(e);
}
function saved() { flash = 'Збережено'; render(); setTimeout(() => { flash = ''; }, 0); }

function render() {
  route = parseHash();
  const e = route.view === 'env' ? envById(route.envId) : null;
  const body = route.view === 'board' ? board()
    : route.view === 'new' ? `<a class="back" href="#board">← Усі оточення</a><h1>Нове оточення</h1><div class="sub">Релізи й історія з'являться після першого деплою.</div>${settingsForm(null)}`
    : renderEnv(e, route.tab);
  document.getElementById('app').innerHTML = header() + `<main>${body}</main>`;
  if (typeof afterRender === 'function') afterRender(e);
}
window.addEventListener('hashchange', () => { newToken = null; closePanel(); window.scrollTo(0, 0); render(); });
window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { if (typeof closeDrawer === 'function') closeDrawer(); closePanel(); } });
