# UI redesign (100 environments, 1,000 deploys) — implementation plan

**Goal:** `/` is a paged cross-environment "Latest deploys" feed beside an index of all environments, with server-side search; the env page folds older releases and pages them 20 at a time; header and content share one 1,320 px column; copy rewritten in all 8 catalogs; three SQLite indexes for the new sort orders.
**Spec:** docs/sdd/specs/2026-11-22-ui-redesign.md
**Prototype:** docs/sdd/proto/ui-redesign/decision.md (variant C4, `docs/sdd/proto/ui-redesign/variants/c4/index.html`)
**Verification:** `pnpm verify` exits 0 (build, unit, docker and e2e suites all green).
Codex budget: weekly 39% left, reserve 10%, 7/7 tasks to codex (estimate 7%)
Duplicate check (`ub-tools.sh dryer`): one pair ≥ 0.8 — `packages/server/src/ui/panel.ts:52-56` and `:120-130`; Task 6 owns it.

**Deviation from spec 3.6, for approval:** no `repo.listOlderReleases`. `/env/:id/older` builds `oneEnvVM` for that one env (spec §2 already allows the full VM for one env) and pages the "older" set in memory with the same cursor. One fewer repo method and one predicate instead of two that must agree.

## Context

The board renders a column per environment and a card per release, loading all releases and 200 operations per env (200+ queries, ~1,100 cards at 100 envs). The approved prototype C4 replaces it with a feed + index, folds older releases on the env page, aligns the header with content, and the spec rewrites the copy. The user asked that the UI only present existing functionality: no stage concept, no "needs attention" summary.

## Global constraints

- Server-rendered HTML through `html` / `raw` / `tr` (`packages/server/src/ui/html.ts`), htmx, Tailwind v4 utilities in templates. Plain CSS only in `packages/server/src/public/app.src.css` for what utilities cannot express (`:has()` panel rules, timeline pseudo-elements); say why in one line of the task report.
- Reuse controls from `packages/server/src/ui/form.ts` (`button`, `select`, `input`, `alert`) and helpers from `packages/server/src/ui/board.ts` (`short`, `prodTag`, `releaseBadge`, `stateLabel`, `agentBadge`, `diffView`, `notes`, `windowBar`, `windowLeft`, types `EnvVM`, `ReleaseVM`).
- A block hidden with the `hidden` attribute never gets a bare display utility; use `[&:not([hidden])]:flex`.
- No code comments unless they record a constraint the code cannot show.
- `data-testid` kept: `rel-<env>-<sha7>` (+ `data-state`, `hx-get="/panel/<id>"`, `hx-target="#panel"`), `env-jump`, `panel`, `confirm-ask`, `confirm-yes`, `confirm-no`, `rollback-go`, `rollback-done`, `lang`, `env-new`. New: `feed`, `env-index`, `env-link-<name>`, `feed-more`, `env-older-more`, `search`. Removed: `col-<name>`, `env-settings-<name>`.
- Cursor format everywhere: `<deployedAt>.<releaseId>`; parse with `/^(\d+)\.([A-Za-z0-9-]+)$/`; next page = rows where `(deployed_at, id) < (at, id)`, ordered `deployed_at desc, id desc`.
- Page sizes: feed 25, older releases 20.
- Search `q`: `String(query.q ?? '').trim().toLowerCase().slice(0, 100)`. Env matches when `name` or `branch` contains `q`; a release matches when its env matches or `commit_sha` starts with `q`. `only=prod` → production only; any other value → all.
- Env status dot (priority top-down): `mismatch` (env has `markerWarnings`) → `offline` (`!hub.isOnline(serverId)`) → `ok` if the env has a pending/running operation → `warn` if latest release state is `failed`, or active release has `stored === false`, or the latest finished operation of the env has `code === 'CONTRACT_FAILED'` and `toReleaseId === active.id` → else `ok`. `blocked` never makes it `warn`.
- Env page split: top table = active release, every `available`, and every `failed`/`blocked` with `deployedAt >= active.deployedAt`; with no active release, top = the latest release only. Older = everything else, `deployedAt desc, id desc`.
- Environment limits: not found (no heavy builds).

## Review Focus

- Search with SQL wildcard characters (`%`, `_`) must match literally — escape them in `like` (Task 1).
- A release redeployed (same commit, `deployed_at` updated) between two `/feed` clicks must not appear twice (Task 1 cursor test).
- `GET /` with zero environments renders both empty states, no crash (Task 3).
- Env with no releases: env page renders `env.inWindow` empty state, no older button, `/env/:id/older` returns empty fragment (Task 5).
- Production confirm still posts `confirm=yes`; non-production keeps a single-click submit (Task 6).

## Waves

| Wave | Tasks | Why together |
|---|---|---|
| 0 | 0 | alone — acceptance tests, red until the last wave |
| 1 | 1, 2 | disjoint: `db/*` vs `core/src/i18n/*` |
| 2 | 4 | layout consumes Task 2 keys |
| 3 | 3 | consumes Tasks 1, 2, 4 |
| 4 | 5 | shares `routes/ui.ts`, `ui/views.test.ts` with Task 3 |
| 5 | 6 | shares `ui/views.test.ts` |
| 6 | 7 | removes keys only after Tasks 3, 5, 6 stop using them |

Serialized on purpose: Tasks 3, 4, 5 and 6 all edit `packages/server/src/ui/views.test.ts` (and 3/5 `routes/ui.ts`, 3/4 `app.src.css`), so they run one per wave.

---

### Task 0: acceptance tests

**Writes:** `packages/server/src/ui/home.test.ts`, `packages/server/src/db/repo-feed.test.ts`, `packages/server/src/app-home.test.ts`, `e2e/acceptance.spec.ts`
**Executor:** claude
**Covers:**
- "`listRecentReleases` сортує за `deployed_at desc, id desc`, поважає курсор `before` і `limit` …, `productionOnly`, `q` … і повертає правильний `rest`; `envStatuses` повертає останній / активний реліз і останню завершену операцію; міграція 004 створює три індекси."
- "`homeView` на 100 оточеннях × 10 релізів рендерить рівно 25 `data-testid="rel-` і кнопку `feed-more` з `{n} not shown` = 975; групи Production / Other у порядку `position`; крапки … за правилами 3.1; немає сирих ключів у 8 мовах."
- "`envView` з 140 релізами (активний, 14 `available`, 125 `expired`) рендерить 15 рядків і кнопку «Show 20 older» з 125 not shown; давній `blocked` — в «Older», `failed` новіший за активний — у верхню таблицю; фрагмент `/env/:id/older` — 20 рядків, друга сторінка за курсором — наступні 20."
- "крапка оточення з `failed`-релізом і активною операцією — `ok`; з `blocked` останнім релізом — `ok`."
- "`GET /` для 100 оточень не викликає `repo.listReleases`; `GET /feed?before=garbage` → 400; `GET /?q=<sha-prefix>` повертає рядок цього релізу; `GET /env/unknown/older` → 404."
- "E2E: відкат з головної через `rel-production-aaaaaaa` проходить; `col-production` замінено на `env-link-production`."

- [x] **Step 1: write `packages/server/src/db/repo-feed.test.ts`** — setup copied from `db/repo.test.ts:9-75` (`openDb(':memory:')`, `new Repo(db)`, `mkServer`, `mkEnv`, `newRelease`, `newOperation`; import them by copying, they are not exported). Tests:
  ```ts
  it('creates the scale indexes', async () => {
    const names = (await db.raw("select name from sqlite_master where type = 'index'")).map((r: { name: string }) => r.name);
    expect(names).toEqual(expect.arrayContaining(['releases_env_deployed', 'releases_deployed', 'operations_env_started']));
  });
  it('pages the feed by cursor, newest first, with rest', async () => {
    // seed 2 envs (prod isProduction true, dev false), 30 releases each, deployedAt = 1000 + k * 10 (distinct)
    const p1 = await repo.listRecentReleases({ q: '', productionOnly: false, before: null, limit: 25 });
    expect(p1.rows).toHaveLength(25);
    expect(p1.rest).toBe(35);
    expect(p1.rows.map((r) => r.deployedAt)).toEqual([...p1.rows.map((r) => r.deployedAt)].sort((a, b) => b - a));
    const last = p1.rows.at(-1)!;
    await repo.insertRelease({ ...newRelease(prodId, 'f'.repeat(40), 'available'), deployedAt: 99_999 });
    const p2 = await repo.listRecentReleases({ q: '', productionOnly: false, before: { at: last.deployedAt, id: last.id }, limit: 25 });
    expect(p2.rows.some((r) => p1.rows.some((x) => x.id === r.id))).toBe(false);
    expect(p2.rest).toBe(10);
    expect(p2.rows[0]).toHaveProperty('envName');
    expect(p2.rows[0]).toHaveProperty('envIsProduction');
  });
  it('filters production and search', async () => {
    const prod = await repo.listRecentReleases({ q: '', productionOnly: true, before: null, limit: 100 });
    expect(prod.rows.every((r) => r.envIsProduction)).toBe(true);
    const byName = await repo.listRecentReleases({ q: 'dev', productionOnly: false, before: null, limit: 100 });
    expect(byName.rows.every((r) => r.envName.includes('dev'))).toBe(true);
    const target = prod.rows[3]!;
    const bySha = await repo.listRecentReleases({ q: target.commitSha.slice(0, 8), productionOnly: false, before: null, limit: 100 });
    expect(bySha.rows.map((r) => r.id)).toContain(target.id);
    expect((await repo.listRecentReleases({ q: '%', productionOnly: false, before: null, limit: 5 })).rows).toHaveLength(0);
    expect(await repo.envIdsWithShaPrefix(target.commitSha.slice(0, 8))).toEqual(new Set([target.envId]));
  });
  it('reports latest, active release and last finished operation per env', async () => {
    const s = await repo.envStatuses();
    expect(s.get(prodId)!.latest!.deployedAt).toBe(Math.max(/* prod deployedAts */));
    expect(s.get(prodId)!.active?.state).toBe('active');
    // one succeeded op then one running op on prod: lastOp is the succeeded one
    expect(s.get(prodId)!.lastOp?.status).toBe('succeeded');
  });
  ```
  Seed releases via `repo.insertRelease({...newRelease(envId, sha40, k === 0 ? 'active' : 'available'), deployedAt })`; commit SHAs `k.toString(16).padStart(8, '0') + env letter repeated to 40 chars` so prefixes are unique. Operations via `repo.createOperation` + `repo.updateOperation(id, { status: 'succeeded', finishedAt })`.
- [x] **Step 2: write `packages/server/src/ui/home.test.ts`** — imports `homeView`, `envDot`, types `HomeVM`, `FeedRowVM`, `IndexEnvVM` from `./home.ts`, `envView` from `./env.ts`, `i18n`, `LANGS` from `@microrun/core/i18n`. Helpers: `NOW = Date.UTC(2026, 10, 22, 12)`; `row(k)` builds a `FeedRowVM` (`id: 'r'+k`, `envId: 'e'+(k%100)`, `envName: 'env-'+(k%100)`, `isProduction: k%100 < 10`, `sha: k.toString(16).padStart(40,'0')`, `message: 'msg '+k`, `author: 'dev'`, `deployedAt: NOW - k*60_000`, `state: 'available'`, `schemaChange: false`). Tests:
  ```ts
  const vm: HomeVM = { q: '', only: 'all', feed: Array.from({ length: 25 }, (_, k) => row(k)), rest: 975, next: `${NOW - 24 * 60_000}.r24`,
    envs: Array.from({ length: 100 }, (_, k) => ({ id: 'e'+k, name: 'env-'+k, isProduction: k % 10 === 0, dot: 'ok' })) };
  const out = homeView(i18n('en'), vm, NOW).__html;
  expect(out.match(/data-testid="rel-/g)).toHaveLength(25);
  expect(out).toContain('data-testid="feed-more"');
  expect(out).toContain('975 not shown');
  expect(out).toContain('hx-get="/feed?before=' );
  expect(out.indexOf('data-testid="env-link-env-0"')).toBeLessThan(out.indexOf('data-testid="env-link-env-1"'));
  // Production group (env-0, env-10, …) precedes Other group (env-1, …)
  expect(out.indexOf('Production')).toBeLessThan(out.indexOf('Other environments'));
  ```
  Dot rules (pure function):
  ```ts
  const base = { mismatch: false, online: true, busy: false, latest: 'active' as const, activeUnstored: false, contractFailed: false };
  expect(envDot(base)).toBe('ok');
  expect(envDot({ ...base, mismatch: true, online: false })).toBe('mismatch');
  expect(envDot({ ...base, online: false })).toBe('offline');
  expect(envDot({ ...base, latest: 'failed' })).toBe('warn');
  expect(envDot({ ...base, latest: 'failed', busy: true })).toBe('ok');
  expect(envDot({ ...base, latest: 'blocked' })).toBe('ok');
  expect(envDot({ ...base, activeUnstored: true })).toBe('warn');
  expect(envDot({ ...base, contractFailed: true })).toBe('warn');
  ```
  Raw keys in 8 languages: for each `lang` of `LANGS`, render `homeView(i18n(lang), vm, NOW)` and `homeView(i18n(lang), { ...vm, feed: [], rest: 0, next: null, envs: [], q: 'zz' }, NOW)`; assert no match of `/\b(home|search|env|state|rb)\.[a-zA-Z.]+\b/` outside attribute values and no `undefined|NaN`.
  Env page split (build `EnvVM` with the `env()`/`release()` factories copied from `views.test.ts:22-46,101-119`): 140 releases, index 0 `active`, 1–14 `available`, 15–139 `expired`, `deployedAt = NOW - k * HOUR`; plus case B: release `failed` newer than active and `blocked` older than active.
  ```ts
  const out = envView(i18n('en'), e140, NOW, { settings: html`<p>S</p>` }).__html;
  expect(out.match(/data-testid="rel-/g)).toHaveLength(15);
  expect(out).toContain('data-testid="env-older-more"');
  expect(out).toContain('125 not shown');
  expect(out).toContain('Show 20 older');
  // case B
  expect(top(outB)).toContain(`rel-x-${failed.sha.slice(0,7)}`); expect(top(outB)).not.toContain(`rel-x-${oldBlocked.sha.slice(0,7)}`);
  ```
  where `top(out)` slices from `data-testid="env-in-window"` to `data-testid="env-older"`.
- [x] **Step 3: write `packages/server/src/app-home.test.ts`** — build the app exactly like `app-c.test.ts:58-81` (`build(config)`), login like `app-c.test.ts:104`. Seed 100 envs with `repo.saveEnv` (positions 0..99, every 10th production, unique branches `b-<k>`) and 10 releases each with `repo.insertRelease`. Tests:
  ```ts
  const spy = vi.spyOn(repo, 'listReleases');
  const res = await get('/');
  expect(res.statusCode).toBe(200);
  expect(spy).not.toHaveBeenCalled();
  expect(res.body.match(/data-testid="rel-/g)).toHaveLength(25);
  expect(res.body).toContain('975 not shown');
  expect((await get('/feed?before=garbage')).statusCode).toBe(400);
  const more = await get(`/feed?before=${encodeURIComponent(nextFrom(res.body))}`);
  expect(more.body.match(/data-testid="rel-/g)).toHaveLength(25);
  const hit = await get(`/?q=${target.commitSha.slice(0, 10)}`);
  expect(hit.body).toContain(`data-testid="rel-${targetEnvName}-${target.commitSha.slice(0, 7)}"`);
  expect((await get('/env/unknown/older')).statusCode).toBe(404);
  const older = await get(`/env/${env140Id}/older`);   // an env seeded with 140 releases (1 active, 14 available, 125 expired)
  expect(older.body.match(/data-testid="rel-/g)).toHaveLength(20);
  ```
  `nextFrom(body)` extracts the `before=` value from `hx-get="/feed?before=…"`.
- [x] **Step 4: edit `e2e/acceptance.spec.ts:196`** — `'[data-testid=col-production] a[href^="/env/"]'` → `'[data-testid=env-link-production]'` and read its `href`.
- [x] **Step 5: run them, watch them fail** — `pnpm vitest run packages/server/src/ui/home.test.ts packages/server/src/db/repo-feed.test.ts packages/server/src/app-home.test.ts`, expect failures: `Failed to resolve import "./home.ts"` and `repo.listRecentReleases is not a function`.

---

### Task 1: indexes and feed queries

**Writes:** `packages/server/src/db/migrations/004_scale_indexes.ts`, `packages/server/src/db/db.ts`, `packages/server/src/db/repo.ts`
**Reads:** `packages/server/src/db/migrations/003_compose_env_files.ts`, `packages/server/src/db/repo.test.ts`
**Depends on:** Task 0
**Executor:** codex
**Complexity:** complex
**Satisfies:** `repo-feed.test.ts` (all)
**Interfaces:**
- Produces in `repo.ts`:
  - `export type FeedRow = ReleaseRow & { envName: string; envIsProduction: boolean }`
  - `export type Cursor = { at: number; id: string }`
  - `listRecentReleases(f: { q: string; productionOnly: boolean; before: Cursor | null; limit: number }): Promise<{ rows: FeedRow[]; rest: number }>`
  - `envStatuses(): Promise<Map<string, { latest: ReleaseRow | null; active: ReleaseRow | null; lastOp: OperationRow | null }>>`
  - `envIdsWithShaPrefix(q: string): Promise<Set<string>>`

- [ ] **Step 1: run the target, watch it fail** — `pnpm vitest run packages/server/src/db/repo-feed.test.ts`, expect `repo.listRecentReleases is not a function`.
- [ ] **Step 2: migration** — `004_scale_indexes.ts`, same shape as `003_compose_env_files.ts`:
  ```ts
  import type { Knex } from 'knex';
  export async function up(knex: Knex): Promise<void> {
    await knex.raw('create index releases_env_deployed on releases(env_id, deployed_at)');
    await knex.raw('create index releases_deployed on releases(deployed_at)');
    await knex.raw('create index operations_env_started on operations(env_id, started_at)');
  }
  export async function down(knex: Knex): Promise<void> {
    await knex.raw('drop index operations_env_started');
    await knex.raw('drop index releases_deployed');
    await knex.raw('drop index releases_env_deployed');
  }
  ```
  Register in `db.ts`: `import * as scaleIndexes from './migrations/004_scale_indexes.ts'` and add `'004_scale_indexes': scaleIndexes` to the `migrations` map after `'003_compose_env_files'`.
- [ ] **Step 3: queries in `repo.ts`**, built on the private `releases()` builder (`repo.ts:279`, joins `environments as e`) and `allOf`/`fromDb` with `RELEASE`/`OPERATION` shapes:
  - `listRecentReleases`: base = `this.releases().select('e.name as env_name', 'e.is_production as env_is_production')`; `productionOnly` → `where('e.is_production', 1)`; `q` non-empty → `where(b => b.where('e.name', 'like', pat).orWhere('e.branch', 'like', pat).orWhere('r.commit_sha', 'like', pre))` with `pat = '%' + escLike(q) + '%'`, `pre = escLike(q) + '%'`, each with `escape '\\'` via `knex.raw('? escape ?', …)` or `whereRaw("e.name like ? escape '\\'", [pat])`; `escLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c)`. Cursor → `whereRaw('(r.deployed_at < ? or (r.deployed_at = ? and r.id < ?))', [at, at, id])`. Rows: `.orderBy([{ column: 'r.deployed_at', order: 'desc' }, { column: 'r.id', order: 'desc' }]).limit(limit)`; map with `fromDb(row, RELEASE)` plus `envName: row.env_name`, `envIsProduction: !!row.env_is_production`. `rest` = `count(*)` of the same filtered query (same cursor) minus `rows.length`, never below 0.
  - `envStatuses`: three raw queries with `row_number() over (partition by env_id order by …) as rn … where rn = 1`: latest release (`order by deployed_at desc, id desc`), active (`where state = 'active'`, unique per env), latest finished operation (`where status not in ('pending','running') order by started_at desc, id desc`). Release rows go through the same `has_cleanup_cmd` join as `releases()` (or set `hasCleanupCmd` via a join in the raw SQL). Map every env id from `listEnvs()` (envs without rows get `null`s).
  - `envIdsWithShaPrefix(q)`: `select distinct env_id from releases where commit_sha like ? escape '\'` with `escLike(q) + '%'`; empty `q` → empty set.
- [ ] **Step 4: run it, watch it pass** — `pnpm vitest run packages/server/src/db/repo-feed.test.ts packages/server/src/db/repo.test.ts`, expect all passed.

---

### Task 2: catalog texts (add and change; removals are Task 7)

**Writes:** `packages/core/src/i18n/catalogs/ui.ts`, `packages/core/src/i18n/i18n.test.ts`
**Depends on:** Task 0
**Executor:** codex
**Complexity:** routine
**Satisfies:** none directly (keys consumed by Tasks 3–6; `i18n.test.ts` "every language has exactly the keys of en" stays green)
**Interfaces:**
- Produces keys (all 8 languages: `en, uk, de, fr, es, pt-BR, pl, zh-CN`; non-English translated by meaning, `uk` with `one/few/many/other` plurals, others per `Intl.PluralRules` categories they use).

- [ ] **Step 1: change English values** in `catalogs/ui.ts` `en` block and translate the same change in the 7 other blocks:
  `state.active` Live · `state.available` Can roll back · `state.blocked` Rolled back · `state.expired` Window closed · `env.prodTag` Production · `env.newEnv` New environment · `env.back` ← Overview · `rb.willBlock` After the rollback, these commits can’t be deployed again: · `rb.schema` The database schema stays as it is. No data is deleted. · `rb.noMarker` Rollback is unavailable until the database mismatch is fixed. · `rb.noAgent` Rollback is unavailable: the agent on server {server} is offline. · `note.blocked` Rolled back to {to} {at}. Deploying this commit again is refused; push the fix as a new commit. · `approve.title` The migration removes a column · `approve.text` The deploy of {sha} was stopped because its migration removes {col}. Approval lets the next deploy of this commit remove it, once; run the deploy again from CI. · `cl.sub` Optional. The rollback is already done. Counts come from a dry run of your cleanup command. · `cl.skip` Keep the data.
  (The `·` only separates entries here; it is not part of any value.)
- [ ] **Step 2: add keys** (English value → translate):
  `home.feed` Latest deploys · `home.envs` All environments · `home.filterAll` All · `home.filterProd` Production · `home.other` Other environments · `home.more` Show 25 more · `home.notShown` `{ one: '{n} not shown', other: '{n} not shown' }` · `home.feedEmpty` Nothing deployed yet. Deploys from CI appear here. · `home.dot.ok` Running normally · `home.dot.warn` Needs a look · `home.dot.mismatch` Connected to another environment’s database · `home.dot.offline` Agent offline · `search.placeholder` Search environments, branches or commits · `search.label` Search · `search.none` No environment, branch or commit matches “{q}”. · `search.clear` Clear search · `env.newEnvShort` New · `env.inWindow` Within the rollback window · `env.older` Older releases · `env.olderHint` Kept as a record. You can’t roll back to them. · `env.showOlder` `{ one: 'Show {n} older', other: 'Show {n} older' }` · `rb.ask` Roll back production {env} to {sha}? · `rb.yes` Yes, roll back · `approve.ask` Allow {sha} to remove {col} in production? · `approve.yes` Yes, approve · `confirm.cancel` Cancel.
- [ ] **Step 3: fix value assertions** — if any test in `packages/core/src/i18n/i18n.test.ts` asserts an old English/Ukrainian value changed in Step 1 (grep for `Active`, `PRODUCTION`, `Rollback closed`, `Will be blocked`), update it to the new value.
- [ ] **Step 4: run** — `pnpm vitest run packages/core`, expect all passed (key-parity test included).

---

### Task 4: header and column layout

**Writes:** `packages/server/src/ui/layout.ts`, `packages/server/src/public/app.src.css`, `packages/server/src/ui/views.test.ts`
**Reads:** `docs/sdd/proto/ui-redesign/src/c4.html` (header markup and CSS), `packages/server/src/ui/form.ts`
**Depends on:** Task 2
**Executor:** codex
**Complexity:** routine
**Satisfies:** none of Task 0 directly (visual spec 3.3; tested in its own `layout` block)
**Interfaces:**
- Produces: `layout(p: { i: I18n; title: string; csrf: string; body: Html; q?: string }): string`. Search input `<input type="search" name="q" data-testid="search" value="${p.q ?? ''}" aria-label="${search.label}" placeholder="${search.placeholder}">` inside `<form method="get" action="/" role="search" hx-get="/" hx-trigger="input changed delay:250ms from:find input, search from:find input" hx-target="#home" hx-select="#home" hx-push-url="true">`.

- [ ] **Step 1: failing tests** — in `views.test.ts` `describe('layout')` (464-524) add: output contains `data-testid="search"`, `name="q"`, `hx-select="#home"`; header wraps its content in an element with `max-w-[1320px]`; `<main` has `max-w-[1320px]`; with `q: 'abc'` the input has `value="abc"`; the "New" short label `env.newEnvShort` is present and the button keeps `aria-label` = `env.newEnv`. Run `pnpm vitest run packages/server/src/ui/views.test.ts -t layout`, expect failures.
- [ ] **Step 2: implement `layout.ts`** —
  - `<header class="sticky top-0 z-10 border-b border-line bg-surface py-2.5">` containing `<div class="top-in mx-auto flex max-w-[1320px] flex-wrap items-center gap-x-3.5 gap-y-2.5 px-4 min-[761px]:flex-nowrap">`: logo link (as now), search form (`order-3 basis-full min-[761px]:order-none min-[761px]:basis-auto min-[761px]:max-w-[440px] min-[761px]:flex-1`, input styled with `CONTROL` from `form.ts` plus `pl-9` and a search icon), language form with `select({ … compact: true })` (`ml-auto`), new-env link `data-testid="env-new"` with `aria-label="${i.t('env.newEnv')}"` and label `<span class="min-[761px]:hidden">${env.newEnvShort}</span><span class="max-[760px]:hidden">${env.newEnv}</span>`.
  - `<main class="mx-auto min-w-0 max-w-[1320px] px-4 py-5 …existing section rules…">`.
  - Inline script after the header: `document.addEventListener('keydown',function(e){if(e.key==='/'&&!/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)){e.preventDefault();document.querySelector('[data-testid=search]').focus()}})`.
- [ ] **Step 3: CSS** — in `app.src.css` replace `@media (min-width:1100px){body:has(#panel:not(:empty)) main{margin-right:440px}}` with `@media (min-width:1100px){body:has(#panel:not(:empty)) :is(main,header){margin-right:440px}body:has(#panel:not(:empty)) header .top-in{margin-right:0}}` (Tailwind cannot target a sibling's `:has()` state). Set `section[id]` scroll margin / `env-jump` sticky top to `57px`, and `108px` under `@media (max-width:760px)` (add a `--jump-top` custom property in `:root` and use it in `env.ts`'s `JUMP` class via `top-[var(--jump-top)]` in Task 5; here only define the property).
- [ ] **Step 4: run** — `pnpm vitest run packages/server/src/ui/views.test.ts`, expect all passed.

---

### Task 3: home page — feed, index, routes

**Writes:** `packages/server/src/ui/home.ts`, `packages/server/src/ui/board.ts`, `packages/server/src/routes/ui.ts`, `packages/server/src/ui/views.test.ts`, `packages/server/src/public/app.src.css`
**Reads:** `docs/sdd/proto/ui-redesign/src/c4.html` (feed and index markup), `packages/server/src/ui/board.ts`, `packages/server/src/app-c.test.ts`
**Depends on:** Tasks 1, 2, 4
**Executor:** codex
**Complexity:** complex
**Satisfies:** `home.test.ts` (homeView, envDot, raw keys), `app-home.test.ts` (`GET /`, `/feed`, `?q=`)
**Interfaces:**
- Consumes: `repo.listRecentReleases`, `repo.envStatuses`, `repo.envIdsWithShaPrefix`, `FeedRow`, `Cursor` (Task 1); `layout({ …, q })` (Task 4); keys `home.*`, `search.*` (Task 2).
- Produces in `ui/home.ts`:
  ```ts
  export type EnvDot = 'ok' | 'warn' | 'mismatch' | 'offline';
  export interface FeedRowVM { id: string; envId: string; envName: string; isProduction: boolean; sha: string; message: string; author: string; deployedAt: number; state: ReleaseState; schemaChange: boolean }
  export interface IndexEnvVM { id: string; name: string; isProduction: boolean; dot: EnvDot }
  export interface HomeVM { q: string; only: 'all' | 'prod'; feed: FeedRowVM[]; rest: number; next: string | null; envs: IndexEnvVM[] }
  export function envDot(s: { mismatch: boolean; online: boolean; busy: boolean; latest: ReleaseState | null; activeUnstored: boolean; contractFailed: boolean }): EnvDot;
  export function feedPage(i: I18n, vm: Pick<HomeVM, 'q' | 'only' | 'feed' | 'rest' | 'next'>, now: number): Html; // rows + more button
  export function homeView(i: I18n, vm: HomeVM, now: number): Html; // <div id="home">…</div>
  ```
  `routes/ui.ts`: `parseCursor(s: unknown): Cursor | null | 'bad'` (absent/empty → `null`, invalid → `'bad'`), `cursorOf(r: { deployedAt: number; id: string }) => \`${r.deployedAt}.${r.id}\``.

- [ ] **Step 1: run the target, watch it fail** — `pnpm vitest run packages/server/src/ui/home.test.ts packages/server/src/app-home.test.ts`, expect `Failed to resolve import "./home.ts"`.
- [ ] **Step 2: `ui/home.ts`** — markup per prototype C4 `src/c4.html` (`.cols`, `.feed`, `.idx`), as Tailwind utilities:
  - `homeView` → `<div id="home" class="grid grid-cols-1 gap-7 min-[901px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] items-start">` with feed section (`data-testid="feed"`, `h2` `home.feed`, filter links `href="/?only=…&q=…"` with `aria-pressed`, list) and index section (`data-testid="env-index"`, `h2` `home.envs` + count, groups `env.prodTag`-styled "Production" heading and `home.other`, each a `ul` with `columns-2 gap-4`, items `<a href="/env/<id>" data-testid="env-link-<name>">` with a dot `<span class="size-2 rounded-full …" title="${home.dot.<dot>}"><span class="sr-only">…</span></span>`; dot classes: ok `bg-ok`, warn `bg-warn`, mismatch `bg-prod`, offline `border-2 border-warn bg-transparent`).
  - Feed row (`li`): `<a … data-testid="rel-${envName}-${short(sha)}" data-state="${state}" hx-get="/panel/${id}" hx-target="#panel" hx-trigger="click, keydown[key=='Enter']" tabindex="0" role="button">` grid `grid-cols-[74px_minmax(0,1fr)_auto]`: `i.ago(deployedAt, now)`, env name (`text-prod` when production) + `short(sha)` mono + message + small line `author` and, when `schemaChange`, ` · ${tr(i, 'col.schema')}` (existing key), then `releaseBadge(i, state)` from `board.ts`.
  - `feedPage` renders the rows and, when `rest > 0 && next`, `<button type="button" data-testid="feed-more" hx-get="/feed?before=${encodeURIComponent(next)}&q=${encodeURIComponent(q)}&only=${only}" hx-target="closest li" hx-swap="outerHTML">${home.more} <span>${home.notShown {n: rest}}</span></button>` wrapped in an `li` so the swap appends rows in place.
  - Empty feed: `home.feedEmpty` without `q`, `search.none {q}` + link `search.clear` to `/` with `q`. Empty index with `q`: `search.none`.
  - `envDot` implements the global-constraints rule exactly.
- [ ] **Step 3: `board.ts`** — delete `boardView`, `column`, `card`, `CARD`, `COLUMN*`, `cardBorder`, `STATE_INK` (only used by the board) and keep every other export. `app.src.css`: delete the `.tl`, `.tl::before`, `.rel::before`, `.rel.*::before` rules.
- [ ] **Step 4: routes** — in `routes/ui.ts`:
  - `page()` passes `q: String((req.query as { q?: unknown }).q ?? '')` to `layout`.
  - `GET /`: `q` and `only` per global constraints; `[envs, servers, statuses, busy, feed, shaHits]` = `repo.listEnvs()`, `repo.listServers()`, `repo.envStatuses()`, `new Set((await repo.activeOperations()).map(o => o.envId))`, `repo.listRecentReleases({ q, productionOnly: only === 'prod', before: null, limit: 25 })`, `q ? repo.envIdsWithShaPrefix(q) : new Set()`. Index = envs filtered by name/branch contains `q` or `shaHits.has(id)`, order from `listEnvs()` (production first group, then the rest, each keeping position order). Dot inputs: `mismatch = (d.scheduler.markerWarnings().get(id) ?? []).length > 0`, `online = d.hub.isOnline(serverId)`, `busy`, `latest = statuses.latest?.state ?? null`, `activeUnstored = !!active && !active.stored`, `contractFailed = lastOp?.code === 'CONTRACT_FAILED' && lastOp.toReleaseId === active?.id`. Feed rows map `FeedRow` → `FeedRowVM` (`schemaChange = Array.isArray(schemaDiff) && schemaDiff.length > 0`). `next = rows.length ? cursorOf(rows.at(-1)) : null`. Render `page(req, reply, i.t('nav.envs'), homeView(i, vm, clock()))`. Remove the old `envVM`-per-env code from this route.
  - `GET /feed`: same `q`/`only`; `parseCursor(query.before)` → `'bad'` gives `reply.code(400).send()`; else `sendHtml(reply, feedPage(…))`.
- [ ] **Step 5: `views.test.ts`** — change the type alias at line 10 to `import type { EnvVM } from './board.ts'`; delete `describe('boardView')` (152-250); in "every view in every language" (922-1005) and "production tag" (900-920) replace `boardView(...)` calls with `homeView(li, homeVmFrom(envs), NOW)` where `homeVmFrom` maps `EnvVM[]` to a `HomeVM` (one feed row per release, dot `ok`).
- [ ] **Step 6: run** — `pnpm vitest run packages/server`, expect `home.test.ts` homeView/envDot/raw-key tests and `app-home.test.ts` `/`, `/feed`, `?q=` tests pass; `/env/:id/older` and envView split tests still fail (Task 5).

---

### Task 5: env page — split releases and older paging

**Writes:** `packages/server/src/ui/env.ts`, `packages/server/src/routes/ui.ts`, `packages/server/src/ui/views.test.ts`
**Reads:** `docs/sdd/proto/ui-redesign/shared/views.js` (`releases()` markup), `packages/server/src/ui/board.ts`
**Depends on:** Task 3
**Executor:** codex
**Complexity:** routine
**Satisfies:** `home.test.ts` envView split tests, `app-home.test.ts` `/env/unknown/older` and `/env/:id/older`
**Interfaces:**
- Consumes: `parseCursor`, `cursorOf` (Task 3, `routes/ui.ts`); keys `env.inWindow`, `env.older`, `env.olderHint`, `env.showOlder`, `home.notShown` (Task 2); `--jump-top` CSS property (Task 4).
- Produces in `env.ts`: `export function splitReleases(rs: ReleaseVM[]): { top: ReleaseVM[]; older: ReleaseVM[] }` (rule in global constraints; `ReleaseVM` has `id`, `state`, `deployedAt`); `export function olderPage(i: I18n, env: EnvVM, rows: ReleaseVM[], rest: number, next: string | null): Html`.

- [ ] **Step 1: run the target, watch it fail** — `pnpm vitest run packages/server/src/ui/home.test.ts -t envView`, expect missing `env-older-more`.
- [ ] **Step 2: `env.ts`** — `envView` releases section: `<h3 data-testid="env-in-window">${env.inWindow} <span>${top.length}</span></h3>` + the existing table with `top` rows; when `older.length`: `<h3 data-testid="env-older">${env.older} <span>${older.length}</span></h3><p>${env.olderHint}</p><table>…<tbody id="older-rows"></tbody></table>` followed by the button `<button type="button" data-testid="env-older-more" hx-get="/env/${id}/older" hx-target="#older-rows" hx-swap="beforeend" …>${env.showOlder {n: min(20, older.length)}} <span>${home.notShown {n: older.length}}</span></button>`. `olderPage` returns `<tr>` rows (reuse the existing `row()`), plus an out-of-band replacement of the button: `<button id="older-more" hx-swap-oob="true" …>` with the next cursor, or an empty `<span id="older-more" hx-swap-oob="true"></span>` when `rest === 0`. Give the initial button `id="older-more"`. `JUMP` sticky top becomes `top-[var(--jump-top)]`. Rows at ≤560 px: two lines (prototype `shared/base.css` `.r-row` media rule) via utilities on `td`.
- [ ] **Step 3: route** — `GET /env/:id/older`: `getEnv` → 404 when missing; `parseCursor(query.before)` → 400 when `'bad'`; `vm = await oneEnvVM(d, env)`; `{ older } = splitReleases(vm.releases)` sorted `deployedAt desc, id desc`; drop rows at or before the cursor; `page = older.slice(0, 20)`; `rest = older.length - page.length`; `next = rest ? cursorOf(page.at(-1)!) : null`; `sendHtml(reply, olderPage(i, vm, page, rest, next))`.
- [ ] **Step 4: `views.test.ts` `describe('envView')`** (252-362) — update assertions that counted all release rows to count only the top table; keep every other assertion.
- [ ] **Step 5: run** — `pnpm vitest run packages/server`, expect only Task 6/7-related failures, if any.

---

### Task 6: release panel copy and env link

**Writes:** `packages/server/src/ui/panel.ts`, `packages/server/src/ui/views.test.ts`
**Reads:** `packages/server/src/ui/board.ts`
**Depends on:** Task 5
**Executor:** codex
**Complexity:** routine
**Satisfies:** none of Task 0 directly (spec 3.4; tested in `describe('panelView')`)
**Interfaces:**
- Consumes: keys `rb.ask {env, sha}`, `rb.yes`, `approve.ask {sha, col}`, `approve.yes`, `confirm.cancel`, `rb.noAgent {server}` (Task 2).

- [ ] **Step 1: failing tests** in `describe('panelView')` (722-898): production rollback renders `rb.ask` text with env name and target sha7 and `rb.yes`, and `confirm.cancel`; approve renders `approve.ask` and `approve.yes`; offline agent renders `Rollback is unavailable: the agent on server <serverName> is offline.`; panel header contains `<a href="/env/<env.id>"`. Run `pnpm vitest run packages/server/src/ui/views.test.ts -t panelView`, expect failures.
- [ ] **Step 2: implement** — `confirmedAction(i, env, testid, label, variant, disabled, ask: { text: Html; yes: Html })`: ask block `<b>${ask.text}</b>`, yes button `testid: 'confirm-yes'` with `ask.yes`, no button `testid: 'confirm-no'` with `tr(i, 'confirm.cancel')`; `data-testid`s, `hidden`, `ASK`/`BACK` scripts and the hidden `confirm=yes` input unchanged. Rollback passes `{ text: tr(i, 'rb.ask', { env: env.name, sha: short(target.sha) }), yes: tr(i, 'rb.yes') }`; approve passes `{ text: tr(i, 'approve.ask', { sha: short(r.sha), col: r.failNote?.params.col ?? '' }), yes: tr(i, 'approve.yes') }`. Reason line: `tr(i, reason, reason === 'rb.noAgent' ? { server: env.serverName } : undefined)`. Header line: `<a href="/env/${env.id}" class="text-accent no-underline hover:underline">${env.name}</a> ${prodTag(i, env)}`. While here, `contractSection` (52-56) and the cleanup-failed form (120-130) duplicate one shape (`<form class="${SECT}" ${post(url, csrf)}>${hidden('releaseId', r.id)} … ghost retry button</form>`): extract `retryForm(url, csrf, releaseId, body: Html, testid, label)` and use it in both; do not add a third copy.
- [ ] **Step 3: run** — `pnpm vitest run packages/server/src/ui/views.test.ts packages/server/src/app.test.ts`, expect all passed.

---

### Task 7: remove obsolete keys

**Writes:** `packages/core/src/i18n/catalogs/ui.ts`
**Depends on:** Tasks 3, 5, 6
**Executor:** codex
**Complexity:** routine
**Satisfies:** final cleanup; whole suite green

- [ ] **Step 1: check unused** — `grep -rnE "'(confirm\.ask|confirm\.yes|confirm\.no|env\.open|env\.settings|env\.available)'" packages/server/src packages/agent/src e2e` must print nothing outside catalogs; if it prints, stop and report.
- [ ] **Step 2: delete** those six keys from all 8 language blocks in `catalogs/ui.ts`.
- [ ] **Step 3: run** — `pnpm -r build && pnpm test`, expect all passed; then `pnpm verify`, expect exit 0.

---

## Verification (end to end)

1. `pnpm verify` exits 0 (build, `vitest run`, docker suite, Playwright e2e including rollback from `/` via `rel-production-aaaaaaa` and the 8-language raw-key sweep via `env-link-production`).
2. Visual check with Playwright on a seeded instance: `/` and `/env/:id` at 1440, 1864 and 390 px, light and dark, panel open and closed — header and content edges match, no horizontal scroll.
