# UI redesign: головна для 100 оточень, згорнуті релізи, тексти — design

**Date:** 2026-11-22
**Status:** agreed
**Prototype:** docs/sdd/proto/ui-redesign/decision.md (варіант C4)

## 1. Problem

- Головна `/` (`ui/board.ts`) — сітка колонок, по одній на оточення, у кожній картка на **кожен** реліз. Маршрут (`routes/ui.ts`, `app.get('/')`) для кожного оточення викликає `envVM`: `repo.listReleases(env.id)` без ліміту, `repo.listOperations({ envId, limit: 200 })` і ще `getOperation` для блокувальників. На 100 оточеннях і ~1 100 релізах (дані прототипу) це 200+ запитів і ~1 100 карток у 34 рядах колонок по три; знайти потрібне оточення можна лише прокруткою.
- Сторінка оточення (`ui/env.ts`) показує всі релізи однією таблицею. У прототипі `checkout-prod` має 140 релізів, з них 125 уже поза вікном відкату.
- Немає пошуку за назвою, гілкою чи комітом.
- У SQLite немає індексів на `releases(env_id, deployed_at)`, `releases(deployed_at)`, `operations(env_id, started_at)`, хоча всі списки сортуються саме так.
- Шапка (`ui/layout.ts`) займає всю ширину, а `main` теж без обмеження ширини; на мобільному шапка переноситься в три рядки.
- Тексти: `confirm.ask` «Are you sure?» з «Yes/No» не каже, що буде; стан `Available` не пояснює, що до релізу можна відкотитися; тег `PRODUCTION` написаний капсом; `+ New environment` і `Environment page →` несуть символи в підписі.

## 2. Constraint that shapes the solution

- Рендер на сервері шаблонним тегом `html` + htmx + Tailwind-утиліти (`app.src.css`), без фронтенд-фреймворку. Тому пошук, фільтр і «показати ще» — це GET-запити, що віддають HTML-фрагменти, а не клієнтська фільтрація: при 1 000+ релізах сторінка не повинна тягнути всі дані у браузер.
- Прототип показує лише наявну функціональність. Поняття «етап» (staging / development / preview) у моделі немає — є лише `is_production` і `position`, тому покажчик ділиться на «Production» і «Other environments». Зведення проблем по всіх оточеннях («Needs attention») відкинуто як нова функція.
- Головна будується фіксованою кількістю запитів, незалежно від кількості оточень і релізів. Повний `envVM` (усі релізи й 200 операцій) лишається тільки для одного оточення: сторінки оточення й бічної панелі.
- Межі середовища не вимірювалися: робота не збирає й не обробляє великих даних.

## 3. Solution

### 3.1 Головна `/` (`ui/home.ts`, замість `ui/board.ts`)

Дві колонки на ≥ 901 px (`grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] gap-7`), одна на вужчих.

**Ліворуч — «Latest deploys»** (`data-testid="feed"`):
- Фільтр-перемикачі `All` / `Production` (посилання `?only=prod`, `aria-pressed`).
- Рядок на реліз, найновіші зверху, 25 на сторінку. Рядок: відносний час, назва оточення (червона для production), 7 символів SHA (mono), повідомлення коміту, під ним автор і «schema change», якщо `schemaDiff` непорожній; праворуч бейдж стану.
- Рядок зберігає наявний контракт картки дошки: `data-testid="rel-<env>-<sha7>"`, `data-state="<state>"`, `hx-get="/panel/<releaseId>" hx-target="#panel" hx-trigger="click, keydown[key=='Enter']" tabindex="0" role="button"`. Відкритий у панелі рядок отримує `aria-current="true"` і підсвічування.
- Під списком, якщо є ще: кнопка `home.more` («Show 25 more», праворуч `home.notShown` «{n} not shown») з `hx-get="/feed?before=<cursor>&q=…&only=…" hx-target="this" hx-swap="outerHTML"` — повертає наступні 25 рядків і нову кнопку. Курсор — `<deployed_at>.<release id>` останнього показаного рядка; наступна сторінка — рядки з `(deployed_at, id) < курсор`, а `{n} not shown` рахується з тією ж умовою. *(Моє рішення після builder check: offset на живій таблиці дублює або пропускає рядки, коли між кліками приходять нові деплої.)*
- Стрічка показує рядки `releases` (по одному на коміт в оточенні), не операції: повторний деплой того самого коміту оновлює `deployed_at` наявного рядка, відкати в стрічці не з’являються — вони видно в історії панелі релізу. Це те, що показував підписаний прототип.
- Порожньо без пошуку: `home.feedEmpty` («Nothing deployed yet. Deploys from CI appear here.»); порожньо з пошуком: `search.none`.

**Праворуч — «All environments»** (`data-testid="env-index"`) з лічильником:
- Групи `Production` і `Other environments` (`home.other`), у кожній оточення в порядку `repo.listEnvs()` (`position`, `name`), у дві колонки (`columns-2`), на телефоні також.
- Елемент: крапка стану + назва, посилання `/env/<id>`, `data-testid="env-link-<name>"`. Стан крапки (пріоритет зверху вниз): `mismatch` — червона (є `markerWarnings`); `offline` — порожнє кільце (агент офлайн); `warn` — жовта (в оточенні немає активної операції, і при цьому останній реліз `failed`, активний реліз не збережено, або остання завершена операція активного релізу має `code = CONTRACT_FAILED`); інакше `ok` — зелена. *(Моє рішення після builder check: `createDeploy` створює реліз зі станом `failed` ще до завершення деплою, тому під час активної операції (`repo.activeOperations()`) крапка не жовтіє; `blocked` після свідомого відкату — не проблема й крапку не фарбує.)* `title` і прихований текст крапки — `home.dot.<state>`.

**Пошук** у шапці (`ui/layout.ts`): `<input type="search" name="q">` у `<form method="get" action="/">` з `hx-get="/" hx-trigger="input changed delay:250ms, search" hx-target="#home" hx-select="#home" hx-push-url="true"`; клавіша `/` фокусує його (inline-скрипт у `layout`). `q` обрізається, приводиться до нижнього регістру, максимум 100 символів. Оточення підходить, якщо `name` або `branch` містить `q`; реліз — якщо підходить його оточення або `commit_sha` починається з `q`. Покажчик із пошуком показує оточення, що підходять самі або мають реліз зі збігом SHA. Без збігів — `search.none` («No environment, branch or commit matches “{q}”.») і посилання `search.clear` на `/`.

### 3.2 Сторінка оточення `/env/:id` (`ui/env.ts`)

- Без змін: шапка з метаданими, попередження, липка навігація `env-jump` (Releases / Settings), секція Settings.
- Секція Releases ділиться на дві таблиці: `env.inWindow` («Within the rollback window»: активний реліз, усі `available`, а також `failed` і `blocked`, розгорнуті не раніше за активний — `deployed_at ≥ active.deployed_at`; без активного — лише останній реліз) і `env.older` («Older releases»: решта, тобто `expired` і давніші `failed` / `blocked`, за `deployed_at desc`). *(Моє рішення після builder check: `blocked` і `failed` ніколи не стають `expired`, тож за правилом «≠ expired» верхня таблиця росла б без меж.)* з підказкою `env.olderHint` («Kept as a record. You can’t roll back to them.»). Старі спочатку згорнуті: показано лише кнопку `env.showOlder` («Show {n} older», `n = min(20, залишок)`) і `home.notShown`; кнопка робить `hx-get="/env/<id>/older?before=<cursor>"` і замінює себе 20 рядками + новою кнопкою.
- Рядок релізу — як зараз (`data-testid="rel-<env>-<sha7>"`, `data-state`, `hx-get="/panel/…"`); на ≤ 560 px — дві лінії (SHA, залишок вікна, бейдж / повідомлення).
- Мітка повернення `env.back` → «← Overview».

### 3.3 Шапка й каркас (`ui/layout.ts`, `app.src.css`)

- `<header>` — смуга на всю ширину (`bg-surface border-b`, `sticky top-0 z-10`); вміст у `<div class="mx-auto flex max-w-[1320px] items-center gap-3.5 px-4">`: логотип, пошук (`max-w-[440px] flex-1`), перемикач мови (`ml-auto`), кнопка `env.newEnv`.
- `<main class="mx-auto max-w-[1320px] px-4 py-5">`, обгортка `#home` на головній.
- ≤ 760 px: два рядки — логотип, мова, кнопка з підписом `env.newEnvShort` («New», `aria-label` = `env.newEnv`) / пошук на всю ширину. Липка навігація `env-jump` має `top` = висоті шапки (57 px / 108 px).
- ≥ 1100 px з відкритою панеллю: `main` і шапка отримують `margin-right: 440px`, а внутрішня колонка шапки — `margin-right: 0`, щоб краї шапки й контенту збігалися. Плоский CSS для цього лишається в `app.src.css` (селектор `:has()` на `#panel:not(:empty)`), як і зараз.

### 3.4 Бічна панель (`ui/panel.ts`)

- Назва оточення вгорі — посилання на `/env/<id>`.
- Підтвердження production: замість `confirm.ask` / `confirm.yes` / `confirm.no` — окремі тексти для відкату (`rb.ask`, `rb.yes`) і approve (`approve.ask`, `approve.yes`), спільне `confirm.cancel`. Механіка `[data-testid=confirm-ask]`, `confirm-yes`, `confirm-no` і поле `confirm=yes` — без змін.
- Причина недоступності відкату при офлайн-агенті називає сервер: `rb.noAgent` = «Rollback is unavailable: the agent on server {server} is offline.» Часу не показуємо. *(Моє рішення після builder check: `servers.last_seen_at` пишеться лише під час handshake, тож «went offline {ago}» показувало б час останнього підключення.)*
- Завершення відкату — без змін: SSE `done` віддає `opProgressView` із `data-testid="rollback-done"` і «Rollback finished in {s}» (на це спираються `acceptance.spec.ts:137` і `app.test.ts`). Новий стан видно в списках після закриття панелі.
- Історія операцій, прибирання даних, contract retry — без змін.

### 3.5 Тексти

Змінюються значення наявних ключів (EN нижче; 7 інших каталогів перекладаються за змістом, а не дослівно):

| ключ | було | стало |
|---|---|---|
| `state.active` | Active | Live |
| `state.available` | Available | Can roll back |
| `state.blocked` | Blocked | Rolled back |
| `state.expired` | Rollback closed | Window closed |
| `env.prodTag` | PRODUCTION | Production |
| `env.newEnv` | + New environment | New environment |
| `env.back` | ← All environments | ← Overview |
| `rb.willBlock` | Will be blocked: | After the rollback, these commits can’t be deployed again: |
| `rb.schema` | The database schema is not changed. Data in existing fields is kept. | The database schema stays as it is. No data is deleted. |
| `rb.noMarker` | Unavailable: database does not match the environment. | Rollback is unavailable until the database mismatch is fixed. |
| `rb.noAgent` | Unavailable: agent is offline. | Rollback is unavailable: the agent on server {server} is offline. |
| `note.blocked` | Rolled back {at} → {to}. Redeploying this commit is rejected. | Rolled back to {to} {at}. Deploying this commit again is refused; push the fix as a new commit. |
| `approve.title` | Destructive schema change | The migration removes a column |
| `approve.text` | The deploy of commit {sha} was rejected: it removes {col}. Approval allows this commit to be deployed once. | The deploy of {sha} was stopped because its migration removes {col}. Approval lets the next deploy of this commit remove it, once; run the deploy again from CI. |
| `cl.sub` | Separate step: the rollback is already done. Counts come from cleanup --dry-run. | Optional. The rollback is already done. Counts come from a dry run of your cleanup command. |
| `cl.skip` | Skip cleanup | Keep the data |

`approve.go` лишається «Approve»: approve не запускає деплой (`orchestrator.approveDestructive` лише записує дозвіл), тому текст прототипу «Approve and deploy» не переноситься.

Видаляються: `confirm.ask`, `confirm.yes`, `confirm.no`, `env.open`, `env.settings` (посилання з колонок дошки), `env.available` (уже зараз ніде не використовується).

Нові ключі в усіх 8 каталогах `catalogs/ui.ts`: `home.feed` (Latest deploys), `home.envs` (All environments), `home.filterAll` (All), `home.filterProd` (Production), `home.other` (Other environments), `home.more` (Show 25 more), `home.notShown` ({n} not shown, з множиною), `home.feedEmpty`, `home.dot.ok` / `.warn` / `.mismatch` / `.offline`, `search.placeholder` (Search environments, branches or commits), `search.label`, `search.none`, `search.clear` (Clear search), `env.newEnvShort` (New), `env.inWindow`, `env.older`, `env.olderHint`, `env.showOlder` (з множиною), `rb.ask` (Roll back production {env} to {sha}?), `rb.yes` (Yes, roll back), `approve.ask` (Allow {sha} to remove {col} in production?), `approve.yes` (Yes, approve), `confirm.cancel` (Cancel).

`approve.text` не стверджує, що база не змінилася: для `schemaCheck = post_check` expand-міграція вже виконана до перевірки (`orchestrator.ts:471`). *(Моє рішення після builder check.)*

### 3.6 Дані (`db/repo.ts`, міграція)

- `db/migrations/004_scale_indexes.ts`: `create index releases_env_deployed on releases(env_id, deployed_at)`, `create index releases_deployed on releases(deployed_at)`, `create index operations_env_started on operations(env_id, started_at)`; `down` видаляє їх.
- `repo.listRecentReleases(f: { q: string; productionOnly: boolean; before: { at: number; id: string } | null; limit: number }): Promise<{ rows: FeedRow[]; rest: number }>`, де `FeedRow = ReleaseRow & { envName: string; envIsProduction: boolean }`; один `select … join environments … where (deployed_at, id) < before … order by deployed_at desc, id desc limit` і один `count(*)` з тими самими умовами мінус уже показані (`rest` — скільки лишилося після цієї сторінки).
- `repo.listOlderReleases(envId: string, f: { after: number; before: { at: number; id: string } | null; limit: number })` — сторінка «Older releases» для `/env/:id/older`; межа між таблицями (`after`) — правило 3.2.
- `repo.envStatuses(): Promise<Map<string, { latest: ReleaseRow | null; active: ReleaseRow | null; lastOp: OperationRow | null }>>` — три запити з `row_number() over (partition by env_id order by …)` (останній реліз, активний реліз, остання завершена операція).
- `repo.envIdsWithShaPrefix(q: string): Promise<Set<string>>` для покажчика під час пошуку.
- `routes/ui.ts`: `GET /` більше не викликає `envVM`; будує `HomeVM` з `listEnvs`, `listServers`, `envStatuses`, `listRecentReleases`, `hub.isOnline`, `scheduler.markerWarnings()`.

### Public interface

| інтерфейс | вигляд | на чому стоїть | альтернатива |
|---|---|---|---|
| `GET /` | query `q`, `only=prod` (будь-яке інше значення `only` = усі); повна сторінка, або фрагмент `#home` для htmx | «100 оточень і 1000 деплоїв» → серверний пошук і пагінація | клієнтська фільтрація: відкинуто, тягне всі дані |
| `GET /feed` | query `q`, `only`, `before=<deployed_at>.<id>` (формат невірний → 400); фрагмент: ≤ 25 рядків + кнопка | те саме | `offset` / `?page=`: відкинуто, на живій таблиці дублює й пропускає рядки; нескінченна прокрутка: відкинуто, без JS-бібліотек |
| `GET /env/:id/older` | query `before` (необов’язковий; без нього — перша сторінка); фрагмент: ≤ 20 рядків + кнопка; 404 для невідомого `id`, 400 для невірного `before` | те саме | те саме |
| «деплої» в стрічці | рядки `releases`, не `operations` | прототип C4 показував релізи | операції (з відмовами й відкатами) — це історія, вона в панелі релізу |
| `data-testid` | збережено `rel-<env>-<sha7>`, `env-jump`, `panel`, `confirm-*`, `lang`, `env-new`; нові `feed`, `env-index`, `env-link-<name>`, `feed-more`, `env-older-more`; зникають `col-<name>`, `env-settings-<name>` | e2e клікає `rel-production-<sha>` на `/` | — |

## 4. Out of scope

- Поле «етап» і групування Staging / Development / Previews; зведення «Needs attention».
- Форма налаштувань оточення, сторінка серверів, вхід — вони вже оновлені в `2026-11-22-ui-polish.md`.
- Віртуалізація списків, нескінченна прокрутка, живе оновлення стрічки (SSE) на головній.
- Пошук за повідомленням коміту чи автором.
- Зміни протоколу, агента, оркестратора (крім читання `last_seen_at` для тексту).

## 5. Trade-offs accepted

- Зникає огляд «що зараз активне в кожному оточенні» з одного погляду: тепер це крапка стану в покажчику й сторінка оточення. Стрічка показує історію, а не поточний стан.
- На вкладці `All` у стрічці переважатимуть оточення, що деплояться найчастіше (preview-гілки); для production є фільтр.
- Старі релізи на сторінці оточення потребують кліку.
- Зміна текстів станів (`Active` → `Live` тощо) ламає звичку наявних користувачів; перевага — стан читається без знання внутрішньої моделі.
- Три нові індекси трохи сповільнюють запис релізів і операцій.

## 6. Verification

- `pnpm verify` зелений.
- `repo.test.ts`: `listRecentReleases` сортує за `deployed_at desc, id desc`, поважає курсор `before` і `limit` (новий реліз, вставлений між сторінками, не дублює і не зсуває другу сторінку), `productionOnly`, `q` (назва, гілка, префікс SHA) і повертає правильний `rest`; `envStatuses` повертає останній / активний реліз і останню завершену операцію для кожного оточення; міграція 004 створює три індекси.
- `views.test.ts` (замість тестів `boardView`): `homeView` на 100 оточеннях × 10 релізів рендерить рівно 25 `data-testid="rel-` і кнопку `feed-more` з `{n} not shown` = 975; групи Production / Other у порядку `position`; крапки `mismatch` / `offline` / `warn` / `ok` за правилами 3.1; немає сирих ключів у 8 мовах; немає елемента з `hidden` і display-утилітою без `:not([hidden])`.
- `views.test.ts`: `envView` з 140 релізами (активний, 14 `available`, 125 `expired`) рендерить 15 рядків і кнопку «Show 20 older» з 125 not shown; давній `blocked` реліз потрапляє в «Older», а `failed`, новіший за активний, — у верхню таблицю; фрагмент `/env/:id/older` — 20 рядків, друга сторінка за курсором — наступні 20.
- `views.test.ts`: крапка оточення з `failed`-релізом і активною операцією — `ok`; з `blocked` останнім релізом — `ok`.
- Маршрути (`app.test.ts`): `GET /` для 100 оточень не викликає `repo.listReleases` (spy); `GET /feed?before=garbage` → 400; `GET /?q=<sha-prefix>` повертає рядок цього релізу; `GET /env/unknown/older` → 404.
- E2E: `acceptance.spec.ts` відкат з головної через `rel-production-aaaaaaa` проходить; рядок `col-production` замінено на `env-link-production`.
- Візуально: `/` і `/env/:id` на 1440, 1864 і 390 px, світла й темна теми, з відкритою панеллю і без: краї шапки й контенту збігаються, горизонтальної прокрутки немає.
