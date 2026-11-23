# Unpin local images of stored inactive releases — implementation plan

**Goal:** the scheduler removes the local Docker copies (pin tag + release `ref`) of stored `available` releases (and `blocked` without a pending cleanup), except the active and the previous release. Rollback, reactivation and contract load the image back from storage when they need it.
**Spec:** docs/sdd/specs/2026-11-23-unpin-images.md
**Verification:** `pnpm typecheck && pnpm test && pnpm test:docker` from the repo root; vitest's last summary line reads `Test Files  <n> passed (<n>)` for both test runs, and typecheck exits 0.

## Context
"треба архівувати білди, щоб вони займали меньше місця". Every `available` release keeps its full image set in the agent host's Docker until it expires, although a copy is already in storage (`local` / `s3` archive or `registry`). The agreed design (spec §3) drops those local copies and relies on the existing `fetchImages` path (`packages/agent/src/storage.ts:159`).

## Global constraints
- `PROTOCOL_VERSION` in `packages/core/src/protocol.ts:4` stays `1`.
- No code comments (repo AGENTS.md): zero comments unless they record a constraint the code cannot show.
- The unpin policy is fixed in code: active + previous stay local; no per-environment setting, no UI.
- `packages/server/src/db/repo.ts` is not edited: `toDb`/`fromDb` (`repo.ts:154-174`) map `imageUnpinnedAt` ↔ `image_unpinned_at` generically.
- End state (spec §6.8): `git diff --name-only main...HEAD` lists only the files below.
  `docs/sdd/specs/2026-11-23-unpin-images.md`, `docs/sdd/plans/2026-11-23-unpin-images.md`,
  `packages/core/src/state.ts`, `packages/core/src/state.test.ts`, `packages/core/src/protocol.ts`, `packages/core/src/protocol.test.ts`,
  `packages/agent/src/storage.ts`, `packages/agent/src/handler.ts`, `packages/agent/src/runtime.test.ts`, `packages/agent/src/storage.docker.test.ts`,
  `packages/server/src/db/migrations/005_image_unpinned_at.ts`, `packages/server/src/db/db.ts`, `packages/server/src/db/repo.test.ts`,
  `packages/server/src/scheduler.ts`, `packages/server/src/scheduler.test.ts`, `packages/server/src/orchestrator.ts`, `packages/server/src/orchestrator.test.ts`.
Environment limits: not applicable (spec §2: no build or large-data processing).

Constraint check: 5 constraints, end state covered by Task 0 Step 3 (`git diff --name-only` allowlist check, run last).

## Review Focus
- Existing scheduler tests with several `available` releases now also see `unpinImages` calls (FakeAgent returns `{}` → treated as not unpinned, logged as `in use`). Any existing test asserting the exact `agent.calls` list or exact log lines must still pass; adjust only the assertion if it enumerates every call.
- A rollback target whose `docker load` digest does not match is removed with `rmi -f` by `verify` (`storage.ts:150`); Task 0's pulled-image Docker test is the guard.
- Contract fetch failure surfaces as `CONTRACT_FAILED` (the fetch step sits inside the existing `try` in `executeContract`), so the scheduler's "no auto-retry after a failed contract" rule (`scheduler.ts:143`) and the UI retry button keep working. This is my call and refines spec §5's "STORAGE_FAILED" for the contract case only.
- `activate()` must reset `imageUnpinnedAt` for both rollback and reactivation; a release re-pinned by a later deploy must be unpinnable again.
- Spec §6.7 (pre-005 database): `openDb(':memory:')` runs every migration including 005 in each test; the repo test asserts the default `null` and round-trip.

## Waves
| Wave | Tasks | Why together |
|---|---|---|
| 0 | 0 | alone — acceptance tests, red until the last wave |
| 1 | 1, 2, 3, 6 | disjoint writes: `state.ts` / `protocol.ts` / migration + `db.ts` / `orchestrator.ts`; no interface between them |
| 2 | 4, 5 | 4 consumes Task 2's command type; 5 consumes Tasks 1, 2, 3. Writes disjoint: `storage.ts`+`handler.ts` vs `scheduler.ts` |

Serialized: Task 4 and Task 5 wait for Task 2 (the `unpinImages` command/result types); Task 5 also waits for Task 1 (`dueUnpin`, `unpinKeep`) and Task 3 (the column).

---

### Task 0: acceptance tests

**Writes:** `packages/core/src/state.test.ts`, `packages/core/src/protocol.test.ts`, `packages/agent/src/runtime.test.ts`, `packages/agent/src/storage.docker.test.ts`, `packages/server/src/db/repo.test.ts`, `packages/server/src/scheduler.test.ts`, `packages/server/src/orchestrator.test.ts`
**Executor:** claude
**Covers:** spec §6.2 (`dueUnpin` cases, `keep`), §6.3 (`imageUnpinnedAt: null` on activate), §6.4 (agent Docker unpin), §6.5 (fetch after unpin on a pulled image), §6.6 (scheduler), §6.6а (orchestrator fetch steps), §6.7 (column), §6.8 (end-state file list).

- [x] **Step 1: write the acceptance tests**

  **1a. `packages/core/src/state.test.ts`.** Add `dueUnpin, unpinKeep` to the import from `./state.ts`, add `imageUnpinnedAt: null,` to the `mk()` literal right after `imagePurgedAt: null,` (`state.test.ts:24`), and append:
  ```ts
  type U = ReleaseFacts & { stored: boolean; images: Record<string, { ref: string }> };
  const u = (id: string, state: ReleaseState, extra: Partial<U> = {}): U =>
    ({ ...mk(id, state), stored: true, images: { web: { ref: `app:${id}` } }, ...extra });

  describe('dueUnpin', () => {
    it('keeps the active and the most recently superseded release, oldest first', () => {
      const rs = [
        u('R4', 'active'),
        u('R3', 'available', { supersededAt: 300 }),
        u('R2', 'available', { supersededAt: 200 }),
        u('R1', 'available', { supersededAt: 100 }),
      ];
      expect(dueUnpin(rs)).toEqual(['R1', 'R2']);
    });

    it('breaks a supersededAt tie by the larger deployedAt', () => {
      const rs = [
        u('A', 'active'),
        u('P', 'available', { supersededAt: 100, deployedAt: 20 }),
        u('Q', 'available', { supersededAt: 100, deployedAt: 10 }),
      ];
      expect(dueUnpin(rs)).toEqual(['Q']);
    });

    it('skips unstored, purged, already unpinned, failed, expired and pending-cleanup blocked releases', () => {
      const rs = [
        u('A', 'active'),
        u('PREV', 'available', { supersededAt: 999 }),
        u('S', 'available', { supersededAt: 1, stored: false }),
        u('PU', 'available', { supersededAt: 2, imagePurgedAt: 5 }),
        u('UN', 'available', { supersededAt: 3, imageUnpinnedAt: 5 }),
        u('F', 'failed'),
        u('E', 'expired', { supersededAt: 4 }),
        u('BP', 'blocked', { blockedAt: 1, cleanupState: 'pending' }),
      ];
      expect(dueUnpin(rs)).toEqual([]);
    });

    it.each(['none', 'applied', 'dismissed', 'lapsed'] as const)('unpins a stored blocked release with cleanupState %s', (cs) => {
      const rs = [u('A', 'active'), u('PREV', 'available', { supersededAt: 999 }), u('B', 'blocked', { blockedAt: 1, cleanupState: cs })];
      expect(dueUnpin(rs)).toEqual(['B']);
    });
  });

  describe('unpinKeep', () => {
    it('keeps a ref shared with a retained release and drops one shared only with another unpinned release', () => {
      const rs = [
        u('A', 'active', { images: { web: { ref: 'app:shared' } } }),
        u('P', 'available', { supersededAt: 300, images: { web: { ref: 'app:p' } } }),
        u('Y', 'available', { supersededAt: 200, images: { web: { ref: 'app:x' } } }),
        u('X', 'available', { supersededAt: 100, images: { web: { ref: 'app:shared' }, worker: { ref: 'app:x' } } }),
      ];
      const due = dueUnpin(rs);
      expect(due).toEqual(['X', 'Y']);
      expect(unpinKeep(rs, due, 'X')).toEqual(['app:shared']);
      expect(unpinKeep(rs, due, 'Y')).toEqual([]);
    });
  });

  describe('activation resets imageUnpinnedAt', () => {
    it('on deploy success (reactivation)', () => {
      const rs = [mk('R1', 'available', { activationSeq: 1, supersededAt: 100, imageUnpinnedAt: 150 }), mk('R2', 'active', { activationSeq: 2 })];
      const target = onDeploySuccess(rs, 'R1', 5000).find((p) => p.id === 'R1')!;
      expect(target.patch).toMatchObject({ state: 'active', imageUnpinnedAt: null });
    });

    it('on rollback success', () => {
      const rs = [mk('R1', 'available', { activationSeq: 1, supersededAt: 100, imageUnpinnedAt: 150 }), mk('R2', 'active', { activationSeq: 2 })];
      const target = onRollbackSuccess(rs, 'R1', 5000).find((p) => p.id === 'R1')!;
      expect(target.patch).toMatchObject({ state: 'active', imageUnpinnedAt: null });
    });
  });
  ```

  **1b. `packages/core/src/protocol.test.ts`.** Add to the `commands: Command[]` array (after the `deleteImages` sample, ~:52):
  ```ts
    { type: 'unpinImages', env: 'prod', sha: 'abc1234', images: { web: 'app:1' }, keep: ['app:1'] },
  ```

  **1c. `packages/agent/src/runtime.test.ts`.** Next to the `storeImages pins the images first` test (:153), add:
  ```ts
  it('unpinImages passes env, sha, images and keep and returns the layer result', async () => {
    const seen: unknown[] = [];
    const handler = createHandler({
      stateDir: tmp(),
      docker: fakeDocker().run,
      layers: {
        unpinImages: async (env: string, sha: string, images: Record<string, string>, keep: string[]) => {
          seen.push([env, sha, images, keep]);
          return { unpinned: true };
        },
      },
    });
    await expect(handler(key('unpin'), { type: 'unpinImages', env: 'prod', sha: 'abc1234', images: { api: 'registry/api:1' }, keep: ['registry/api:1'] }))
      .resolves.toEqual({ unpinned: true });
    expect(seen).toEqual([['prod', 'abc1234', { api: 'registry/api:1' }, ['registry/api:1']]]);
  });
  ```

  **1d. `packages/agent/src/storage.docker.test.ts`.** Add `unpinImages` to the import from `./storage.ts` (:9). Add a helper after `expectAbsent` (:78):
  ```ts
  const pinOf = (sha: string, svc: string) => `microrun-pin/${env}:${sha.slice(0, 12)}-${svc}`;
  ```
  Append a new block:
  ```ts
  describe('unpinning', () => {
    let cfg: StorageConfig;
    beforeAll(() => {
      cfg = { kind: 'local', path: join(workDir, 'unpin') };
    });

    it('removes the pin and release tags, is idempotent, and fetch brings the images back', async () => {
      const set = await buildSet('unpin');
      const sha = newSha();
      await pinImages(env, sha, set.images);
      await storeImages(cfg, env, sha, set.images);

      await expect(unpinImages(env, sha, set.images, [])).resolves.toEqual({ unpinned: true });
      await expectAbsent(set.images);
      for (const svc of Object.keys(set.images)) expect(await labelOf(pinOf(sha, svc))).toBeNull();
      await expect(unpinImages(env, sha, set.images, [])).resolves.toEqual({ unpinned: true });

      await fetchImages(cfg, env, sha, set.images);
      await expectLabels(set.images, set.labels);
    });

    it('leaves a ref listed in keep but still removes that service pin', async () => {
      const set = await buildSet('unpinkeep');
      const sha = newSha();
      await pinImages(env, sha, set.images);
      await expect(unpinImages(env, sha, set.images, [set.images.web!])).resolves.toEqual({ unpinned: true });
      expect(await labelOf(set.images.web!)).toBe(set.labels.web);
      expect(await labelOf(set.images.worker!)).toBeNull();
      expect(await labelOf(pinOf(sha, 'web'))).toBeNull();
    });

    it('reports unpinned: false while a container uses the image and keeps it', async () => {
      const set = await buildSet('unpinbusy');
      const sha = newSha();
      const name = `mrst-${id}-busy`;
      await pinImages(env, sha, set.images);
      await dk(['run', '-d', '--name', name, set.images.web!, 'sleep', '300']);
      try {
        await expect(unpinImages(env, sha, set.images, [])).resolves.toEqual({ unpinned: false });
        expect(await labelOf(set.images.web!)).toBe(set.labels.web);
      } finally {
        await dk(['rm', '-f', name]);
      }
    });

    it('fetches an unpinned release whose digest was recorded from a real pull', async () => {
      const built = await buildSet('unpinpull');
      const ref = `${registryHost}/mrst/pulled:${id}`;
      await dk(['tag', built.images.web!, ref]);
      await dk(['push', ref]);
      await purge({ web: ref, ...built.images });
      await dk(['pull', ref]);
      const line = (await dk(['image', 'inspect', '--format', '{{json .RepoDigests}} {{.Id}}', ref])).trim();
      const cut = line.lastIndexOf(' ');
      const repoDigests = JSON.parse(line.slice(0, cut)) as string[] | null;
      const digest = repoDigests?.[0] ?? line.slice(cut + 1);
      const images = { web: ref };
      const sha = newSha();

      await pinImages(env, sha, images);
      await storeImages(cfg, env, sha, images);
      await expect(unpinImages(env, sha, images, [])).resolves.toEqual({ unpinned: true });
      await expectAbsent(images);

      await fetchImages(cfg, env, sha, images, { web: digest });
      expect(await labelOf(ref)).toBe(built.labels.web);
    });
  });
  ```
  (The digest is computed exactly as `pullImages` does in `packages/agent/src/handler.ts:97-115`.)

  **1e. `packages/server/src/db/repo.test.ts`.** Add (reusing `mkServer`, `mkEnv`, `newRelease` from that file):
  ```ts
  it('stores image_unpinned_at, null by default', async () => {
    const server = await mkServer();
    const env = await mkEnv(server.id, 'prod', 'main');
    const r = await repo.insertRelease(newRelease(env.id, 'aaa', 'available'));
    expect((await repo.getRelease(r.id))!.imageUnpinnedAt).toBeNull();
    await repo.patchReleases([{ id: r.id, patch: { imageUnpinnedAt: 42 } }]);
    expect((await repo.getRelease(r.id))!.imageUnpinnedAt).toBe(42);
  });
  ```

  **1f. `packages/server/src/scheduler.test.ts`.** Append (reusing `mkEnv`, `mkRelease`, `release`, `agent`, `scheduler`, `now`, `T0`, `serverId`):
  ```ts
  describe('Scheduler unpin', () => {
    async function seed() {
      const env = await mkEnv('staging');
      const d = await mkRelease(env.id, 'ddd', 'active', 4000);
      const c = await mkRelease(env.id, 'ccc', 'available', 3000, { supersededAt: T0 - 1000 });
      const b = await mkRelease(env.id, 'bbb', 'available', 2000, { supersededAt: T0 - 2000 });
      const a = await mkRelease(env.id, 'aaa', 'available', 1000, { supersededAt: T0 - 3000 });
      return { env, a, b, c, d };
    }

    it('unpins stored releases except the active and previous one, once', async () => {
      const { a, b, c, d } = await seed();
      agent.handlers.unpinImages = () => ({ unpinned: true });
      await scheduler.tick();
      expect(agent.of('unpinImages')).toEqual([
        { type: 'unpinImages', env: 'staging', sha: 'aaa', images: { web: 'app:aaa' }, keep: [] },
        { type: 'unpinImages', env: 'staging', sha: 'bbb', images: { web: 'app:bbb' }, keep: [] },
      ]);
      expect((await release(a.id)).imageUnpinnedAt).toBe(T0);
      expect((await release(b.id)).imageUnpinnedAt).toBe(T0);
      expect((await release(c.id)).imageUnpinnedAt).toBeNull();
      expect((await release(d.id)).imageUnpinnedAt).toBeNull();

      now = T0 + 60_000;
      await scheduler.tick();
      expect(agent.of('unpinImages')).toHaveLength(2);
    });

    it('retries an in-use release with a fresh opId on the next tick', async () => {
      const { a } = await seed();
      agent.handlers.unpinImages = () => ({ unpinned: false });
      await scheduler.tick();
      now = T0 + 60_000;
      await scheduler.tick();
      const keys = agent.calls.filter((c) => c.cmd.type === 'unpinImages' && c.cmd.sha === 'aaa').map((c) => c.key.opId);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(2);
      expect((await release(a.id)).imageUnpinnedAt).toBeNull();
    });

    it('leaves the marker unset when the agent fails', async () => {
      const { a } = await seed();
      agent.handlers.unpinImages = () => { throw new AgentError('STORAGE_FAILED', { kind: 'unpin' }); };
      await scheduler.tick();
      expect((await release(a.id)).imageUnpinnedAt).toBeNull();
    });

    it('does not call an offline agent', async () => {
      await seed();
      agent.online.delete(serverId);
      await scheduler.tick();
      expect(agent.of('unpinImages')).toEqual([]);
    });

    it('passes a ref shared with the active release in keep', async () => {
      const env = await mkEnv('staging');
      const shared = { web: { ref: 'app:shared', digest: 'sha256:shared' } };
      await mkRelease(env.id, 'ddd', 'active', 4000, { images: shared });
      await mkRelease(env.id, 'ccc', 'available', 3000, { supersededAt: T0 - 1000 });
      await mkRelease(env.id, 'aaa', 'available', 1000, { supersededAt: T0 - 3000, images: shared });
      agent.handlers.unpinImages = () => ({ unpinned: true });
      await scheduler.tick();
      expect(agent.of('unpinImages')).toEqual([
        { type: 'unpinImages', env: 'staging', sha: 'aaa', images: { web: 'app:shared' }, keep: ['app:shared'] },
      ]);
    });
  });
  ```

  **1g. `packages/server/src/orchestrator.test.ts`.**
  - In `reactivates an available commit without dryRun, expand or snapshot and keeps its snapshot` (:284), change the steps expectation to
    `expect(agent.steps(op.id)).toEqual(['fetch', 'pull', 'markers', 'switch', 'store']);` and add
    `expect(agent.cmds(op.id, 'fetchImages')[0]).toMatchObject({ storage: STORAGE, env: 'prod', sha: A });`
  - In `describe('Orchestrator contract retry')` (:706) add:
  ```ts
  it('fetches the stored release image before running contract_cmd', async () => {
    await failedContract();
    now += 1000;
    const res = await orch.retryContract(envId);
    if (!('operationId' in res)) throw new Error(res.rejected.code);
    const op = await settle(res.operationId);
    expect(op).toMatchObject({ kind: 'contract', status: 'succeeded' });
    expect(agent.steps(op.id)).toEqual(['fetch', 'contract']);
    expect(agent.cmds(op.id, 'fetchImages')[0]).toMatchObject({ storage: STORAGE, env: 'prod', sha: A });
  });
  ```
  - The new-release step lists at :243 and :277 stay unchanged (no `fetch` for a new release).

- [x] **Step 2: run them, watch them fail** — `pnpm test`, expect failures in `state.test.ts` (`dueUnpin is not a function`), `protocol.test.ts` (`accepts unpinImages`), `runtime.test.ts`, `repo.test.ts` (`no such column` / `undefined`), `scheduler.test.ts`, `orchestrator.test.ts` (steps mismatch); then `pnpm test:docker`, expect `unpinImages is not a function` in `storage.docker.test.ts`. The behaviour is missing.
- [x] **Step 3: end-state check (passes on arrival, run again last)** —
  `git diff --name-only main...HEAD | grep -vxF -f <(printf '%s\n' docs/sdd/specs/2026-11-23-unpin-images.md docs/sdd/plans/2026-11-23-unpin-images.md packages/core/src/state.ts packages/core/src/state.test.ts packages/core/src/protocol.ts packages/core/src/protocol.test.ts packages/agent/src/storage.ts packages/agent/src/handler.ts packages/agent/src/runtime.test.ts packages/agent/src/storage.docker.test.ts packages/server/src/db/migrations/005_image_unpinned_at.ts packages/server/src/db/db.ts packages/server/src/db/repo.test.ts packages/server/src/scheduler.ts packages/server/src/scheduler.test.ts packages/server/src/orchestrator.ts packages/server/src/orchestrator.test.ts)`, expect no output (grep exit 1).

---

### Task 1: `dueUnpin`, `unpinKeep`, reset on activate

**Writes:** `packages/core/src/state.ts`
**Reads:** `packages/core/src/state.test.ts`
**Depends on:** Task 0
**Executor:** claude
**Complexity:** routine
**Satisfies:** Task 0 1a (`dueUnpin`, `unpinKeep`, `activation resets imageUnpinnedAt`)
**Interfaces:**
- Produces: `ReleaseFacts.imageUnpinnedAt: number | null`; `export type UnpinFacts = ReleaseFacts & { stored: boolean; images: Record<string, { ref: string }> }`; `export function dueUnpin(rs: UnpinFacts[]): string[]`; `export function unpinKeep(rs: UnpinFacts[], due: string[], id: string): string[]`. `ReleaseRow` (`packages/server/src/db/repo.ts:60`) satisfies `UnpinFacts` structurally.

- [x] **Step 1: run the core tests, watch them fail** — `pnpm vitest run packages/core/src/state.test.ts`, expect `dueUnpin is not a function`.
- [x] **Step 2: implement** in `packages/core/src/state.ts`:
  - in `interface ReleaseFacts` (:4-16) add `imageUnpinnedAt: number | null;` after `imagePurgedAt`;
  - `activate()` (:48-50) returns `{ id: releaseId, patch: { state: 'active', activationSeq: nextSeq(rs), supersededAt: null, imageUnpinnedAt: null } }`;
  - after `dueExpiry` (:104) add:
  ```ts
  export type UnpinFacts = ReleaseFacts & { stored: boolean; images: Record<string, { ref: string }> };

  const newerSuperseded = (a: ReleaseFacts, b: ReleaseFacts) =>
    (b.supersededAt ?? 0) - (a.supersededAt ?? 0) || b.deployedAt - a.deployedAt;

  export function dueUnpin(rs: UnpinFacts[]): string[] {
    const previous = rs.filter((r) => r.state === 'available').sort(newerSuperseded)[0]?.id;
    return rs
      .filter(
        (r) =>
          r.id !== previous &&
          r.stored &&
          r.imagePurgedAt === null &&
          r.imageUnpinnedAt === null &&
          (r.state === 'available' || (r.state === 'blocked' && r.cleanupState !== 'pending')),
      )
      .sort((a, b) => -newerSuperseded(a, b))
      .map((r) => r.id);
  }

  export function unpinKeep(rs: UnpinFacts[], due: string[], id: string): string[] {
    const own = new Set(Object.values(rs.find((r) => r.id === id)?.images ?? {}).map((i) => i.ref));
    const held = new Set(
      rs
        .filter((r) => !due.includes(r.id) && r.imagePurgedAt === null && r.imageUnpinnedAt === null)
        .flatMap((r) => Object.values(r.images).map((i) => i.ref)),
    );
    return [...own].filter((ref) => held.has(ref)).sort();
  }
  ```
- [x] **Step 3: run it, watch it pass** — `pnpm vitest run packages/core/src/state.test.ts`, expect all passed; `pnpm --filter @microrun/core typecheck` exits 0 (if the filter name differs, `pnpm -C packages/core typecheck`).

---

### Task 2: `unpinImages` command in the protocol

**Writes:** `packages/core/src/protocol.ts`
**Reads:** `packages/core/src/protocol.test.ts`
**Depends on:** Task 0
**Executor:** claude
**Complexity:** routine
**Satisfies:** Task 0 1b (`accepts unpinImages`)
**Interfaces:**
- Produces: `Command` member `{ type: 'unpinImages'; env: string; sha: string; images: Record<string,string>; keep: string[] }`; `ResultMap['unpinImages'] = { unpinned: boolean }`; zod entry in `commandSchema`.

- [x] **Step 1: watch it fail** — `pnpm vitest run packages/core/src/protocol.test.ts`, expect `accepts unpinImages` failing.
- [x] **Step 2: implement** in `packages/core/src/protocol.ts`:
  - `Command` union (:44-46): after the `deleteImages` member add `| { type: 'unpinImages'; env: string; sha: string; images: Record<string,string>; keep: string[] }` (move the terminating `;`).
  - `ResultMap` (:58): `storeImages: {}; fetchImages: {}; deleteImages: {}; unpinImages: { unpinned: boolean };`
  - `commandSchema` (:111-113): after the `deleteImages` entry add `z.object({ type: z.literal('unpinImages'), env: z.string(), sha: z.string(), images: stringMap, keep: z.array(z.string()) }),`
  - `PROTOCOL_VERSION` stays `1`.
- [x] **Step 3: watch it pass** — same command, all passed.

---

### Task 3: `image_unpinned_at` column

**Writes:** `packages/server/src/db/migrations/005_image_unpinned_at.ts`, `packages/server/src/db/db.ts`
**Reads:** `packages/server/src/db/migrations/003_compose_env_files.ts`, `packages/server/src/db/repo.test.ts`
**Depends on:** Task 0
**Executor:** claude
**Complexity:** complex
**Satisfies:** Task 0 1e (`stores image_unpinned_at, null by default`)
**Interfaces:**
- Produces: column `releases.image_unpinned_at integer null`, read as `ReleaseRow.imageUnpinnedAt` via the generic mapping in `repo.ts:154-174` (no edit to `repo.ts`).

- [x] **Step 1: watch it fail** — `pnpm vitest run packages/server/src/db/repo.test.ts`, expect the new test failing.
- [x] **Step 2: implement** — create `packages/server/src/db/migrations/005_image_unpinned_at.ts`:
  ```ts
  import type { Knex } from 'knex';

  export async function up(knex: Knex): Promise<void> {
    await knex.raw('alter table releases add column image_unpinned_at integer null');
  }

  export async function down(knex: Knex): Promise<void> {
    await knex.raw('alter table releases drop column image_unpinned_at');
  }
  ```
  In `packages/server/src/db/db.ts` add `import * as imageUnpinnedAt from './migrations/005_image_unpinned_at.ts';` after the `004` import and `'005_image_unpinned_at': imageUnpinnedAt,` after `'004_scale_indexes': scaleIndexes,`.
- [x] **Step 3: watch it pass** — same command, all passed.

---

### Task 6: fetch before reactivation and contract

**Writes:** `packages/server/src/orchestrator.ts`
**Reads:** `packages/server/src/orchestrator.test.ts`
**Depends on:** Task 0
**Executor:** claude
**Complexity:** complex
**Satisfies:** Task 0 1g (reactivation steps, `fetches the stored release image before running contract_cmd`)
**Interfaces:**
- Consumes: existing `fetchImages` command (`protocol.ts:45`), `refs()` (`orchestrator.ts:67`), `this.call(env, opId, step, cmd)` (`orchestrator.ts:103-109`), `stepper(op).step` (`orchestrator.ts:359-381`).
- Produces: private `fetchCmd(env: EnvRow, r: ReleaseRow)` returning the `fetchImages` command; used by rollback, reactivation and contract.

- [x] **Step 1: watch it fail** — `pnpm vitest run packages/server/src/orchestrator.test.ts`, expect the reactivation and contract tests failing on step lists.
- [x] **Step 2: implement** in `packages/server/src/orchestrator.ts`:
  - add a private method next to `storeRelease` (:489):
  ```ts
  private fetchCmd(env: EnvRow, r: ReleaseRow): CommandOf<'fetchImages'> {
    return {
      type: 'fetchImages', storage: this.d.decryptStorage(env), env: env.name, sha: r.commitSha, images: refs(r.images),
      digests: Object.fromEntries(Object.entries(r.images).filter(([, i]) => i.digest).map(([s, i]) => [s, i.digest])),
    };
  }
  ```
  (import `CommandOf` as a type from `@microrun/core/protocol` if not imported yet);
  - `runRollback` `fetch` step (:520-525) becomes `await step('fetch', async () => this.call(env, op.id, 'fetch', this.fetchCmd(env, target)));`
  - in the deploy flow, right after `if (!('plan' in op.stepsDone)) await this.repo.markStepDone(op.id, 'plan', plan);` (:403) and before the `pull` step add:
    `if (plan.reactivate && rel.stored) await step('fetch', async () => this.call(env, op.id, 'fetch', this.fetchCmd(env, rel)));`
  - in `executeContract` (:607-625), inside the existing `try`, before `await step('contract', …)` add:
    `if (rel.stored) await step('fetch', async () => this.call(env, op.id, 'fetch', this.fetchCmd(env, rel)));`
    (inside the `try`, so a storage failure becomes `CONTRACT_FAILED` and the scheduler does not auto-retry it).
- [x] **Step 3: watch it pass** — same command, all passed (including the resume tests at :841-865, whose `fetch` step is replayed from `steps_done`).

---

### Task 4: agent `unpinImages`

**Writes:** `packages/agent/src/storage.ts`, `packages/agent/src/handler.ts`
**Reads:** `packages/agent/src/runtime.test.ts`, `packages/agent/src/storage.docker.test.ts`
**Depends on:** Task 0, Task 2
**Executor:** claude
**Complexity:** routine
**Satisfies:** Task 0 1c (`unpinImages passes env, sha, images and keep`), 1d (`unpinning` block)
**Interfaces:**
- Consumes: `CommandOf<'unpinImages'>` / `ResultMap['unpinImages']` (Task 2).
- Produces: `export function unpinImages(env: string, sha: string, images: Record<string, string>, keep: string[]): Promise<{ unpinned: boolean }>` in `storage.ts`; `Layers.unpinImages` and `case 'unpinImages'` in `handler.ts`.

- [x] **Step 1: watch it fail** — `pnpm vitest run packages/agent/src/runtime.test.ts`, expect the new test failing.
- [x] **Step 2: implement** in `packages/agent/src/storage.ts`, replacing the rmi loop of `deleteImages` (:198-203) with a shared helper (reuse, do not copy):
  ```ts
  async function removeLocal(env: string, sha: string, images: Record<string, string>, keep: string[] = []): Promise<boolean> {
    let removed = true;
    for (const [svc, ref] of Object.entries(images)) {
      for (const target of keep.includes(ref) ? [pinRef(env, sha, svc)] : [pinRef(env, sha, svc), ref]) {
        const r = await docker(['rmi', target]);
        if (r.code === 0 || /no such image/i.test(r.stderr)) continue;
        if (/being used|is using/i.test(r.stderr)) removed = false;
        else throw new Error(r.stderr);
      }
    }
    return removed;
  }

  export function unpinImages(env: string, sha: string, images: Record<string, string>, keep: string[]): Promise<{ unpinned: boolean }> {
    return guarded('unpin', async () => ({ unpinned: await removeLocal(env, sha, images, keep) }));
  }
  ```
  and in `deleteImages` replace the `for (const [svc, ref] …)` block with `await removeLocal(env, sha, images);`.
  In `packages/agent/src/handler.ts`: import `unpinImages` from `./storage.ts` (:11); add `unpinImages: typeof unpinImages;` to `Layers` (:19-32); add `unpinImages` to `defaults` (:34-37); after `case 'deleteImages'` (:155-157) add
  ```ts
      case 'unpinImages':
        return L.unpinImages(cmd.env, cmd.sha, cmd.images, cmd.keep);
  ```
- [x] **Step 3: watch it pass** — `pnpm vitest run packages/agent/src/runtime.test.ts`, all passed; then `pnpm test:docker`, expect `storage.docker.test.ts` all passed (including the existing `deleteImages` tests).

---

### Task 5: scheduler `unpin` step

**Writes:** `packages/server/src/scheduler.ts`
**Reads:** `packages/server/src/scheduler.test.ts`
**Depends on:** Task 0, Task 1, Task 2, Task 3
**Executor:** claude
**Complexity:** complex
**Satisfies:** Task 0 1f (`Scheduler unpin` block)
**Interfaces:**
- Consumes: `dueUnpin`, `unpinKeep` (Task 1, `@microrun/core/state`); `unpinImages` command/result (Task 2); `imageUnpinnedAt` column (Task 3).

- [x] **Step 1: watch it fail** — `pnpm vitest run packages/server/src/scheduler.test.ts`, expect the `Scheduler unpin` tests failing.
- [x] **Step 2: implement** in `packages/server/src/scheduler.ts`:
  - import `dueUnpin, unpinKeep` alongside `dueExpiry` (:1);
  - after `store` (:93-106) add:
  ```ts
  private async unpin(env: EnvRow, now: number): Promise<void> {
    const rs = await this.d.repo.listReleases(env.id);
    const due = dueUnpin(rs);
    for (const id of due) {
      const r = rs.find((x) => x.id === id)!;
      try {
        const { unpinned } = await this.d.agent.call<'unpinImages'>(env.serverId, { opId: `unpin:${r.id}:${now}`, step: 'unpinImages' }, {
          type: 'unpinImages',
          env: env.name,
          sha: r.commitSha,
          images: Object.fromEntries(Object.entries(r.images).map(([svc, i]) => [svc, i.ref])),
          keep: unpinKeep(rs, due, r.id),
        });
        if (unpinned) await this.d.repo.patchReleases([{ id: r.id, patch: { imageUnpinnedAt: now } }]);
        else this.log(`scheduler: env ${env.name}: unpin ${r.commitSha}: in use`);
      } catch (e) {
        this.log(`scheduler: env ${env.name}: unpin ${r.commitSha}: ${message(e)}`);
      }
    }
  }
  ```
  (use the same `this.log` and `message` helpers `purge`/`store` already use);
  - in `tickEnv` (:108-135), after `if (online) await this.store(env);` add `if (online) await this.unpin(env, now);`.
- [x] **Step 3: watch it pass** — `pnpm vitest run packages/server/src/scheduler.test.ts`, all passed; then `pnpm typecheck && pnpm test`, expect exit 0 and `Test Files  <n> passed (<n>)`.

---

## Finish
`pnpm typecheck && pnpm test && pnpm test:docker` green, then Task 0 Step 3 end-state check with no output.
