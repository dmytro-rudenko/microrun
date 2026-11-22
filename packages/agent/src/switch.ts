import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentError, type ComposeRef, type ServiceSpec } from '@microrun/core/protocol';
import { docker } from './docker.ts';
import { OVERRIDE_FILE, composeArgs, composeConfig, hasHealthcheck, writeOverride, type ComposeModel } from './compose.ts';

const STDERR_CAP = 2048;
const capped = (s: string) => (s.length > STDERR_CAP ? `…${s.slice(-STDERR_CAP)}` : s);

export interface ProxyHook {
  addUpstreams(svc: ServiceSpec, containers: string[]): Promise<void>;
  removeUpstreams(svc: ServiceSpec, containers: string[]): Promise<void>;
}

interface Container { id: string; name: string; image: string; ref: string; status: string; health: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DNS_DRAIN_MS = 2000;

function deadline(ms: number) {
  let over = false;
  const timer = setTimeout(() => { over = true; }, ms);
  return { expired: () => over, clear: () => clearTimeout(timer) };
}

async function must(args: string[]): Promise<string> {
  const r = await docker(args);
  if (r.code !== 0) throw new Error(`docker ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

async function imageId(ref: string): Promise<string | null> {
  const r = await docker(['image', 'inspect', '--format', '{{.Id}}', ref]);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function containers(c: ComposeRef, service: string, all = false): Promise<Container[]> {
  const ids = (await must(['ps', '-q', ...(all ? ['-a'] : []),
    '--filter', `label=com.docker.compose.project=${c.project}`,
    '--filter', `label=com.docker.compose.service=${service}`,
    '--filter', 'label=com.docker.compose.oneoff=False',
  ])).split('\n').filter(Boolean);
  if (ids.length === 0) return [];
  const out = await must(['inspect', '--format', '{{json .}}', ...ids]);
  return out.split('\n').filter(Boolean).map((line) => {
    const x = JSON.parse(line) as { Id: string; Name: string; Image: string; Config?: { Image?: string }; State: { Status: string; Health?: { Status: string } } };
    return { id: x.Id, name: x.Name.replace(/^\//, ''), image: x.Image, ref: x.Config?.Image ?? x.Image, status: x.State.Status, health: x.State.Health?.Status ?? '' };
  }).filter((x) => all || x.status === 'running');
}

async function readOverride(c: ComposeRef): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(join(c.dir, OVERRIDE_FILE), 'utf8')) as { services?: Record<string, { image?: string }> };
    const images: Record<string, string> = {};
    for (const [svc, s] of Object.entries(parsed.services ?? {})) if (s.image) images[svc] = s.image;
    return images;
  } catch {
    return {};
  }
}

const ready = (x: Container) => x.status === 'running' && (x.health === '' || x.health === 'healthy');
const broken = (x: Container) => x.health === 'unhealthy' || x.status === 'exited' || x.status === 'dead';

async function waitReady(c: ComposeRef, svc: string, target: string, count: number, exclude: Set<string>, timeoutMs: number): Promise<Container[] | null> {
  const limit = deadline(timeoutMs);
  try {
    for (;;) {
      const fresh = (await containers(c, svc, true)).filter((x) => x.image === target && !exclude.has(x.id));
      if (fresh.some(broken)) return null;
      if (fresh.length >= count && fresh.every(ready)) return fresh;
      if (limit.expired()) return null;
      await sleep(500);
    }
  } finally {
    limit.clear();
  }
}

async function removeContainers(ids: string[]): Promise<void> {
  if (ids.length) await docker(['rm', '-f', ...ids]);
}

async function restoreOverride(c: ComposeRef, images: Record<string, string>, previous: Record<string, string>): Promise<void> {
  for (const k of Object.keys(images)) delete images[k];
  Object.assign(images, previous);
  await writeOverride(c, images);
}

const replicasOf = (m: ComposeModel, name: string) => m.services[name]?.deploy?.replicas ?? m.services[name]?.scale ?? 1;

async function stopDrained(old: Container[]): Promise<void> {
  for (const [i, x] of old.entries()) {
    if (i > 0) await sleep(DNS_DRAIN_MS);
    await docker(['stop', '-t', '30', x.id]);
    await docker(['rm', x.id]);
  }
}

const allCurrent = (before: Container[], target: string | null) =>
  !!target && before.length > 0 && before.every((x) => x.image === target && ready(x));

async function stayedRunning(c: ComposeRef, svc: string, target: string): Promise<boolean> {
  const limit = deadline(10_000);
  let ok = true;
  while (ok && !limit.expired()) {
    ok = (await containers(c, svc)).some((x) => x.image === target);
    if (ok) await sleep(500);
  }
  limit.clear();
  return ok;
}

async function cameUp(c: ComposeRef, svc: ServiceSpec, target: string, healthTimeoutS: number, model: () => Promise<ComposeModel>): Promise<boolean> {
  if (await hasHealthcheck((await model()).services[svc.name] ?? {}, svc.image)) {
    return (await waitReady(c, svc.name, target, 1, new Set(), healthTimeoutS * 1000)) !== null;
  }
  return stayedRunning(c, svc.name, target);
}

async function rolling(c: ComposeRef, svc: ServiceSpec, healthTimeoutS: number, proxy: ProxyHook | null,
  images: Record<string, string>, model: () => Promise<ComposeModel>): Promise<boolean> {
  await removeContainers((await containers(c, svc.name, true)).filter((x) => x.status !== 'running').map((x) => x.id));
  let target = await imageId(svc.image);
  const running = await containers(c, svc.name);
  const old = running.filter((x) => x.image !== target);
  const present = running.filter((x) => x.image === target);
  if (old.length === 0 && present.length > 0) return false;
  const m = await model();
  const n = old.length || replicasOf(m, svc.name);
  const oldIds = new Set(old.map((x) => x.id));
  const previous = { ...images };
  images[svc.name] = svc.image;
  await writeOverride(c, images);

  const fail = async (err: AgentError): Promise<never> => {
    await removeContainers((await containers(c, svc.name, true)).filter((x) => !oldIds.has(x.id)).map((x) => x.id));
    await restoreOverride(c, images, previous);
    throw err;
  };

  if (present.length < n) {
    const up = await docker(composeArgs(c, ['up', '-d', '--no-deps', '--no-recreate', '--scale', `${svc.name}=${old.length + n}`, svc.name]));
    if (up.code !== 0) return fail(new AgentError('IMAGE_PULL_FAILED', { svc: svc.name, stderr: capped(up.stderr.trim()) }));
  }
  target ??= await imageId(svc.image);
  const fresh = target ? await waitReady(c, svc.name, target, n, oldIds, healthTimeoutS * 1000) : null;
  if (!fresh) return fail(new AgentError('HEALTHCHECK_FAILED', { svc: svc.name }));

  await proxy?.addUpstreams(svc, fresh.map((x) => x.name));
  await stopDrained(old);
  await proxy?.removeUpstreams(svc, old.map((x) => x.name));
  return true;
}

async function recreate(c: ComposeRef, svc: ServiceSpec, healthTimeoutS: number,
  images: Record<string, string>, model: () => Promise<ComposeModel>): Promise<boolean> {
  let target = await imageId(svc.image);
  const before = await containers(c, svc.name);
  if (allCurrent(before, target)) return false;
  const previous = { ...images };
  if (!previous[svc.name] && before[0]) previous[svc.name] = before[0].ref;
  images[svc.name] = svc.image;
  await writeOverride(c, images);

  const rollback = async (err: AgentError): Promise<never> => {
    await restoreOverride(c, images, previous);
    const r = await docker(composeArgs(c, ['up', '-d', '--no-deps', svc.name]));
    if (r.code !== 0) err.params.rollbackStderr = capped(r.stderr.trim());
    throw err;
  };

  const up = await docker(composeArgs(c, ['up', '-d', '--no-deps', svc.name]));
  if (up.code !== 0) return rollback(new AgentError('IMAGE_PULL_FAILED', { svc: svc.name, stderr: capped(up.stderr.trim()) }));
  target ??= await imageId(svc.image);
  if (target !== null && (await cameUp(c, svc, target, healthTimeoutS, model))) return true;
  return rollback(new AgentError('HEALTHCHECK_FAILED', { svc: svc.name }));
}

export async function switchServices(c: ComposeRef, services: ServiceSpec[], healthTimeoutS: number, proxy: ProxyHook | null): Promise<{ replaced: string[] }> {
  const images = await readOverride(c);
  let cached: ComposeModel | null = null;
  const model = async () => (cached ??= await composeConfig(c));
  const replaced: string[] = [];
  for (const svc of services) {
    const changed = svc.strategy === 'rolling'
      ? await rolling(c, svc, healthTimeoutS, proxy, images, model)
      : await recreate(c, svc, healthTimeoutS, images, model);
    if (changed) replaced.push(svc.name);
  }
  return { replaced };
}
