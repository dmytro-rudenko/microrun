const VARIANT = { letter: 'C', title: 'налаштування у висувній панелі' };
function renderEnv(e, tab) {
  return `${envHead(e).replace('</h1>', ` <button class="gear" onclick="go('env-${e.id}-settings')">⚙ Налаштування</button></h1>`)}
<section class="block"><div class="block-h"><h2>Релізи</h2></div>${releasesTable(e)}</section>
<section class="block"><div class="block-h"><h2>Історія</h2></div>${historyTable(e)}</section>
<div class="scrim" id="scrim" onclick="closeDrawer()" ${tab === 'settings' ? '' : 'hidden'}></div>
<aside class="drawer${tab === 'settings' ? ' open' : ''}" id="drawer" aria-label="Налаштування оточення"><div class="drawer-h"><h2>Налаштування · ${esc(e.name)}</h2><button class="x" onclick="closeDrawer()" aria-label="Закрити">×</button></div>${settingsForm(e)}</aside>`;
}
function closeDrawer() { if (route.view === 'env' && route.tab === 'settings') go('env-' + route.envId); }
