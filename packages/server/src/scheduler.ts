import { dueExpiry, lapseCleanup, nextContract } from '@microrun/core/state';
import { AgentError } from '@microrun/core/protocol';
import type { AgentPort, StorageConfig } from '@microrun/core/protocol';
import { BusyError } from './db/repo.ts';
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
      if (r.stored || r.imagePurgedAt !== null) continue;
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

    if (online && env.contractCmd) await this.contract(env, env.contractCmd, now);

    if (online) await this.purge(env, retentionMs, now);

    const lapsed = lapseCleanup(await repo.listReleases(env.id));
    if (lapsed.length) await repo.patchReleases(lapsed.map((id) => ({ id, patch: { cleanupState: 'lapsed' as const } })));

    if (online) await this.store(env);
  }

  private async contract(env: EnvRow, cmd: string, now: number): Promise<void> {
    const { repo } = this.d;
    const rs = await repo.listReleases(env.id);
    const id = nextContract(rs);
    const r = rs.find((x) => x.id === id);
    if (!r) return;
    const ops = await repo.listOperations({ envId: env.id, limit: 1000 });
    const last = ops.find((o) => o.kind === 'contract' && o.toReleaseId === r.id);
    if (last?.status === 'failed') return;
    const image = r.images[env.migrationService]?.ref;
    if (!image) return;
    const op = await repo.createOperation({
      envId: env.id,
      kind: 'contract',
      fromReleaseId: null,
      toReleaseId: r.id,
      actor: 'system',
      status: 'running',
      startedAt: now,
    });
    try {
      const res = await this.d.agent.call<'runCommand'>(env.serverId, { opId: op.id, step: 'contract' }, {
        type: 'runCommand',
        compose: { project: env.composeProject, dir: env.composeDir, files: env.composeFiles },
        service: env.migrationService,
        image,
        cmd,
        args: [],
        env: {},
      });
      if (res.log) await repo.appendLog(op.id, res.log);
      if (res.exitCode !== 0) throw new AgentError('CONTRACT_FAILED', { exitCode: res.exitCode });
      await repo.patchReleases([{ id: r.id, patch: { contractedAt: now } }]);
      await repo.updateOperation(op.id, { status: 'succeeded', finishedAt: now });
    } catch (e) {
      const params = e instanceof AgentError ? e.params : { message: message(e) };
      await repo.appendLog(op.id, `CONTRACT_FAILED ${e instanceof AgentError ? e.code : ''}`.trim());
      await repo.updateOperation(op.id, { status: 'failed', code: 'CONTRACT_FAILED', params, finishedAt: now });
    }
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
              compose: { project: env.composeProject, dir: env.composeDir, files: env.composeFiles },
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
