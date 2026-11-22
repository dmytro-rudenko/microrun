import WebSocket from 'ws';
import { AgentError, PROTOCOL_VERSION, wsServerToAgent } from '@microrun/core/protocol';
import { createHandler, type DockerRun, type Handler } from './handler.ts';

export { AGENT_VERSION } from './handler.ts';

const MAX_BACKOFF_S = 30;
const MAX_REASON = 500;

function agentUrl(url: string): string {
  return `${url.replace(/\/+$/, '').replace(/^http/, 'ws')}/api/v1/agent`;
}

type RunAgentParams = {
  url: string;
  token: string;
  stateDir: string;
  version: string;
  handler?: Handler;
  docker?: DockerRun;
  exit?: (code: number) => void;
};

type ServerMessage = ReturnType<typeof wsServerToAgent.parse>;

const err = (s: string) => void process.stderr.write(`${s}\n`);

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function respond(ws: WebSocket, id: string, run: () => Promise<unknown>) {
  try {
    send(ws, { t: 'res', id, ok: true, result: await run() });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const a = e instanceof AgentError ? e : new AgentError('AGENT_ERROR', { reason: message.slice(0, MAX_REASON) });
    send(ws, { t: 'res', id, ok: false, code: a.code, params: a.params, message });
  }
}

function defaultHandler(p: RunAgentParams): Handler {
  const handler = createHandler({ stateDir: p.stateDir, docker: p.docker });
  handler({ opId: 'agent', step: 'start' }, { type: 'ping' })
    .then((r) => {
      const w = (r as { warning?: string }).warning;
      if (w) err(`microrun agent: docker compose 2.30.0 or newer is required (${w}); compose commands are rejected`);
    })
    .catch(() => {});
  return handler;
}

function decode(ws: WebSocket, data: WebSocket.RawData): ServerMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data.toString());
  } catch {
    return null;
  }
  const parsed = wsServerToAgent.safeParse(raw);
  if (parsed.success) return parsed.data;
  const r = raw as { t?: unknown; id?: unknown } | null;
  if (r?.t === 'req' && typeof r.id === 'string') {
    void respond(ws, r.id, async () => { throw new AgentError('INVALID_REQUEST', { reason: 'malformed request' }); });
  }
  return null;
}

export function runAgent(p: RunAgentParams): { stop(): Promise<void> } {
  const exit = p.exit ?? ((code: number) => process.exit(code));
  const handle = p.handler ?? defaultHandler(p);
  const target = agentUrl(p.url);
  let stopped = false;
  let attempt = 0;
  let socket: WebSocket | null = null;
  let timer: NodeJS.Timeout | undefined;

  const onMessage = (ws: WebSocket, msg: ServerMessage) => {
    if (msg.t !== 'bye') attempt = 0;
    if (msg.t === 'ping') send(ws, { t: 'pong' });
    else if (msg.t === 'req') void respond(ws, msg.id, () => handle(msg.key, msg.cmd));
    else if (msg.code === 'PROTOCOL_MISMATCH') {
      stopped = true;
      clearTimeout(timer);
      err(`microrun agent: the server does not support agent protocol ${PROTOCOL_VERSION}; upgrade the agent or the server`);
      ws.close();
      exit(2);
    } else err('microrun agent: the server rejected the agent token');
  };

  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(target, { headers: { authorization: `Bearer ${p.token}` } });
    socket = ws;
    ws.on('open', () => {
      send(ws, { t: 'hello', protocolVersion: PROTOCOL_VERSION, agentVersion: p.version });
    });
    ws.on('message', (data) => {
      const msg = decode(ws, data);
      if (msg) onMessage(ws, msg);
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
