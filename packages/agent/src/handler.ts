import { readFileSync } from 'node:fs';
import { readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AgentError, type Command, type ComposeRef } from '@microrun/core/protocol';
import pkg from '../package.json' with { type: 'json' };
import { docker } from './docker.ts';
import { inspectEnv, runOneOff } from './compose.ts';
import { switchServices, type ProxyHook } from './switch.ts';
import { dryRunExpand, readMarkers, snapshotSchema, writeMarker } from './db.ts';
import { deleteImages, fetchImages, pinImages, storeImages } from './storage.ts';
import { bundledProxy } from './proxy.ts';

export const AGENT_VERSION: string = pkg.version;

export type DockerRun = typeof docker;
export type Handler = (key: { opId: string; step: string }, cmd: Command) => Promise<unknown>;

export interface Layers {
  inspectEnv: typeof inspectEnv;
  readMarkers: typeof readMarkers;
  writeMarker: typeof writeMarker;
  snapshotSchema: typeof snapshotSchema;
  dryRunExpand: typeof dryRunExpand;
  runOneOff: typeof runOneOff;
  switchServices: typeof switchServices;
  storeImages: typeof storeImages;
  fetchImages: typeof fetchImages;
  deleteImages: typeof deleteImages;
  pinImages: typeof pinImages;
  bundledProxy: (stateDir: string) => ProxyHook & { ensure(): Promise<void> };
}

const defaults: Layers = {
  inspectEnv, readMarkers, writeMarker, snapshotSchema, dryRunExpand, runOneOff,
  switchServices, storeImages, fetchImages, deleteImages, pinImages, bundledProxy,
};

const CACHE_MAX = 1000;
const MIN_COMPOSE = [2, 30, 0];
const COMPOSE_WARNING = 'compose<2.30';
const STALE = /^\.microrun-(env-.+|run-.+\.yml)$/;

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function writeAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

function serial() {
  let chain: Promise<unknown> = Promise.resolve();
  return (task: () => Promise<void>): Promise<void> => {
    const next = chain.then(task, task);
    chain = next.catch(() => {});
    return next;
  };
}

async function composeWarning(run: DockerRun): Promise<string | null> {
  try {
    const r = await run(['compose', 'version', '--short']);
    if (r.code !== 0) return COMPOSE_WARNING;
    const parts = r.stdout.trim().replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10));
    for (let i = 0; i < MIN_COMPOSE.length; i++) {
      const v = parts[i] ?? 0;
      if (Number.isNaN(v)) return COMPOSE_WARNING;
      if (v !== MIN_COMPOSE[i]) return v > MIN_COMPOSE[i]! ? null : COMPOSE_WARNING;
    }
    return null;
  } catch {
    return COMPOSE_WARNING;
  }
}

async function sweep(dirs: string[]): Promise<void> {
  await Promise.all(dirs.map(async (dir) => {
    const names = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(names.filter((n) => STALE.test(n)).map((n) => unlink(join(dir, n)).catch(() => {})));
  }));
}

function composeOf(cmd: Command): ComposeRef | null {
  switch (cmd.type) {
    case 'inspectEnv': case 'runCommand': case 'switchServices': return cmd.compose;
    case 'readMarker': case 'writeMarker': case 'snapshotSchema': case 'dryRunExpand': return cmd.db.compose;
    default: return null;
  }
}

async function pullImages(run: DockerRun, refs: string[]): Promise<Record<string, string>> {
  const inspect = async (ref: string) => {
    const r = await run(['image', 'inspect', '--format', '{{json .RepoDigests}} {{.Id}}', ref]);
    if (r.code !== 0) return null;
    const line = r.stdout.trim();
    const cut = line.lastIndexOf(' ');
    const digests = JSON.parse(line.slice(0, cut)) as string[] | null;
    return digests?.[0] ?? line.slice(cut + 1);
  };
  const out: Record<string, string> = {};
  for (const ref of refs) {
    let digest = await inspect(ref);
    if (digest === null) {
      const p = await run(['pull', ref]);
      if (p.code !== 0) throw new AgentError('IMAGE_PULL_FAILED', { image: ref });
      digest = await inspect(ref);
      if (digest === null) throw new AgentError('IMAGE_PULL_FAILED', { image: ref });
    }
    out[ref] = digest;
  }
  return out;
}

export function createHandler(d: { stateDir: string; docker?: DockerRun; layers?: Partial<Layers> }): Handler {
  const L: Layers = { ...defaults, ...d.layers };
  const run = d.docker ?? docker;
  const resultsFile = join(d.stateDir, 'results.json');
  const dirsFile = join(d.stateDir, 'dirs.json');
  const cache = new Map<string, unknown>(readJson<[string, unknown][]>(resultsFile, []));
  const dirs = new Set<string>(readJson<string[]>(dirsFile, []));
  const inflight = new Map<string, Promise<unknown>>();
  const saveResults = serial();
  const saveDirs = serial();
  const warning = composeWarning(run);
  const ready = Promise.all([warning, sweep([...dirs]).catch(() => {})]);

  async function dispatch(cmd: Command): Promise<unknown> {
    switch (cmd.type) {
      case 'ping': {
        const w = await warning;
        return w ? { agentVersion: AGENT_VERSION, warning: w } : { agentVersion: AGENT_VERSION };
      }
      case 'inspectEnv': return L.inspectEnv(cmd.compose, cmd.dbUrlEnv);
      case 'readMarker': return { markers: await L.readMarkers(cmd.db, [cmd.viaService ?? cmd.db.service]) };
      case 'writeMarker':
        await L.writeMarker(cmd.db, cmd.envId, cmd.envName);
        return { envId: cmd.envId };
      case 'pullImages': return { digests: await pullImages(run, cmd.refs) };
      case 'snapshotSchema': return { snapshot: await L.snapshotSchema(cmd.db) };
      case 'dryRunExpand':
        return L.dryRunExpand(cmd.db, { image: cmd.image, cmd: cmd.cmd, migrationTables: cmd.migrationTables, opId: cmd.opId, env: cmd.env });
      case 'runCommand':
        return L.runOneOff(cmd.compose, { service: cmd.service, image: cmd.image, cmd: cmd.cmd, args: cmd.args, env: cmd.env });
      case 'switchServices': {
        let proxy: ProxyHook | null = null;
        if (cmd.proxyMode === 'bundled') {
          const p = L.bundledProxy(d.stateDir);
          await p.ensure();
          proxy = p;
        }
        return L.switchServices(cmd.compose, cmd.services, cmd.healthTimeoutS, proxy);
      }
      case 'storeImages':
        await L.storeImages(cmd.storage, cmd.env, cmd.sha, cmd.images);
        await L.pinImages(cmd.env, cmd.sha, cmd.images);
        return {};
      case 'fetchImages':
        await L.fetchImages(cmd.storage, cmd.env, cmd.sha, cmd.images);
        return {};
      case 'deleteImages':
        await L.deleteImages(cmd.storage, cmd.env, cmd.sha, cmd.images);
        return {};
    }
  }

  async function perform(id: string, cmd: Command): Promise<unknown> {
    await ready;
    const compose = composeOf(cmd);
    if (compose) {
      if (await warning) throw new AgentError('INVALID_REQUEST', { reason: COMPOSE_WARNING });
      if (!dirs.has(compose.dir)) {
        dirs.add(compose.dir);
        await saveDirs(() => writeAtomic(dirsFile, [...dirs]));
      }
    }
    const result = await dispatch(cmd);
    if (cmd.type !== 'ping') {
      cache.delete(id);
      cache.set(id, result);
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
      await saveResults(() => writeAtomic(resultsFile, [...cache]));
    }
    return result;
  }

  return async (key, cmd) => {
    const id = `${key.opId}:${key.step}`;
    if (cmd.type !== 'ping' && cache.has(id)) {
      const hit = cache.get(id);
      cache.delete(id);
      cache.set(id, hit);
      return hit;
    }
    const running = inflight.get(id);
    if (running) return running;
    const p = perform(id, cmd).finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  };
}
