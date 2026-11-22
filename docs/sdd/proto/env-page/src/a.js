const VARIANT = { letter: 'A', title: 'одна довга сторінка' };
function renderEnv(e) {
  return `${envHead(e)}
<nav class="jump" aria-label="Розділи"><a href="#" onclick="event.preventDefault();jump('b-rel')">Релізи</a><a href="#" onclick="event.preventDefault();jump('b-hist')">Історія</a><a href="#" onclick="event.preventDefault();jump('b-set')">Налаштування</a></nav>
<section class="block" id="b-rel"><div class="block-h"><h2>Релізи</h2><span class="small">${e.releases.length} збірок · клік відкриває панель відкату</span></div>${releasesTable(e)}</section>
<section class="block" id="b-hist"><div class="block-h"><h2>Історія</h2><span class="small">деплої, відкати, прибирання</span></div>${historyTable(e)}</section>
<section class="block" id="b-set"><div class="block-h"><h2>Налаштування</h2></div>${settingsForm(e)}</section>`;
}
function jump(id) { document.getElementById(id).scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }
