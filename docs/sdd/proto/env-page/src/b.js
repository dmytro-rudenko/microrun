const VARIANT = { letter: 'B', title: 'вкладки Релізи / Історія / Налаштування' };
const TABS = [['releases', 'Релізи'], ['history', 'Історія'], ['settings', 'Налаштування']];
function renderEnv(e, tab) {
  const t = tab || 'releases';
  const body = t === 'releases' ? releasesTable(e) : t === 'history' ? historyTable(e) : settingsForm(e);
  return `${envHead(e)}
<div class="tabs" role="tablist">${TABS.map(([k, l]) => `<a role="tab" aria-selected="${k === t}" class="${k === t ? 'on' : ''}" href="#env-${e.id}-${k}">${l}${k === 'releases' ? ` <span class="cnt">${e.releases.length}</span>` : k === 'history' ? ` <span class="cnt">${e.ops.length}</span>` : ''}</a>`).join('')}</div>
<div role="tabpanel">${body}</div>`;
}
