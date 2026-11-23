import { dueExpiry, dueUnpin, lapseCleanup, nextContract, unpinKeep } from '@microrun/core/state';
import { AgentError } from '@microrun/core/protocol';
import type { AgentPort, StorageConfig } from '@microrun/core/protocol';
import { BusyError, composeRefOf } from './db/repo.ts';
import type { EnvRow, ReleaseRow, Repo } from './db/repo.ts';

function message(e: unknown): string {
  return e instanceof AgentError ? e.code : e instanceof Error ? e.message : String(e);
}

export type MarkerWarning = { svc: string; other: string; url?: string };

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private lastMarkerAt: number | null = null;
  private readonly warnings = new Map<string, MarkerWarning[]>();

  constructor(
    private readonly d: {
      repo: Repo;
      agent: AgentPort;
      clock: () => number;
      decryptStorage: (env: EnvRow) => StorageConfig;
      runContract: (releaseId: string) => Promise<void>;
      intervalMs?: number;
      markerEveryMs?: number;
      log?: (line: string) => void;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.d.intervalMs ?? 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private log(line: string): void {
    this.d.log?.(line);
  }

  markerWarnings(): Map<string, MarkerWarning[]> {
    return this.warnings;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.d.clock();
      const envs = await this.d.repo.listEnvs();
      const busy = new Set((await this.d.repo.activeOperations()).map((o) => o.envId));
      for (const env of envs) {
        if (busy.has(env.id)) continue;
        try {
          await this.tickEnv(env, now);
        } catch (e) {
          if (!(e instanceof BusyError)) this.log(`scheduler: env ${env.name}: ${message(e)}`);
        }
      }
      if (this.lastMarkerAt === null || now - this.lastMarkerAt >= (this.d.markerEveryMs ?? 300_000)) {
        this.lastMarkerAt = now;
        for (const env of envs) await this.readMarkers(env, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async purge(env: EnvRow, retentionMs: number, now: number): Promise<void> {
    const rs = await this.d.repo.listReleases(env.id);
    const due = new Set(dueExpiry(rs, retentionMs, now).purge);
    for (const r of rs) {
      if (!due.has(r.id)) continue;
      if (r.state === 'expired' && env.contractCmd && r.contractedAt === null) continue;
      try {
        await this.d.agent.call<'deleteImages'>(env.serverId, { opId: `purge:${r.id}`, step: 'deleteImages' }, {
          type: 'deleteImages',
          ...this.imagesArgs(env, r),
        });
        await this.d.repo.patchReleases([{ id: r.id, patch: { imagePurgedAt: now } }]);
      } catch (e) {
        this.log(`scheduler: env ${env.name}: purge ${r.commitSha}: ${message(e)}`);
      }
    }
  }

  private async store(env: EnvRow): Promise<void> {
    for (const r of await this.d.repo.listReleases(env.id)) {
      if (r.stored || r.imagePurgedAt !== null || (r.state !== 'active' && r.state !== 'available')) continue;
      try {
        await this.d.agent.call<'storeImages'>(env.serverId, { opId: `store:${r.id}`, step: 'storeImages' }, {
          type: 'storeImages',
          ...this.imagesArgs(env, r),
        });
        await this.d.repo.patchReleases([{ id: r.id, patch: { stored: true } }]);
      } catch (e) {
        this.log(`scheduler: env ${env.name}: store ${r.commitSha}: ${message(e)}`);
      }
    }
  }

  private async unpin(env: EnvRow, now: number): Promise<void> {
    const rs = await this.d.repo.listReleases(env.id);
    const due = dueUnpin(rs);
    for (const id of due) {
      const r = rs.find((x) => x.id === id)!;
      if ((await this.d.repo.activeOperations()).some((o) => o.envId === env.id)) return;
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

  private async tickEnv(env: EnvRow, now: number): Promise<void> {
    const { repo } = this.d;
    const online = this.d.agent.isOnline(env.serverId);
    const retentionMs = env.retentionS * 1000;

    for (const id of dueExpiry(await repo.listReleases(env.id), retentionMs, now).expire) {
      const op = await repo.createOperation({
        envId: env.id,
        kind: 'expire',
        fromReleaseId: null,
        toReleaseId: id,
        actor: 'system',
        status: 'running',
        startedAt: now,
      });
      await repo.patchReleases([{ id, patch: { state: 'expired' } }]);
      await repo.updateOperation(op.id, { status: 'succeeded', finishedAt: now });
    }

    if (online && env.contractCmd) await this.contract(env);

    if (online) await this.purge(env, retentionMs, now);

    const lapsed = lapseCleanup(await repo.listReleases(env.id));
    if (lapsed.length) await repo.patchReleases(lapsed.map((id) => ({ id, patch: { cleanupState: 'lapsed' as const } })));

    if (online) await this.store(env);
    if (online) await this.unpin(env, now);
  }

  private async contract(env: EnvRow): Promise<void> {
    const { repo } = this.d;
    const id = nextContract(await repo.listReleases(env.id));
    if (!id) return;
    const ops = await repo.listOperations({ envId: env.id, limit: 1000 });
    const last = ops.find((o) => o.kind === 'contract' && o.toReleaseId === id);
    if (last?.status === 'failed') return;
    await this.d.runContract(id);
  }

  private imagesArgs(env: EnvRow, r: ReleaseRow) {
    return {
      storage: this.d.decryptStorage(env),
      env: env.name,
      sha: r.commitSha,
      images: Object.fromEntries(Object.entries(r.images).map(([svc, i]) => [svc, i.ref])),
    };
  }

  private async readMarkers(env: EnvRow, now: number): Promise<void> {
    if (!this.d.agent.isOnline(env.serverId)) return;
    const found: MarkerWarning[] = [];
    for (const svc of env.services) {
      try {
        const res = await this.d.agent.call<'readMarker'>(
          env.serverId,
          { opId: `marker:${env.id}:${now}`, step: svc.name },
          {
            type: 'readMarker',
            db: {
              compose: composeRefOf(env),
              service: env.migrationService,
              dbKind: env.dbKind,
              dbUrlEnv: env.dbUrlEnv,
            },
            viaService: svc.name,
          },
        );
        for (const m of res.markers) {
          if (m.marker && m.marker.envId !== env.dbMarkerId) found.push({ svc: m.service, other: m.marker.envName });
        }
      } catch (e) {
        this.log(`scheduler: env ${env.name}: marker ${svc.name}: ${message(e)}`);
      }
    }
    this.warnings.set(env.id, found);
  }
}
