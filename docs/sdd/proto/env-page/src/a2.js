const VARIANT = { letter: 'A2', title: 'одна довга сторінка, контекст оточення в смужці', boardSettings: true };
const SECTIONS = [['releases', 'b-rel', 'Релізи'], ['history', 'b-hist', 'Історія'], ['settings', 'b-set', 'Налаштування']];
function renderEnv(e) {
  return `${envHead(e)}
<nav class="jump${e.prod ? ' prod' : ''}" aria-label="Розділи"><span class="ctx">${esc(e.name)} ${prodTag(e)}</span>${SECTIONS.map(([k, id, l]) => `<a href="#env-${e.id}-${k}" data-sec="${id}">${l}</a>`).join('')}</nav>
<section class="block" id="b-rel"><div class="block-h"><h2>Релізи</h2><span class="small">${e.releases.length} збірок · клік відкриває панель відкату</span></div>${releasesTable(e)}</section>
<section class="block" id="b-hist"><div class="block-h"><h2>Історія</h2><span class="small">деплої, відкати, прибирання</span></div>${historyTable(e, 5)}</section>
<section class="block" id="b-set"><div class="block-h"><h2>Налаштування</h2></div>${settingsForm(e)}</section>`;
}
let spy = null;
function afterRender(e) {
  if (spy) { spy.disconnect(); spy = null; }
  if (!e) return;
  const links = [...document.querySelectorAll('.jump a')];
  const mark = (id) => links.forEach((a) => a.classList.toggle('on', a.dataset.sec === id));
  const seen = new Map();
  spy = new IntersectionObserver((entries) => {
    entries.forEach((en) => seen.set(en.target.id, en.isIntersecting));
    const first = SECTIONS.find(([, id]) => seen.get(id));
    if (first) mark(first[1]);
  }, { rootMargin: '-60px 0px -55% 0px' });
  SECTIONS.forEach(([, id]) => spy.observe(document.getElementById(id)));
  const target = SECTIONS.find(([k]) => k === route.tab);
  if (target) { document.getElementById(target[1]).scrollIntoView(); mark(target[1]); }
}
