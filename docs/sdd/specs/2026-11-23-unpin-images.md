# Зняття локальних образів збережених релізів — design

**Date:** 2026-11-23
**Status:** agreed

## 1. Problem

Після деплою агент закріплює образи релізу тегами `microrun-pin/<env>:<sha12>-<svc>`
(`pinImages`, `packages/agent/src/storage.ts:100`) і зберігає їх у сховище оточення
(`storeImages`: `local` / `s3` — `docker save | gzip` у `<env>/<sha>.tar.gz`, `registry` — `push`).
Локальна копія лишається в Docker хоста агента, доки реліз не стане `expired` і планувальник не
викличе `deleteImages` (`packages/server/src/scheduler.ts:75`). Тобто кожен `available` реліз у
вікні retention тримає на диску повний набір образів, хоча його копія вже є у сховищі.
На хості з частими деплоями й довгим retention диск займають десятки майже непотрібних образів.

## 2. Constraint that shapes the solution

- Відкат уже вміє брати образ зі сховища: крок `fetch` (`packages/server/src/orchestrator.ts:520`)
  викликає `fetchImages`. Ця функція повертається одразу, коли образ є локально, а інакше
  завантажує його з `local` / `s3` / `registry` і звіряє digest (`storage.ts:159`). Тому для
  зняття локальної копії не потрібен новий шлях відкату: досить прибрати теги.
- Специфікація microrun (`docs/sdd/specs/2026-11-22-microrun.md`, §3.10) робить закріплену локальну
  копію швидким шляхом відкату. Повністю відмовлятися від нього не будемо: швидким лишається
  відкат на один крок.
- `PROTOCOL_VERSION` звіряється при `hello` строго (`packages/server/src/hub.ts:210`). Якщо його
  підвищити, агент іншої версії не підключиться взагалі. Тому нова команда додається без зміни
  версії, а відмова старого агента — звичайна помилка, яку планувальник повторює.
- Без маркера в БД планувальник кожні 60 с викликав би агента для кожного `available` релізу.
  Тому потрібна колонка й міграція.

Обмеження середовища: задача не збирає і не обробляє великі дані, тому ліміти CPU, пам'яті й
таймаутів не вимірювалися.

## 3. Solution

### 3.1 Правило зняття

Реліз R підлягає зняттю, коли виконано все разом:

- `R.state = 'available'`, або `R.state = 'blocked'` і `R.cleanupState ≠ 'pending'`;
- `R.stored = true`;
- `R.imagePurgedAt = null` і `R.imageUnpinnedAt = null`;
- R — не «попередній» реліз оточення. «Попередній» — `available` реліз із найбільшим
  `supersededAt` (той, з якого щойно перейшли на активний); за однакового `supersededAt`
  попереднім вважається реліз із більшим `deployedAt`, щоб вибір був однозначним.

Активний реліз ніколи не знімається. `blocked` з `cleanupState = 'pending'` лишається локально,
бо cleanup запускає `cleanup_cmd` з його образу (`orchestrator.ts:570`). `failed` і `expired` правило
не зачіпає: їхні образи прибирає `purge`, як і раніше. Політика однакова для всіх оточень і
сховищ (`local`, `s3`, `registry`), діє постійно (крок планувальника) і не налаштовується.
Це відповідає вибору користувача: «усі, крім активного і попереднього», без налаштування на оточення.

Про спільні `ref`. `ref` приходить із CI-запиту деплою, тож кілька релізів можуть ділити один
тег (наприклад, `:latest` або один `--image` для всіх сервісів). Тег `ref` знімається лише тоді,
коли жоден інший реліз оточення, чий образ ще має лишатися локально, його не використовує.
«Має лишатися» означає: `imagePurgedAt = null`, `imageUnpinnedAt = null` і реліз не входить у
поточний результат `dueUnpin`. Тег `microrun-pin/…` належить одному релізу і знімається завжди.

### 3.2 Core — `packages/core/src/state.ts`

- `ReleaseFacts` отримує поле `imageUnpinnedAt: number | null`.
- Нова чиста функція:

  ```ts
  export function dueUnpin(rs: (ReleaseFacts & { stored: boolean })[]): string[]
  ```

  Вона повертає `id` релізів за правилом 3.1, у порядку зростання `supersededAt`.
- `activate()` додає до патча `imageUnpinnedAt: null`. `activate` викликають і `onDeploySuccess`
  (повторна активація `available` коміту), і `onRollbackSuccess`. Після обох `fetchImages` або
  `pullImages` знову кладе образ у локальний Docker. Без скидання маркера реліз, який пізніше
  знову стане неактуальним, ніколи б не знявся повторно.

### 3.3 Core — `packages/core/src/protocol.ts`

- `Command` отримує `{ type: 'unpinImages'; env: string; sha: string; images: Record<string,string>; keep: string[] }`.
  `images` — повна мапа `svc → ref` релізу. `keep` — ті `ref`, які агент не знімає, бо їх тримає
  інший реліз (3.1).
- `ResultMap` отримує `unpinImages: { unpinned: boolean }`.
- zod-схема: `z.object({ type: z.literal('unpinImages'), env: z.string(), sha: z.string(), images: stringMap, keep: z.array(z.string()) })`.
  У ній немає поля `storage`, бо зняття не чіпає сховища.
- `PROTOCOL_VERSION` лишається `1`.

### 3.4 Agent — `packages/agent/src/storage.ts`, `handler.ts`

- Цикл `docker rmi` для `pinRef(env, sha, svc)` і `ref` з `deleteImages` (`storage.ts:198`)
  виноситься в спільну функцію `removeLocal(env, sha, images, keep: string[] = []): Promise<boolean>`.
  Вона знімає `pinRef` кожного сервісу й кожен `ref`, якого немає в `keep`, і повертає `true`,
  коли після неї жоден зі знятих тегів не лишився в Docker. «No such image» ігноруємо.
  «Being used» / «is using» дають `false`. Інша помилка кидається. `deleteImages` викликає її й
  поводиться як раніше: ігнорує `false`.
- `unpinImages(env, sha, images, keep): Promise<{ unpinned: boolean }>` = `guarded('unpin', …)` над
  `removeLocal`. Повторний виклик на вже знятому релізі дає `{ unpinned: true }`.
- `handler.ts`: `case 'unpinImages'` → `L.unpinImages(cmd.env, cmd.sha, cmd.images, cmd.keep)`. `unpinImages`
  додається до ін'єктованих залежностей `L` поруч із `deleteImages`.

### 3.5 DB — `packages/server/src/db/`

- Міграція `migrations/005_image_unpinned_at.ts`: `alter table releases add column image_unpinned_at integer null`.
  Реєструється в `db.ts` після `004_scale_indexes`.
- `repo.ts`: `imageUnpinnedAt` читається й пишеться так само, як `imagePurgedAt` (shape-мапінг і
  `patchReleases`). Наявні рядки отримують `null`, тож після міграції планувальник поступово
  знімає вже накопичені образи.

### 3.6 Server — `packages/server/src/scheduler.ts`

- Новий приватний крок `unpin(env, now)` у `tickEnv`, після `store`, лише коли агент онлайн.
- Для кожного `id` з `dueUnpin(await repo.listReleases(env.id))` крок викликає
  `agent.call<'unpinImages'>(env.serverId, { opId: \`unpin:${r.id}:${now}\`, step: 'unpinImages' }, { type: 'unpinImages', env: env.name, sha: r.commitSha, images, keep })`.
  - `images` — `ref` з `r.images`, ті самі, що `imagesArgs` дає для `store` і `purge`.
  - `keep` — `ref`, які за правилом 3.1 тримає інший реліз.
  - `opId` містить `now`, як у `readMarkers` (`scheduler.ts:163`). Агент кешує результат кожного
    `opId:step` (`packages/agent/src/handler.ts:197`), тож сталий `unpin:${r.id}` повторював би
    закешоване `unpinned: false` замість нової спроби. А після повторної активації він повернув би
    закешоване `true`, не знявши образ.
- `{ unpinned: true }` → `patchReleases([{ id, patch: { imageUnpinnedAt: now } }])`.
- `{ unpinned: false }` або помилка (агент офлайн, старий агент не знає команди, `STORAGE_FAILED`)
  → рядок у лог `scheduler: env <name>: unpin <sha>: <message>`, маркер не ставиться, повтор на
  наступному тіку. Для `unpinned: false` у лог пишеться `in use`.
- Операція в `operations` не створюється: це прибирання кешу, як `store` і `purge`, а не дія над
  релізом.

### 3.7 Споживачі локального образу — `packages/server/src/orchestrator.ts`

Правило: кожна операція, що запускає контейнер з образу неактивного релізу, спершу кличе
`fetchImages` для цього релізу. `fetchImages` нічого не робить, коли образ уже є локально
(`storage.ts:162`), тож для незнятих релізів поведінка не змінюється.

- **Відкат.** Без змін: крок `fetch` уже є (`orchestrator.ts:520`). Після успіху `activate` скидає
  `imageUnpinnedAt` (3.2).
- **Повторна активація (`deploy` коміту в стані `available`).** Коли `plan.reactivate` і
  `rel.stored`, перед кроком `pull` (`orchestrator.ts:405`) додається крок `fetch` з тими самими
  аргументами, що й у відкаті. Причина: для тегового `ref` `pullImages` ігнорує збій `docker pull`
  і бере локальний образ (`handler.ts:110`). Тому сьогодні повторна активація працює навіть тоді,
  коли CI вже видалив тег із registry. Новий крок зберігає це для знятого релізу.
- **Contract.** `executeContract` запускає `contract_cmd` з образу R, а R може бути `available`
  (`nextContract`, `state.ts:106`). Тому перед `runCommand` додається крок `fetch` для R, коли
  `R.stored`.
- **Cleanup.** Без змін: `blocked` з `cleanupState = 'pending'` не знімається (3.1).

Відкат на один крок назад після іншого відкату може бути повільним. Приклад: R3 активний, R2
попередній, R1 уже знятий. Після відкату на R2 «попереднім» стає R1, а його образу локально
немає. Повторно підвантажувати такий реліз заздалегідь не будемо.

### Public interface

| Інтерфейс | Форма | На чому базується | Альтернативне прочитання |
|---|---|---|---|
| Команда агента | `unpinImages {env, sha, images, keep}` | «архівувати білди»: дія над образами релізу, тому повторює форму `deleteImages` без `storage`, плюс `keep` для спільних `ref` | передавати `storage`, як в `imagesCommand`; відкинуто, бо сховище не використовується. Відфільтрувати `images` на сервері замість `keep`; відкинуто, бо тоді не знявся б `pinRef` сервісу зі спільним `ref` |
| Результат | `{ unpinned: boolean }` | маркер ставиться лише після фактичного зняття | порожній `{}` і кидати помилку на «being used»; відкинуто, бо зайнятий образ — очікуваний стан, а не збій |
| Колонка | `releases.image_unpinned_at integer null` | паралель до `image_purged_at` | булеве `unpinned`; відкинуто, бо час корисний у діагностиці й однаковий за формою з `image_purged_at` |

## 4. Out of scope

- Налаштування політики на оточення, будь-який UI, показ стану «знято локально» в стрічці.
- Інше стиснення архівів (zstd тощо), чистка build-кешу Docker і `docker image prune`.
- Зміни `expire`, `purge`, `deleteImages` (поза винесенням `removeLocal`) і логіки вибору `nextContract`.
- Заздалегідь підвантажувати образ релізу, що став «попереднім» після відкату (3.7).
- Ручний запуск зняття (API, CLI, кнопка).
- Підвищення `PROTOCOL_VERSION` і механізм узгодження можливостей агента.

## 5. Trade-offs accepted

- Відкат глибше ніж на один крок повільніший: спершу `docker load` з архіву (`local`, `s3`) або
  `docker pull` (`registry`). Відкат на попередній реліз лишається таким самим швидким.
- Сховище стає єдиною копією старіших `available` релізів. Якщо архів втрачено, відкат на них
  завершиться `STORAGE_FAILED` на кроці `fetch`, а раніше такий відкат пройшов би з локальної копії.
- Агент старішої версії отримує невідому команду щотіку й пише помилку в лог, доки його не
  оновлять. Це прийнятно: шум лише в лозі, без впливу на деплой.
- Політика «активний + попередній» вшита в код. Налаштування додамо, коли знадобиться.
- Після оновлення сервера всі наявні релізи мають `image_unpinned_at = null`. Тому перші тіки
  знімуть усі накопичені образи, крім активного й попереднього, в усіх оточеннях одразу. Це і є
  мета, але звільнення диска станеться разом, а не поступово.
- Contract і повторна активація знятого релізу стають повільнішими на час `fetch`. Якщо сховище
  недоступне, вони падають із `STORAGE_FAILED`, а раніше йшли з локальної копії.
- Збіг digest після `docker load` перевірено вручну лише на containerd image store (Docker 29.6.1,
  `busybox:1.36.1`: `Id` і `RepoDigests` після `save | gzip` → `rmi` → `load` такі самі, як після
  `pull`). Image store production-хоста не перевірено: доступ із сесії заблоковано. Це покриває
  Docker-тест у §6.5.

## 6. Verification

1. `pnpm typecheck` і `pnpm test` з кореня репозиторію — зелені.
2. Юніт `dueUnpin` (`packages/core/src/state.test.ts`) покриває:
   - активний не повертається;
   - попередній (найбільший `supersededAt`) не повертається;
   - за рівного `supersededAt` лишається реліз із більшим `deployedAt`;
   - `stored = false`, `imagePurgedAt ≠ null`, `imageUnpinnedAt ≠ null`, `failed`, `expired`, `blocked` з `cleanupState = 'pending'` — не повертаються;
   - `blocked` з `cleanupState` `none` / `applied` / `dismissed` / `lapsed` і `stored = true` — повертається;
   - три `available` + активний → повертаються два найстаріші.
   - Окрема чиста функція (або частина `dueUnpin`), що рахує `keep`: `ref`, спільний зі знятим
     релізом і активним, потрапляє в `keep` знятого; `ref`, спільний лише з іншим знятим, — ні.
3. Юніт `onRollbackSuccess` і `onDeploySuccess` (reactivate): патч активованого релізу містить `imageUnpinnedAt: null`.
4. Docker-тест агента (`packages/agent/src/storage.docker.test.ts`):
   - після `unpinImages` ні `pinRef`, ні `ref` не знаходяться через `docker image inspect`;
   - повторний виклик дає `{ unpinned: true }`;
   - коли контейнер використовує образ — `{ unpinned: false }`, образ на місці;
   - `ref` із `keep` лишається, а `pinRef` того сервісу знято.
5. Docker-тест «відкат зі сховища» для `local` на справжньому pulled-образі. Digest береться
   так, як його записує `pullImages` (`RepoDigests[0]`, інакше `Id`), а не через `Id` збудованого
   образу. Кроки: `pullImages` → `storeImages` → `unpinImages` → `fetchImages` з цим digest →
   образ присутній і без `STORAGE_FAILED`.
6. Тест планувальника (`packages/server/src/scheduler.test.ts`):
   - `unpinned: true` ставить `imageUnpinnedAt = now`;
   - `unpinned: false` і помилка агента маркер не ставлять, а наступний тік викликає агента знову;
   - агент офлайн — виклику немає;
   - активний і попередній релізи агентові не передаються;
   - два тіки з `unpinned: false` дають два різні `opId`.
6а. Тест оркестратора (`packages/server/src/orchestrator.test.ts` або сусідній `*.test.ts`):
   - повторна активація `stored` релізу кличе `fetchImages` до `pullImages`;
   - contract `stored` релізу кличе `fetchImages` до `runCommand`;
   - новий реліз (не reactivate) кроку `fetch` не має.
7. Міграція: на БД зі схемою до `005` `migrate.latest()` проходить, наявні релізи мають `image_unpinned_at = null`.
8. Наприкінці: `git diff --stat main...HEAD` торкається лише файлів, названих у §3, їхніх тестів і цієї спеки.
