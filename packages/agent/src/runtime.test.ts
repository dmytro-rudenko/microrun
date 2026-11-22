import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { AgentError, PROTOCOL_VERSION, wsAgentToServer, type Command, type ComposeRef, type DbRef, type ServiceSpec } from '@microrun/core/protocol';
import { AGENT_VERSION, createHandler } from './handler.ts';
import { runAgent } from './runtime.ts';

type DockerResult = { code: number; stdout: string; stderr: string; timedOut: boolean };
type Image = { Id: string; RepoDigests: string[] };

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, 'bin.ts');
const ROOT = resolve(HERE, '../../..');

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'microrun-runtime-'));
  tmpDirs.push(d);
  return d;
}

const ok = (stdout = ''): DockerResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const fail = (stderr: string): DockerResult => ({ code: 1, stdout: '', stderr, timedOut: false });

function render(format: string, img: Image): string | null {
  let missing = false;
  const out = format.replace(/\{\{\s*(.+?)\s*\}\}/g, (_, expr: string) => {
    if (expr === '.Id' || expr === '.ID') return img.Id;
    if (expr === 'json .RepoDigests') return JSON.stringify(img.RepoDigests);
    if (expr === 'json .') return JSON.stringify(img);
    if (/^index \.RepoDigests 0$/.test(expr)) {
      if (img.RepoDigests.length === 0) { missing = true; return ''; }
      return img.RepoDigests[0]!;
    }
    return '';
  });
  return missing ? null : out;
}

function fakeDocker(o: { compose?: string; local?: Record<string, Image>; registry?: Record<string, Image> } = {}) {
  const calls: string[][] = [];
  const local: Record<string, Image> = { ...o.local };
  const run = async (args: string[]): Promise<DockerResult> => {
    calls.push(args);
    if (args[0] === 'compose' && args.includes('version')) return ok(`${o.compose ?? '2.30.0'}\n`);
    if (args[0] === 'pull') {
      const ref = args[args.length - 1]!;
      const img = o.registry?.[ref];
      if (!img) return fail(`pull access denied for ${ref}`);
      local[ref] = img;
      return ok();
    }
    if (args.includes('inspect')) {
      const ref = args[args.length - 1]!;
      const img = local[ref];
      if (!img) return fail(`Error: No such image: ${ref}`);
      const f = args.indexOf('--format') >= 0 ? args[args.indexOf('--format') + 1] : args.find((a) => a.startsWith('--format='))?.slice(9);
      if (f === undefined) return ok(JSON.stringify([img]));
      const text = render(f, img);
      return text === null ? fail('template: :1:2: executing "" at <index .RepoDigests 0>: error calling index: index out of range: 0') : ok(`${text}\n`);
    }
    return ok();
  };
  return { run, calls, pulls: () => calls.filter((a) => a[0] === 'pull'), composeChecks: () => calls.filter((a) => a[0] === 'compose' && a.includes('version')) };
}

const compose = (dir = '/srv/app'): ComposeRef => ({ project: 'app', dir, files: ['docker-compose.yml'] });
const dbRef = (dir = '/srv/app'): DbRef => ({ compose: compose(dir), service: 'api', dbKind: 'postgres', dbUrlEnv: 'DATABASE_URL' });
const key = (step = 'inspect', opId = 'op-1') => ({ opId, step });
const inspectCmd = (dir?: string): Command => ({ type: 'inspectEnv', compose: compose(dir), dbUrlEnv: 'DATABASE_URL' });
const envResult = { services: [{ name: 'api', image: 'registry/api:1', replicas: 1, hasHealthcheck: true, containerName: null, hostPorts: [], hasDbUrl: true }] };

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('createHandler idempotency cache', () => {
  it('runs the layer once for the same opId:step and serves the cached result', async () => {
    const stateDir = tmp();
    let calls = 0;
    const handler = createHandler({ stateDir, docker: fakeDocker().run, layers: { inspectEnv: async () => { calls++; return envResult; } } });
    const first = await handler(key(), inspectCmd());
    const second = await handler(key(), inspectCmd());
    expect(calls).toBe(1);
    expect(first).toEqual(envResult);
    expect(second).toEqual(envResult);
  });

  it('keeps the cache in <stateDir>/results.json across handler instances', async () => {
    const stateDir = tmp();
    let calls = 0;
    const layers = { inspectEnv: async () => { calls++; return envResult; } };
    await createHandler({ stateDir, docker: fakeDocker().run, layers })(key(), inspectCmd());
    expect(existsSync(join(stateDir, 'results.json'))).toBe(true);
    const again = await createHandler({ stateDir, docker: fakeDocker().run, layers })(key(), inspectCmd());
    expect(calls).toBe(1);
    expect(again).toEqual(envResult);
  });

  it('does not cache an error', async () => {
    const stateDir = tmp();
    let calls = 0;
    const handler = createHandler({
      stateDir,
      docker: fakeDocker().run,
      layers: {
        inspectEnv: async () => {
          calls++;
          if (calls === 1) throw new AgentError('INVALID_REQUEST', { reason: 'boom' });
          return envResult;
        },
      },
    });
    await expect(handler(key(), inspectCmd())).rejects.toMatchObject({ code: 'INVALID_REQUEST', params: { reason: 'boom' } });
    await expect(handler(key(), inspectCmd())).resolves.toEqual(envResult);
    expect(calls).toBe(2);
  });
});

describe('createHandler command mapping', () => {
  it('readMarker reads the marker through viaService, defaulting to db.service', async () => {
    const stateDir = tmp();
    const handler = createHandler({
      stateDir,
      docker: fakeDocker().run,
      layers: { readMarkers: async (_db: DbRef, services: string[]) => services.map((service) => ({ service, marker: { envId: 'e1', envName: 'staging' } })) },
    });
    await expect(handler(key('m1'), { type: 'readMarker', db: dbRef(), viaService: 'worker' }))
      .resolves.toEqual({ markers: [{ service: 'worker', marker: { envId: 'e1', envName: 'staging' } }] });
    await expect(handler(key('m2'), { type: 'readMarker', db: dbRef() }))
      .resolves.toEqual({ markers: [{ service: 'api', marker: { envId: 'e1', envName: 'staging' } }] });
  });

  it('storeImages also pins the images', async () => {
    const stateDir = tmp();
    const events: string[] = [];
    const images = { api: 'registry/api:1' };
    const handler = createHandler({
      stateDir,
      docker: fakeDocker().run,
      layers: {
        storeImages: async (_s: unknown, env: string, sha: string) => { events.push(`store:${env}:${sha}`); },
        pinImages: async (env: string, sha: string, imgs: Record<string, string>) => { events.push(`pin:${env}:${sha}:${imgs.api}`); },
      },
    });
    await expect(handler(key('store'), { type: 'storeImages', storage: { kind: 'local', path: '/var/microrun' }, env: 'prod', sha: 'abc1234', images }))
      .resolves.toEqual({});
    expect(events).toContain('store:prod:abc1234');
    expect(events).toContain('pin:prod:abc1234:registry/api:1');
  });

  it('switchServices gets the ensured bundled proxy in bundled mode and none in external mode', async () => {
    const stateDir = tmp();
    const events: string[] = [];
    const proxy = {
      ensure: async () => { events.push('ensure'); },
      addUpstreams: async () => {},
      removeUpstreams: async () => {},
      routes: () => ({}),
    };
    const handler = createHandler({
      stateDir,
      docker: fakeDocker().run,
      layers: {
        bundledProxy: (dir: string) => { events.push(`proxy:${dir}`); return proxy; },
        switchServices: async (_c: ComposeRef, services: ServiceSpec[], _t: number, p: unknown) => {
          events.push(p === proxy ? 'switch:bundled' : p === null ? 'switch:none' : 'switch:other');
          return { replaced: services.map((s) => s.name) };
        },
      },
    });
    const services: ServiceSpec[] = [{ name: 'api', strategy: 'rolling', image: 'registry/api:2', domain: 'api.example.com', port: 8080 }];
    await expect(handler(key('sw1'), { type: 'switchServices', compose: compose(), services, healthTimeoutS: 60, proxyMode: 'bundled' }))
      .resolves.toEqual({ replaced: ['api'] });
    expect(events).toEqual([`proxy:${stateDir}`, 'ensure', 'switch:bundled']);
    events.length = 0;
    await handler(key('sw2'), { type: 'switchServices', compose: compose(), services, healthTimeoutS: 60, proxyMode: 'external' });
    expect(events).toEqual(['switch:none']);
  });
});

describe('createHandler pullImages', () => {
  it('returns the image ID for a local image without RepoDigests and does not pull it', async () => {
    const d = fakeDocker({ local: { 'web:dev': { Id: 'sha256:1111', RepoDigests: [] } } });
    const handler = createHandler({ stateDir: tmp(), docker: d.run });
    await expect(handler(key('pull'), { type: 'pullImages', refs: ['web:dev'] }))
      .resolves.toEqual({ digests: { 'web:dev': 'sha256:1111' } });
    expect(d.pulls()).toEqual([]);
  });

  it('pulls a missing image, then returns its repo digest', async () => {
    const d = fakeDocker({ registry: { 'registry/api:2': { Id: 'sha256:2222', RepoDigests: ['registry/api@sha256:beef'] } } });
    const handler = createHandler({ stateDir: tmp(), docker: d.run });
    await expect(handler(key('pull'), { type: 'pullImages', refs: ['registry/api:2'] }))
      .resolves.toEqual({ digests: { 'registry/api:2': 'registry/api@sha256:beef' } });
    expect(d.pulls()).toHaveLength(1);
    expect(d.pulls()[0]).toContain('registry/api:2');
  });
});

describe('createHandler compose version gate', () => {
  it('rejects compose commands and warns in ping when compose is below 2.30.0', async () => {
    const d = fakeDocker({ compose: '2.29.7' });
    let calls = 0;
    const handler = createHandler({
      stateDir: tmp(),
      docker: d.run,
      layers: {
        inspectEnv: async () => { calls++; return envResult; },
        runOneOff: async () => { calls++; return { exitCode: 0, stdout: '', log: '' }; },
        deleteImages: async () => {},
      },
    });
    await expect(handler(key('i'), inspectCmd())).rejects.toMatchObject({ code: 'INVALID_REQUEST', params: { reason: 'compose<2.30' } });
    await expect(handler(key('r'), { type: 'runCommand', compose: compose(), service: 'api', image: 'registry/api:1', cmd: 'migrate', args: [], env: {} }))
      .rejects.toBeInstanceOf(AgentError);
    expect(calls).toBe(0);
    const ping = await handler(key('p'), { type: 'ping' }) as { agentVersion: string; warning?: string };
    expect(ping.agentVersion).toBe(AGENT_VERSION);
    expect(ping.warning).toContain('2.30');
    await expect(handler(key('del'), { type: 'deleteImages', storage: { kind: 'local', path: '/var/microrun' }, env: 'prod', sha: 'abc1234', images: {} }))
      .resolves.toEqual({});
    expect(d.composeChecks()).toHaveLength(1);
  });

  it('runs compose commands and pings without a warning on compose 2.30.0', async () => {
    const d = fakeDocker({ compose: '2.30.0' });
    const handler = createHandler({ stateDir: tmp(), docker: d.run, layers: { inspectEnv: async () => envResult } });
    await expect(handler(key('i1'), inspectCmd())).resolves.toEqual(envResult);
    await expect(handler(key('i2'), inspectCmd())).resolves.toEqual(envResult);
    const ping = await handler(key('p'), { type: 'ping' }) as { agentVersion: string; warning?: string };
    expect(ping).toEqual({ agentVersion: AGENT_VERSION });
    expect(d.composeChecks()).toHaveLength(1);
  });
});

describe('createHandler stale temp sweep', () => {
  it('removes .microrun-env-* and .microrun-run-*.yml only in compose dirs recorded in dirs.json', async () => {
    const stateDir = tmp();
    const seen = tmp();
    const unseen = tmp();
    await createHandler({ stateDir, docker: fakeDocker().run, layers: { inspectEnv: async () => envResult } })(key(), inspectCmd(seen));
    expect(readFileSync(join(stateDir, 'dirs.json'), 'utf8')).toContain(JSON.stringify(seen).slice(1, -1));

    for (const f of ['.microrun-env-abc', '.microrun-run-abc.yml', 'docker-compose.yml']) writeFileSync(join(seen, f), 'x');
    writeFileSync(join(unseen, '.microrun-env-zzz'), 'x');

    createHandler({ stateDir, docker: fakeDocker().run });
    await vi.waitFor(() => {
      expect(existsSync(join(seen, '.microrun-env-abc'))).toBe(false);
      expect(existsSync(join(seen, '.microrun-run-abc.yml'))).toBe(false);
    });
    expect(existsSync(join(seen, 'docker-compose.yml'))).toBe(true);
    expect(existsSync(join(unseen, '.microrun-env-zzz'))).toBe(true);
  });
});

class Inbox<T> {
  private items: T[] = [];
  private waiters: ((v: T) => void)[] = [];
  push(v: T) {
    const w = this.waiters.shift();
    if (w) w(v); else this.items.push(v);
  }
  next(): Promise<T> {
    if (this.items.length) return Promise.resolve(this.items.shift()!);
    return new Promise((r) => this.waiters.push(r));
  }
}

type Conn = { ws: WebSocket; url: string; auth: string | undefined; messages: Inbox<any> };

async function server() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const conns = new Inbox<Conn>();
  let count = 0;
  wss.on('connection', (ws, req) => {
    count++;
    const messages = new Inbox<any>();
    ws.on('message', (data) => messages.push(wsAgentToServer.parse(JSON.parse(data.toString()))));
    conns.push({ ws, url: req.url ?? '', auth: req.headers.authorization, messages });
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    next: () => conns.next(),
    count: () => count,
    close: () => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }),
  };
}

describe('runAgent', () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const f of cleanup.splice(0).reverse()) await f();
  });

  async function start(handler: (key: { opId: string; step: string }, cmd: Command) => Promise<unknown>, exit: (code: number) => void = () => {}) {
    const srv = await server();
    cleanup.push(srv.close);
    const agent = runAgent({ url: srv.url, token: 'agent-tok', stateDir: tmp(), version: '9.9.9', handler, docker: fakeDocker().run, exit });
    cleanup.push(() => agent.stop());
    return { srv, agent };
  }

  it('connects to /api/v1/agent with the bearer token and sends hello', async () => {
    const { srv } = await start(async () => ({}));
    const c = await srv.next();
    expect(c.url).toBe('/api/v1/agent');
    expect(c.auth).toBe('Bearer agent-tok');
    await expect(c.messages.next()).resolves.toEqual({ t: 'hello', protocolVersion: PROTOCOL_VERSION, agentVersion: '9.9.9' });
  });

  it('answers req with res, for results and AgentErrors', async () => {
    const seen: { key: unknown; cmd: unknown }[] = [];
    const { srv } = await start(async (k, cmd) => {
      seen.push({ key: k, cmd });
      if (cmd.type === 'pullImages') throw new AgentError('INVALID_REQUEST', { reason: 'bad ref' });
      return { agentVersion: '9.9.9' };
    });
    const c = await srv.next();
    await c.messages.next();
    c.ws.send(JSON.stringify({ t: 'req', id: 'r1', key: { opId: 'op-1', step: 'ping' }, cmd: { type: 'ping' } }));
    await expect(c.messages.next()).resolves.toEqual({ t: 'res', id: 'r1', ok: true, result: { agentVersion: '9.9.9' } });
    expect(seen[0]).toEqual({ key: { opId: 'op-1', step: 'ping' }, cmd: { type: 'ping' } });
    c.ws.send(JSON.stringify({ t: 'req', id: 'r2', key: { opId: 'op-1', step: 'pull' }, cmd: { type: 'pullImages', refs: ['x'] } }));
    await expect(c.messages.next()).resolves.toMatchObject({ t: 'res', id: 'r2', ok: false, code: 'INVALID_REQUEST', params: { reason: 'bad ref' } });
  });

  it('answers ping with pong and runs requests concurrently', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { srv } = await start(async (k) => {
      if (k.step === 'slow') await gate;
      return { step: k.step };
    });
    const c = await srv.next();
    await c.messages.next();
    c.ws.send(JSON.stringify({ t: 'req', id: 'slow', key: { opId: 'op-1', step: 'slow' }, cmd: { type: 'ping' } }));
    c.ws.send(JSON.stringify({ t: 'ping' }));
    c.ws.send(JSON.stringify({ t: 'req', id: 'fast', key: { opId: 'op-1', step: 'fast' }, cmd: { type: 'ping' } }));
    const got = [await c.messages.next(), await c.messages.next()];
    expect(got).toContainEqual({ t: 'pong' });
    expect(got).toContainEqual({ t: 'res', id: 'fast', ok: true, result: { step: 'fast' } });
    release();
    await expect(c.messages.next()).resolves.toEqual({ t: 'res', id: 'slow', ok: true, result: { step: 'slow' } });
  });

  it('reconnects and says hello again after the server drops the connection', async () => {
    const { srv } = await start(async () => ({}));
    const first = await srv.next();
    await first.messages.next();
    first.ws.terminate();
    const second = await srv.next();
    await expect(second.messages.next()).resolves.toMatchObject({ t: 'hello' });
    expect(second.auth).toBe('Bearer agent-tok');
  }, 10_000);

  it('stops with exit code 2 on bye PROTOCOL_MISMATCH and does not reconnect', async () => {
    let exited!: (code: number) => void;
    const exitCode = new Promise<number>((r) => { exited = r; });
    const { srv } = await start(async () => ({}), (code) => exited(code));
    const c = await srv.next();
    await c.messages.next();
    c.ws.send(JSON.stringify({ t: 'bye', code: 'PROTOCOL_MISMATCH' }));
    c.ws.close();
    await expect(exitCode).resolves.toBe(2);
    await new Promise((r) => setTimeout(r, 1500));
    expect(srv.count()).toBe(1);
  }, 10_000);
});

describe('microrun bin', () => {
  const bin = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--import', 'tsx', BIN, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });

  it('agent install-service prints a systemd unit that restarts always', () => {
    const r = bin(['agent', 'install-service'], { MICRORUN_URL: 'https://microrun.example.com' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Restart=always');
    expect(r.stdout).toContain('Environment=MICRORUN_URL=https://microrun.example.com');
    expect(r.stdout).toMatch(new RegExp(`ExecStart=${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\S+ agent`));
  }, 20_000);

  it('--version prints AGENT_VERSION', () => {
    const r = bin(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(AGENT_VERSION);
  }, 20_000);
});
