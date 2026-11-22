import { request } from 'node:http';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceSpec } from '@microrun/core/protocol';
import { docker } from './docker.ts';
import { bundledProxy } from './proxy.ts';

const PROXY = 'microrun-proxy';
const tag = randomBytes(3).toString('hex');
const testNet = `mrt-proxy-${tag}`;
const a = `mrt-proxy-${tag}-a`;
const b = `mrt-proxy-${tag}-b`;
const c = `mrt-proxy-${tag}-c`;
const d = `mrt-proxy-${tag}-d`;
const p1 = `mrt-proxy-${tag}-p1`;
const p2 = `mrt-proxy-${tag}-p2`;
const projectNet = (project: string) => `${PROXY}-${project}`;
const svcP1: ServiceSpec = { name: 'web', strategy: 'rolling', image: 'traefik/whoami:v1.10', domain: 'p1.localhost', port: 80 };
const svcP2: ServiceSpec = { name: 'web', strategy: 'rolling', image: 'traefik/whoami:v1.10', domain: 'p2.localhost', port: 80 };
const svc: ServiceSpec = { name: 'web', strategy: 'rolling', image: 'traefik/whoami:v1.10', domain: 'app.localhost', port: 80 };

async function dk(args: string[]): Promise<string> {
  const r = await docker(args);
  if (r.code !== 0) throw new Error(`docker ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

async function proxyLabel(): Promise<string | null | undefined> {
  const r = await docker(['inspect', '--format', '{{index .Config.Labels "microrun.test"}}', PROXY]);
  if (r.code !== 0) return undefined;
  return r.stdout.trim() || null;
}

const existingLabel = await proxyLabel();
const blocker =
  existingLabel !== undefined && existingLabel !== '1'
    ? `skipping: a container named ${PROXY} already exists without label microrun.test=1; not touching it`
    : null;
if (blocker) console.warn(blocker);
const networkExisted = (await docker(['network', 'inspect', PROXY])).code === 0;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let httpPort = 0;
let httpsPort = 0;
let stateDir = '';
const savedTls = process.env.MICRORUN_PROXY_TLS;

function hit(domain = svc.domain!): Promise<{ status: number; host: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: httpPort, path: '/', method: 'GET', agent: false, headers: { host: domain }, timeout: 5000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, host: /^Hostname: (.+)$/m.exec(body)?.[1]?.trim() ?? '' }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(pred: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (await pred().catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function proxy() {
  return bundledProxy(stateDir, { httpPort, httpsPort, labels: { 'microrun.test': '1' } });
}

async function proxyNetworks(container: string): Promise<string[]> {
  const nets = JSON.parse(await dk(['inspect', '--format', '{{json .NetworkSettings.Networks}}', container])) as Record<string, unknown>;
  return Object.keys(nets).filter((n) => n.startsWith(PROXY)).sort();
}

async function proxyIds(): Promise<string[]> {
  return (await dk(['ps', '-a', '--filter', `name=^${PROXY}$`, '--format', '{{.ID}}'])).split('\n').filter(Boolean);
}

describe.skipIf(blocker !== null)('bundledProxy', () => {
  beforeAll(async () => {
    process.env.MICRORUN_PROXY_TLS = 'off';
    if (existingLabel === '1') await dk(['rm', '-f', PROXY]);
    httpPort = await freePort();
    httpsPort = await freePort();
    stateDir = await mkdtemp(join(tmpdir(), 'mrt-proxy-'));
    await dk(['network', 'create', testNet]);
    for (const [name, project] of [[a, p1], [b, p1], [c, p2], [d, p1]] as const) {
      await dk(['run', '-d', '--name', name, '--hostname', name, '--network', testNet,
        '--label', `com.docker.compose.project=${project}`, 'traefik/whoami:v1.10']);
    }
  });

  afterAll(async () => {
    if (savedTls === undefined) delete process.env.MICRORUN_PROXY_TLS;
    else process.env.MICRORUN_PROXY_TLS = savedTls;
    if ((await proxyLabel()) === '1') await docker(['rm', '-f', PROXY]);
    await docker(['rm', '-f', a, b, c, d]);
    await docker(['network', 'rm', testNet, projectNet(p1), projectNet(p2)]);
    if (!networkExisted) await docker(['network', 'rm', PROXY]);
    if (stateDir) {
      await docker(['run', '--rm', '-v', `${stateDir}:/s`, 'caddy:2.10-alpine', 'rm', '-rf', '/s/caddy']);
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('ensure twice leaves one running microrun-proxy container', async () => {
    const p = proxy();
    await p.ensure();
    const first = await proxyIds();
    await p.ensure();
    const second = await proxyIds();
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect((await dk(['inspect', '--format', '{{.State.Running}}', PROXY])).trim()).toBe('true');
  });

  it('adds a and b, then removes a, under continuous requests with 0 errors', async () => {
    const p = proxy();
    await p.ensure();
    await p.addUpstreams(svc, [a]);
    await waitFor(async () => (await hit()).host === a, 60_000, 'first upstream a');

    const errors: string[] = [];
    const seen: string[] = [];
    let running = true;
    const loop = (async () => {
      while (running) {
        try {
          const r = await hit();
          if (r.status !== 200) errors.push(`status ${r.status}`);
          else seen.push(r.host);
        } catch (e) {
          errors.push(String(e));
        }
        await sleep(20);
      }
    })();

    try {
      await p.addUpstreams(svc, [b]);
      await waitFor(async () => seen.includes(b), 60_000, 'upstream b in rotation');
      expect(p.routes()).toEqual({ [svc.domain!]: [`${a}:80`, `${b}:80`] });

      await p.removeUpstreams(svc, [a]);
      expect(p.routes()).toEqual({ [svc.domain!]: [`${b}:80`] });
      await sleep(1000);
      const mark = seen.length;
      await dk(['stop', '-t', '1', a]);
      await sleep(3000);
      const after = seen.slice(mark);
      expect(after.length).toBeGreaterThan(0);
      expect(new Set(after)).toEqual(new Set([b]));
    } finally {
      running = false;
      await loop;
    }

    expect(errors).toEqual([]);
    expect(bundledProxy(stateDir).routes()).toEqual({ [svc.domain!]: [`${b}:80`] });
  });

  it('connects upstreams only to their own project proxy network, the proxy to each, and keeps routes added concurrently', async () => {
    const p = proxy();
    await p.ensure();
    await Promise.all([p.addUpstreams(svcP1, [d]), p.addUpstreams(svcP2, [c])]);

    expect(await proxyNetworks(d)).toEqual([projectNet(p1)]);
    expect(await proxyNetworks(c)).toEqual([projectNet(p2)]);
    expect(await proxyNetworks(b)).toEqual([projectNet(p1)]);
    expect(await proxyNetworks(PROXY)).toEqual(expect.arrayContaining([projectNet(p1), projectNet(p2)]));

    const expected = { [svc.domain!]: [`${b}:80`], [svcP1.domain!]: [`${d}:80`], [svcP2.domain!]: [`${c}:80`] };
    expect(p.routes()).toEqual(expected);
    expect(bundledProxy(stateDir).routes()).toEqual(expected);
    await waitFor(async () => (await hit(svcP1.domain)).host === d, 60_000, 'p1 upstream d');
    await waitFor(async () => (await hit(svcP2.domain)).host === c, 60_000, 'p2 upstream c');
  });
});
