import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentError, type ComposeRef, type ServiceSpec } from '@microrun/core/protocol';
import { docker } from './docker.ts';
import { OVERRIDE_FILE, composeArgs, composeConfig, hasHealthcheck, writeOverride, type ComposeModel } from './compose.ts';

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

async function imageId(ref: string): Promise<string> {
  return (await must(['image', 'inspect', '--format', '{{.Id}}', ref])).trim();
}

async function containers(c: ComposeRef, service: string): Promise<Container[]> {
  const ids = (await must(['ps', '-q',
    '--filter', `label=com.docker.compose.project=${c.project}`,
    '--filter', `label=com.docker.compose.service=${service}`,
    '--filter', 'label=com.docker.compose.oneoff=False',
  ])).split('\n').filter(Boolean);
  if (ids.length === 0) return [];
  const out = await must(['inspect', '--format', '{{json .}}', ...ids]);
  return out.split('\n').filter(Boolean).map((line) => {
    const x = JSON.parse(line) as { Id: string; Name: string; Image: string; Config?: { Image?: string }; State: { Status: string; Health?: { Status: string } } };
    return { id: x.Id, name: x.Name.replace(/^\//, ''), image: x.Image, ref: x.Config?.Image ?? x.Image, status: x.State.Status, health: x.State.Health?.Status ?? '' };
  }).filter((x) => x.status === 'running');
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
const broken = (x: Container) => x.health === 'unhealthy';

async function waitReady(c: ComposeRef, svc: string, target: string, count: number, exclude: Set<string>, timeoutMs: number): Promise<Container[] | null> {
  const limit = deadline(timeoutMs);
  try {
    for (;;) {
      const fresh = (await containers(c, svc)).filter((x) => x.image === target && !exclude.has(x.id));
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

async function rolling(c: ComposeRef, svc: ServiceSpec, healthTimeoutS: number, proxy: ProxyHook | null,
  images: Record<string, string>, model: () => Promise<ComposeModel>): Promise<boolean> {
  const target = await imageId(svc.image);
  const running = await containers(c, svc.name);
  const old = running.filter((x) => x.image !== target);
  const present = running.filter((x) => x.image === target);
  if (old.length === 0 && present.length > 0) return false;
  const m = await model();
  const n = old.length || (m.services[svc.name]?.deploy?.replicas ?? m.services[svc.name]?.scale ?? 1);
  const oldIds = new Set(old.map((x) => x.id));
  const previous = { ...images };
  images[svc.name] = svc.image;
  await writeOverride(c, images);

  const fail = async (): Promise<never> => {
    const fresh = (await containers(c, svc.name)).filter((x) => !oldIds.has(x.id));
    await removeContainers(fresh.map((x) => x.id));
    for (const k of Object.keys(images)) delete images[k];
    Object.assign(images, previous);
    await writeOverride(c, images);
    throw new AgentError('HEALTHCHECK_FAILED', { svc: svc.name });
  };

  if (present.length < n) {
    const up = await docker(composeArgs(c, ['up', '-d', '--no-deps', '--no-recreate', '--scale', `${svc.name}=${old.length + n}`, svc.name]));
    if (up.code !== 0) return fail();
  }
  const fresh = await waitReady(c, svc.name, target, n, oldIds, healthTimeoutS * 1000);
  if (!fresh) return fail();

  await proxy?.addUpstreams(svc, fresh.map((x) => x.name));
  for (const [i, x] of old.entries()) {
    if (i > 0) await sleep(DNS_DRAIN_MS);
    await docker(['stop', '-t', '30', x.id]);
    await docker(['rm', x.id]);
  }
  await proxy?.removeUpstreams(svc, old.map((x) => x.name));
  return true;
}

async function recreate(c: ComposeRef, svc: ServiceSpec, healthTimeoutS: number,
  images: Record<string, string>, model: () => Promise<ComposeModel>): Promise<boolean> {
  const target = await imageId(svc.image);
  const before = await containers(c, svc.name);
  if (before.length > 0 && before.every((x) => x.image === target && ready(x))) return false;
  const previous = { ...images };
  if (!previous[svc.name] && before[0]) previous[svc.name] = before[0].ref;
  images[svc.name] = svc.image;
  await writeOverride(c, images);
  const withHealth = await hasHealthcheck((await model()).services[svc.name] ?? {}, svc.image);

  const up = await docker(composeArgs(c, ['up', '-d', '--no-deps', svc.name]));
  let ok = up.code === 0;
  if (ok && withHealth) {
    ok = (await waitReady(c, svc.name, target, 1, new Set(), healthTimeoutS * 1000)) !== null;
  } else if (ok) {
    const limit = deadline(10_000);
    while (ok && !limit.expired()) {
      ok = (await containers(c, svc.name)).some((x) => x.image === target);
      if (ok) await sleep(500);
    }
    limit.clear();
  }
  if (ok) return true;

  for (const k of Object.keys(images)) delete images[k];
  Object.assign(images, previous);
  await writeOverride(c, images);
  await docker(composeArgs(c, ['up', '-d', '--no-deps', svc.name]));
  throw new AgentError('HEALTHCHECK_FAILED', { svc: svc.name });
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
