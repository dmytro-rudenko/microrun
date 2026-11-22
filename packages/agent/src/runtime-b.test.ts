import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { AgentError } from '@microrun/core/protocol';
import { runAgent } from './runtime.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, 'bin.ts');
const ROOT = resolve(HERE, '../../..');

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

type Conn = { ws: WebSocket; at: number; messages: Inbox<any> };

async function server() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const conns = new Inbox<Conn>();
  wss.on('connection', (ws) => {
    const messages = new Inbox<any>();
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    conns.push({ ws, at: performance.now(), messages });
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    next: () => conns.next(),
    close: () => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }),
  };
}

const tmpDirs: string[] = [];
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(handler: (key: { opId: string; step: string }, cmd: unknown) => Promise<unknown>) {
  const srv = await server();
  cleanup.push(srv.close);
  const stateDir = mkdtempSync(join(tmpdir(), 'microrun-runtime-b-'));
  tmpDirs.push(stateDir);
  const agent = runAgent({ url: srv.url, token: 'agent-tok', stateDir, version: '9.9.9', handler, exit: () => {} });
  cleanup.push(() => agent.stop());
  return srv;
}

describe('runAgent error mapping', () => {
  it('answers a plain thrown Error with AGENT_ERROR whose reason is the message cut to 500 chars', async () => {
    const long = `docker daemon unreachable ${'x'.repeat(600)}`;
    const srv = await start(async (k) => {
      if (k.step === 'long') throw new Error(long);
      throw new Error('disk full');
    });
    const c = await srv.next();
    await c.messages.next();
    c.ws.send(JSON.stringify({ t: 'req', id: 'r1', key: { opId: 'op-1', step: 'short' }, cmd: { type: 'ping' } }));
    await expect(c.messages.next()).resolves.toMatchObject({ t: 'res', id: 'r1', ok: false, code: 'AGENT_ERROR', params: { reason: 'disk full' } });
    c.ws.send(JSON.stringify({ t: 'req', id: 'r2', key: { opId: 'op-1', step: 'long' }, cmd: { type: 'ping' } }));
    await expect(c.messages.next()).resolves.toMatchObject({ t: 'res', id: 'r2', ok: false, code: 'AGENT_ERROR', params: { reason: long.slice(0, 500) } });
  });

  it('keeps AgentError codes and answers a schema-invalid request with INVALID_REQUEST', async () => {
    const srv = await start(async () => { throw new AgentError('STORAGE_FAILED', { kind: 'local' }); });
    const c = await srv.next();
    await c.messages.next();
    c.ws.send(JSON.stringify({ t: 'req', id: 'bad', key: { opId: 'op-1' }, cmd: { type: 'nope' } }));
    await expect(c.messages.next()).resolves.toMatchObject({ id: 'bad', ok: false, code: 'INVALID_REQUEST' });
    c.ws.send(JSON.stringify({ t: 'req', id: 'r1', key: { opId: 'op-1', step: 's' }, cmd: { type: 'ping' } }));
    await expect(c.messages.next()).resolves.toMatchObject({ id: 'r1', ok: false, code: 'STORAGE_FAILED', params: { kind: 'local' } });
  });
});

describe('runAgent reconnect backoff', () => {
  it('keeps backing off after bye UNAUTHORIZED and resets only after a server message that is not bye', async () => {
    const srv = await start(async () => ({}));
    const reject = async () => {
      const c = await srv.next();
      await c.messages.next();
      c.ws.send(JSON.stringify({ t: 'bye', code: 'UNAUTHORIZED' }));
      c.ws.close();
      return c.at;
    };
    const t1 = await reject();
    const t2 = await reject();
    const third = await srv.next();
    await third.messages.next();
    third.ws.send(JSON.stringify({ t: 'ping' }));
    await expect(third.messages.next()).resolves.toEqual({ t: 'pong' });
    third.ws.close();
    const fourth = await srv.next();
    expect(t2 - t1).toBeGreaterThanOrEqual(900);
    expect(third.at - t2).toBeGreaterThanOrEqual(1900);
    expect(fourth.at - third.at).toBeLessThan(1600);
  }, 15_000);
});

describe('microrun agent install-service', () => {
  const bin = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--import', 'tsx', BIN, ...args], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, MICRORUN_AGENT_TOKEN: '', ...env },
    });

  it('reads the token from EnvironmentFile and never writes it into the unit when --token is given', () => {
    const r = bin(['agent', 'install-service', '--url', 'https://microrun.example.com', '--token', 'agt-secret-123']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('EnvironmentFile=/etc/microrun/agent.env');
    expect(r.stdout).not.toContain('MICRORUN_AGENT_TOKEN=');
    expect(r.stdout).not.toContain('agt-secret-123');
    expect(r.stderr).toContain('install -m 600');
    expect(r.stderr).toContain('/etc/microrun/agent.env');
  }, 20_000);

  it('leaves a token from MICRORUN_AGENT_TOKEN out of the unit', () => {
    const r = bin(['agent', 'install-service', '--url', 'https://microrun.example.com'], { MICRORUN_AGENT_TOKEN: 'agt-env-456' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('EnvironmentFile=/etc/microrun/agent.env');
    expect(r.stdout).not.toContain('agt-env-456');
    expect(r.stdout).not.toContain('MICRORUN_AGENT_TOKEN=');
  }, 20_000);
});
