import WebSocket from 'ws';
import { AgentError, PROTOCOL_VERSION, wsServerToAgent } from '@microrun/core/protocol';
import { createHandler, type DockerRun, type Handler } from './handler.ts';

export { AGENT_VERSION } from './handler.ts';

const MAX_BACKOFF_S = 30;

function agentUrl(url: string): string {
  return `${url.replace(/\/+$/, '').replace(/^http/, 'ws')}/api/v1/agent`;
}

export function runAgent(p: {
  url: string;
  token: string;
  stateDir: string;
  version: string;
  handler?: Handler;
  docker?: DockerRun;
  exit?: (code: number) => void;
}): { stop(): Promise<void> } {
  const err = (s: string) => void process.stderr.write(`${s}\n`);
  const exit = p.exit ?? ((code: number) => process.exit(code));
  let handler = p.handler;
  if (!handler) {
    handler = createHandler({ stateDir: p.stateDir, docker: p.docker });
    handler({ opId: 'agent', step: 'start' }, { type: 'ping' })
      .then((r) => {
        const w = (r as { warning?: string }).warning;
        if (w) err(`microrun agent: docker compose 2.30.0 or newer is required (${w}); compose commands are rejected`);
      })
      .catch(() => {});
  }
  const handle = handler;
  const target = agentUrl(p.url);
  let stopped = false;
  let attempt = 0;
  let socket: WebSocket | null = null;
  let timer: NodeJS.Timeout | undefined;

  const send = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const respond = async (ws: WebSocket, id: string, run: () => Promise<unknown>) => {
    try {
      send(ws, { t: 'res', id, ok: true, result: await run() });
    } catch (e) {
      const a = e instanceof AgentError ? e : new AgentError('INVALID_REQUEST', { reason: e instanceof Error ? e.message : String(e) });
      send(ws, { t: 'res', id, ok: false, code: a.code, params: a.params, message: e instanceof Error ? e.message : String(e) });
    }
  };

  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(target, { headers: { authorization: `Bearer ${p.token}` } });
    socket = ws;
    ws.on('open', () => {
      attempt = 0;
      send(ws, { t: 'hello', protocolVersion: PROTOCOL_VERSION, agentVersion: p.version });
    });
    ws.on('message', (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return;
      }
      const parsed = wsServerToAgent.safeParse(raw);
      if (!parsed.success) {
        const r = raw as { t?: unknown; id?: unknown } | null;
        if (r?.t === 'req' && typeof r.id === 'string') {
          void respond(ws, r.id, async () => { throw new AgentError('INVALID_REQUEST', { reason: 'malformed request' }); });
        }
        return;
      }
      const msg = parsed.data;
      if (msg.t === 'ping') send(ws, { t: 'pong' });
      else if (msg.t === 'req') void respond(ws, msg.id, () => handle(msg.key, msg.cmd));
      else if (msg.code === 'PROTOCOL_MISMATCH') {
        stopped = true;
        clearTimeout(timer);
        err(`microrun agent: the server does not support agent protocol ${PROTOCOL_VERSION}; upgrade the agent or the server`);
        ws.close();
        exit(2);
      } else err('microrun agent: the server rejected the agent token');
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (socket === ws) socket = null;
      if (stopped) return;
      const delay = Math.min(MAX_BACKOFF_S, 2 ** attempt) * 1000;
      attempt++;
      timer = setTimeout(connect, delay);
    });
  };

  connect();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      const ws = socket;
      if (!ws || ws.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
        ws.terminate();
      });
    },
  };
}
