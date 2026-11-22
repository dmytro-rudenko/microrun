import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { StorageConfig } from '@microrun/core/protocol';
import { AGENT_VERSION, createHandler } from 'microrun/handler';
import { buildApp, OpBus } from './app.ts';
import { loadConfig } from './config.ts';
import { decrypt, hashToken, newToken } from './crypto.ts';
import { openDb } from './db/db.ts';
import { Repo, type EnvRow } from './db/repo.ts';
import { Hub } from './hub.ts';
import { Orchestrator } from './orchestrator.ts';
import { Scheduler } from './scheduler.ts';

export async function start(
  env: NodeJS.ProcessEnv,
  opts: { dockerSocket?: string; port?: number } = {},
): Promise<{ app: FastifyInstance; stop(): Promise<void> }> {
  const config = loadConfig(env);
  const clock = () => Date.now();
  mkdirSync(config.dataDir, { recursive: true });
  const db = await openDb(join(config.dataDir, 'microrun.db'));
  const repo = new Repo(db);
  const hub = new Hub({ repo, clock });
  const bus = new OpBus();
  const decryptStorage = (e: EnvRow) => JSON.parse(decrypt(config.secretKey, e.storageConfigEnc)) as StorageConfig;

  if (existsSync(opts.dockerSocket ?? '/var/run/docker.sock')) {
    const local =
      (await repo.listServers()).find((s) => s.builtin) ??
      (await repo.createServer({ name: 'local', agentTokenHash: hashToken(newToken()), builtin: true }));
    await repo.setServerSeen(local.id, clock(), AGENT_VERSION);
    hub.attachLocal(local.id, createHandler({ stateDir: join(config.dataDir, 'agent') }));
  }

  const orchestrator = new Orchestrator({ repo, agent: hub, clock, decryptStorage, emit: (id, ev) => bus.emit(id, ev) });
  const scheduler = new Scheduler({ repo, agent: hub, clock, decryptStorage, log: (l) => console.error(l) });
  const app = await buildApp({ config, repo, hub, orchestrator, scheduler, clock, bus });

  await orchestrator.resumeAll();
  scheduler.start();
  await app.listen({ host: '0.0.0.0', port: opts.port ?? config.port });

  return {
    app,
    async stop() {
      scheduler.stop();
      hub.close();
      await app.close();
      await db.destroy();
    },
  };
}

if (import.meta.main) {
  start(process.env).then(
    (s) => {
      for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => void s.stop().then(() => process.exit(0)));
    },
    (e: Error) => {
      console.error(`microrun: ${e.message}`);
      process.exit(1);
    },
  );
}
