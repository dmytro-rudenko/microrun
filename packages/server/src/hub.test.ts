import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { Knex } from 'knex';
import { AgentError, PROTOCOL_VERSION, type Command } from '@microrun/core/protocol';
import { openDb } from './db/db.ts';
import { Repo } from './db/repo.ts';
import { Hub, registerAgentRoute } from './hub.ts';

const NOW = 1_700_000_000_000;
const clock = () => NOW;

type Listener = (arg?: unknown) => void;

class FakeSocket {
  sent: any[] = [];
  closedWith: number | undefined | null = null;
  private listeners: Record<string, Listener[]> = { message: [], close: [] };

  send(s: string): void {
    this.sent.push(JSON.parse(s));
  }

  on(event: 'message' | 'close', fn: Listener): void {
    this.listeners[event].push(fn);
  }

  close(code?: number): void {
    this.closedWith = code;
    this.emitClose(code ?? 1000);
  }

  emitMessage(msg: unknown): void {
    for (const fn of this.listeners.message) fn(JSON.stringify(msg));
  }

  emitClose(code = 1006): void {
    const fns = this.listeners.close;
    this.listeners.close = [];
    for (const fn of fns) fn(code);
  }

  reqs(): any[] {
    return this.sent.filter((m) => m.t === 'req');
  }

  pings(): number {
    return this.sent.filter((m) => m.t === 'ping').length;
  }
}

const key = { opId: 'op-1', step: 'pull' };
const pullCmd: Command = { type: 'pullImages', refs: ['app:1'] };

function settle<T>(p: Promise<T>): Promise<{ value?: T; error?: unknown; done: true }> {
  return p.then((value) => ({ value, done: true as const }), (error) => ({ error, done: true as const }));
}

let db: Knex;
let repo: Repo;

beforeEach(async () => {
  db = await openDb(':memory:');
  repo = new Repo(db);
});

afterEach(async () => {
  vi.useRealTimers();
  await db.destroy();
});

describe('Hub with a socket', () => {
  let hub: Hub;

  beforeEach(() => {
    vi.useFakeTimers();
    hub = new Hub({ repo, clock });
  });

  it('resolves a call with the agent result', async () => {
    const sock = new FakeSocket();
    hub.attachSocket('srv-1', sock, { agentVersion: '1.0.0' });
    expect(hub.isOnline('srv-1')).toBe(true);

    const p = hub.call('srv-1', key, { type: 'pullImages', refs: ['app:1'] });
    await vi.advanceTimersByTimeAsync(0);

    const [req] = sock.reqs();
    expect(req).toMatchObject({ t: 'req', key, cmd: pullCmd });
    expect(typeof req.id).toBe('string');

    sock.emitMessage({ t: 'res', id: req.id, ok: true, result: { digests: { 'app:1': 'sha256:aa' } } });
    await expect(p).resolves.toEqual({ digests: { 'app:1': 'sha256:aa' } });
  });

  it('routes concurrent responses to their own calls by id', async () => {
    const sock = new FakeSocket();
    hub.attachSocket('srv-1', sock, { agentVersion: '1.0.0' });

    const a = hub.call('srv-1', { opId: 'op-1', step: 'a' }, { type: 'ping' });
    const b = hub.call('srv-1', { opId: 'op-1', step: 'b' }, { type: 'ping' });
    await vi.advanceTimersByTimeAsync(0);

    const [ra, rb] = sock.reqs();
    expect(ra.id).not.toBe(rb.id);
    sock.emitMessage({ t: 'res', id: rb.id, ok: true, result: { agentVersion: 'B' } });
    sock.emitMessage({ t: 'res', id: ra.id, ok: true, result: { agentVersion: 'A' } });

    await expect(a).resolves.toEqual({ agentVersion: 'A' });
    await expect(b).resolves.toEqual({ agentVersion: 'B' });
  });

  it('rejects with AgentError carrying the code and params of an error response', async () => {
    const sock = new FakeSocket();
    hub.attachSocket('srv-1', sock, { agentVersion: '1.0.0' });

    const p = settle(hub.call('srv-1', key, { type: 'pullImages', refs: ['app:1'] }));
    await vi.advanceTimersByTimeAsync(0);
    const [req] = sock.reqs();
    sock.emitMessage({ t: 'res', id: req.id, ok: false, code: 'IMAGE_PULL_FAILED', params: { image: 'app:1' }, message: 'pull failed' });

    const { error } = await p;
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe('IMAGE_PULL_FAILED');
    expect((error as AgentError).params).toEqual({ image: 'app:1' });
  });

  it('resends the pending request after a disconnect and reconnect, then resolves', async () => {
    const statuses: [string, boolean][] = [];
    hub.onStatus((id, online) => statuses.push([id, online]));

    const first = new FakeSocket();
    hub.attachSocket('srv-1', first, { agentVersion: '1.0.0' });
    const p = hub.call('srv-1', key, { type: 'pullImages', refs: ['app:1'] });
    await vi.advanceTimersByTimeAsync(0);
    const [req] = first.reqs();

    first.emitClose(1006);
    expect(hub.isOnline('srv-1')).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);

    const second = new FakeSocket();
    hub.attachSocket('srv-1', second, { agentVersion: '1.0.0' });
    await vi.advanceTimersByTimeAsync(0);

    expect(second.reqs()).toEqual([{ t: 'req', id: req.id, key, cmd: pullCmd }]);
    expect(first.reqs()).toHaveLength(1);

    second.emitMessage({ t: 'res', id: req.id, ok: true, result: { digests: {} } });
    await expect(p).resolves.toEqual({ digests: {} });
    expect(statuses).toEqual([['srv-1', true], ['srv-1', false], ['srv-1', true]]);
  });

  it('throws AGENT_LOST when the socket closes mid-call and no reconnect comes within 300000 ms', async () => {
    const sock = new FakeSocket();
    hub.attachSocket('srv-1', sock, { agentVersion: '1.0.0' });
    const p = settle(hub.call('srv-1', key, { type: 'pullImages', refs: ['app:1'] }));
    await vi.advanceTimersByTimeAsync(0);
    sock.emitClose(1006);

    await vi.advanceTimersByTimeAsync(299_999);
    expect(await Promise.race([p, Promise.resolve('pending')])).toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    const { error } = await p;
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe('AGENT_LOST');
  });

  it('throws AGENT_LOST for a server that never comes online within 300000 ms', async () => {
    const p = settle(hub.call('srv-x', key, { type: 'ping' }));

    await vi.advanceTimersByTimeAsync(299_999);
    expect(await Promise.race([p, Promise.resolve('pending')])).toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    const { error } = await p;
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe('AGENT_LOST');
  });

  it('waits for an offline server and sends the call once it comes online', async () => {
    const p = hub.call('srv-1', key, { type: 'ping' });
    await vi.advanceTimersByTimeAsync(120_000);

    const sock = new FakeSocket();
    hub.attachSocket('srv-1', sock, { agentVersion: '1.0.0' });
    await vi.advanceTimersByTimeAsync(0);

    const [req] = sock.reqs();
    expect(req).toMatchObject({ t: 'req', key, cmd: { type: 'ping' } });
    sock.emitMessage({ t: 'res', id: req.id, ok: true, result: { agentVersion: '1.0.0' } });
    await expect(p).resolves.toEqual({ agentVersion: '1.0.0' });
  });

  it('pings every 15000 ms and stays online while pongs come back', async () => {
    const sock = new FakeSocket();
    const realSend = sock.send.bind(sock);
    sock.send = (s: string) => {
      realSend(s);
      if (JSON.parse(s).t === 'ping') queueMicrotask(() => sock.emitMessage({ t: 'pong' }));
    };
    hub.attachSocket('srv-1', sock, { agentVersion: '1.0.0' });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(sock.pings()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sock.pings()).toBe(1);

    await vi.advanceTimersByTimeAsync(15_000 * 7);
    expect(sock.pings()).toBe(8);
    expect(hub.isOnline('srv-1')).toBe(true);
  });

  it('marks the server offline after 2 missed pongs', async () => {
    const statuses: [string, boolean][] = [];
    hub.onStatus((id, online) => statuses.push([id, online]));
    const sock = new FakeSocket();
    hub.attachSocket('srv-1', sock, { agentVersion: '1.0.0' });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(hub.isOnline('srv-1')).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(hub.isOnline('srv-1')).toBe(false);
    expect(statuses).toEqual([['srv-1', true], ['srv-1', false]]);
  });
});

describe('Hub socket replacement and disconnect', () => {
  let hub: Hub;
  let statuses: [string, boolean][];

  beforeEach(() => {
    vi.useFakeTimers();
    hub = new Hub({ repo, clock });
    statuses = [];
    hub.onStatus((id, online) => statuses.push([id, online]));
  });

  it('closes the previous socket with 4000 when a replacement attaches and stays online on it', async () => {
    const first = new FakeSocket();
    hub.attachSocket('srv-1', first, { agentVersion: '1.0.0' });
    const second = new FakeSocket();
    hub.attachSocket('srv-1', second, { agentVersion: '1.0.0' });

    expect(first.closedWith).toBe(4000);
    expect(second.closedWith).toBeNull();
    expect(hub.isOnline('srv-1')).toBe(true);
    expect(statuses).toEqual([['srv-1', true]]);

    const p = hub.call('srv-1', key, { type: 'ping' });
    await vi.advanceTimersByTimeAsync(0);
    expect(first.reqs()).toEqual([]);
    const [req] = second.reqs();
    second.emitMessage({ t: 'res', id: req.id, ok: true, result: { agentVersion: '1.0.0' } });
    await expect(p).resolves.toEqual({ agentVersion: '1.0.0' });
  });

  it('disconnect closes the live socket with 4003 and marks the server offline', async () => {
    const sock = new FakeSocket();
    hub.attachSocket('srv-1', sock, { agentVersion: '1.0.0' });

    hub.disconnect('srv-1');

    expect(sock.closedWith).toBe(4003);
    expect(hub.isOnline('srv-1')).toBe(false);
    expect(statuses).toEqual([['srv-1', true], ['srv-1', false]]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sock.pings()).toBe(0);
  });

  it('disconnect of a server without a socket changes nothing', () => {
    hub.disconnect('srv-x');
    expect(hub.isOnline('srv-x')).toBe(false);
    expect(statuses).toEqual([]);
  });
});

describe('Hub with a local handler', () => {
  it('dispatches the call to the handler with key and command', async () => {
    const hub = new Hub({ repo, clock });
    const seen: unknown[] = [];
    hub.attachLocal('builtin', async (k, cmd) => {
      seen.push([k, cmd]);
      return { digests: { 'app:1': 'sha256:bb' } };
    });

    expect(hub.isOnline('builtin')).toBe(true);
    await expect(hub.call('builtin', key, { type: 'pullImages', refs: ['app:1'] })).resolves.toEqual({
      digests: { 'app:1': 'sha256:bb' },
    });
    expect(seen).toEqual([[key, pullCmd]]);
  });
});

describe('registerAgentRoute', () => {
  const token = 'agent-token-123';
  let app: FastifyInstance;
  let hub: Hub;
  let serverId: string;

  beforeEach(async () => {
    const row = await repo.createServer({
      name: 'main',
      agentTokenHash: createHash('sha256').update(token).digest('hex'),
      builtin: false,
    });
    serverId = row.id;
    hub = new Hub({ repo, clock });
    app = Fastify();
    await app.register(websocket);
    registerAgentRoute(app, hub, repo);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  function connect() {
    return app.injectWS('/api/v1/agent', { headers: { authorization: `Bearer ${token}` } } as never);
  }

  it('sends bye PROTOCOL_MISMATCH and closes with 4001 on a protocol version mismatch', async () => {
    const ws = await connect();
    const messages: unknown[] = [];
    ws.on('message', (data: unknown) => messages.push(JSON.parse(String(data))));
    const closed = new Promise<number>((resolve) => ws.on('close', (code: number) => resolve(code)));

    ws.send(JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION + 1, agentVersion: '9.0.0' }));

    expect(await closed).toBe(4001);
    expect(messages).toContainEqual({ t: 'bye', code: 'PROTOCOL_MISMATCH' });
    expect(hub.isOnline(serverId)).toBe(false);
  });

  it('closes a connection that sends no hello within 10 s with 4002', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ws = await connect();
    let code: number | null = null;
    ws.on('close', (c: number) => {
      code = c;
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(code).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(code).toBe(4002), { timeout: 1000 });
    expect(hub.isOnline(serverId)).toBe(false);
  });

  it('brings the agent online on a matching hello, records it as seen and carries calls end to end', async () => {
    const online = new Promise<void>((resolve) => hub.onStatus((id, on) => { if (id === serverId && on) resolve(); }));
    const ws = await connect();
    ws.on('message', (data: unknown) => {
      const msg = JSON.parse(String(data));
      if (msg.t === 'req') ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: true, result: { agentVersion: '1.2.3' } }));
      if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }));
    });

    ws.send(JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION, agentVersion: '1.2.3' }));
    await online;

    expect(hub.isOnline(serverId)).toBe(true);
    await expect(hub.call(serverId, key, { type: 'ping' })).resolves.toEqual({ agentVersion: '1.2.3' });
    const row = await repo.getServer(serverId);
    expect(row).toMatchObject({ lastSeenAt: NOW, agentVersion: '1.2.3' });
    ws.terminate();
  });
});
