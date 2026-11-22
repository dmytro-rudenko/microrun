import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import {
  AgentError,
  PROTOCOL_VERSION,
  wsAgentToServer,
  type AgentPort,
  type Command,
  type CommandOf,
  type ResultMap,
} from '@microrun/core/protocol';
import type { Repo } from './db/repo.ts';

export interface WebSocketLike {
  send(s: string): void;
  on(event: 'message' | 'close', fn: (arg: any) => void): void;
  close(code?: number): void;
}

export type LocalHandler = (key: { opId: string; step: string }, cmd: Command) => Promise<unknown>;

type Key = { opId: string; step: string };

const HELLO_TIMEOUT_MS = 10_000;

interface Pending {
  id: string;
  serverId: string;
  key: Key;
  cmd: Command;
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
  lostTimer?: NodeJS.Timeout;
}

interface Conn {
  socket: WebSocketLike;
  heartbeat: NodeJS.Timeout;
  missed: number;
}

export class Hub implements AgentPort {
  readonly clock: () => number;
  private readonly reconnectWaitMs: number;
  private readonly heartbeatMs: number;
  private readonly conns = new Map<string, Conn>();
  private readonly locals = new Map<string, LocalHandler>();
  private readonly pending = new Map<string, Pending>();
  private readonly listeners: ((serverId: string, online: boolean) => void)[] = [];

  constructor(deps: { repo: Repo; clock: () => number; reconnectWaitMs?: number; heartbeatMs?: number }) {
    this.clock = deps.clock;
    this.reconnectWaitMs = deps.reconnectWaitMs ?? 300_000;
    this.heartbeatMs = deps.heartbeatMs ?? 15_000;
  }

  attachSocket(serverId: string, socket: WebSocketLike, _hello: { agentVersion: string }): void {
    const wasOnline = this.isOnline(serverId);
    const old = this.conns.get(serverId);
    if (old) clearInterval(old.heartbeat);

    const conn: Conn = { socket, missed: 0, heartbeat: setInterval(() => this.beat(serverId, conn), this.heartbeatMs) };
    conn.heartbeat.unref?.();
    this.conns.set(serverId, conn);
    old?.socket.close(4000);

    socket.on('message', (data) => this.onMessage(conn, data));
    socket.on('close', () => {
      if (this.conns.get(serverId) === conn) this.detach(serverId);
    });

    if (!wasOnline) this.emit(serverId, true);
    for (const p of this.pending.values()) {
      if (p.serverId !== serverId) continue;
      clearTimeout(p.lostTimer);
      p.lostTimer = undefined;
      this.send(conn, p);
    }
  }

  attachLocal(serverId: string, handler: LocalHandler): void {
    const wasOnline = this.isOnline(serverId);
    this.locals.set(serverId, handler);
    if (!wasOnline) this.emit(serverId, true);
  }

  call<T extends Command['type']>(serverId: string, key: Key, cmd: CommandOf<T>): Promise<ResultMap[T]> {
    const local = this.locals.get(serverId);
    if (local) return local(key, cmd) as Promise<ResultMap[T]>;

    return new Promise<ResultMap[T]>((resolve, reject) => {
      const p: Pending = { id: randomUUID(), serverId, key, cmd, resolve, reject };
      this.pending.set(p.id, p);
      const conn = this.conns.get(serverId);
      if (conn) this.send(conn, p);
      else this.startLost(p);
    });
  }

  isOnline(serverId: string): boolean {
    return this.locals.has(serverId) || this.conns.has(serverId);
  }

  disconnect(serverId: string): void {
    const conn = this.conns.get(serverId);
    if (!conn) return;
    this.detach(serverId);
    conn.socket.close(4003);
  }

  onStatus(fn: (serverId: string, online: boolean) => void): void {
    this.listeners.push(fn);
  }

  close(): void {
    for (const conn of this.conns.values()) clearInterval(conn.heartbeat);
    this.conns.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.lostTimer);
      p.reject(new AgentError('AGENT_LOST'));
    }
    this.pending.clear();
  }

  private send(conn: Conn, p: Pending): void {
    conn.socket.send(JSON.stringify({ t: 'req', id: p.id, key: p.key, cmd: p.cmd }));
  }

  private startLost(p: Pending): void {
    p.lostTimer = setTimeout(() => {
      this.pending.delete(p.id);
      p.reject(new AgentError('AGENT_LOST'));
    }, this.reconnectWaitMs);
  }

  private beat(serverId: string, conn: Conn): void {
    if (conn.missed >= 2) {
      this.detach(serverId);
      conn.socket.close();
      return;
    }
    conn.missed++;
    conn.socket.send(JSON.stringify({ t: 'ping' }));
  }

  private detach(serverId: string): void {
    const conn = this.conns.get(serverId);
    if (!conn) return;
    clearInterval(conn.heartbeat);
    this.conns.delete(serverId);
    for (const p of this.pending.values()) if (p.serverId === serverId) this.startLost(p);
    if (!this.isOnline(serverId)) this.emit(serverId, false);
  }

  private onMessage(conn: Conn, data: unknown): void {
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      return;
    }
    const parsed = wsAgentToServer.safeParse(raw);
    if (!parsed.success) return;
    const msg = parsed.data;
    if (msg.t === 'pong') {
      conn.missed = 0;
      return;
    }
    if (msg.t !== 'res') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.lostTimer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new AgentError(msg.code, msg.params));
  }

  private emit(serverId: string, online: boolean): void {
    for (const fn of this.listeners) fn(serverId, online);
  }
}

export function registerAgentRoute(app: FastifyInstance, hub: Hub, repo: Repo): void {
  app.get('/api/v1/agent', { websocket: true }, (socket: WebSocket, req) => {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const server = token ? repo.serverByTokenHash(createHash('sha256').update(token).digest('hex')) : Promise.resolve(null);
    let greeted = false;
    const helloTimer = setTimeout(() => socket.close(4002), HELLO_TIMEOUT_MS);
    socket.on('close', () => clearTimeout(helloTimer));

    socket.on('message', async (data) => {
      if (greeted) return;
      greeted = true;
      clearTimeout(helloTimer);
      const row = await server.catch(() => null);
      if (!row) {
        socket.send(JSON.stringify({ t: 'bye', code: 'UNAUTHORIZED' }));
        socket.close(4003);
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        raw = null;
      }
      const parsed = wsAgentToServer.safeParse(raw);
      if (!parsed.success || parsed.data.t !== 'hello' || parsed.data.protocolVersion !== PROTOCOL_VERSION) {
        socket.send(JSON.stringify({ t: 'bye', code: 'PROTOCOL_MISMATCH' }));
        socket.close(4001);
        return;
      }
      await repo.setServerSeen(row.id, hub.clock(), parsed.data.agentVersion);
      hub.attachSocket(row.id, socket, { agentVersion: parsed.data.agentVersion });
    });
  });
}
