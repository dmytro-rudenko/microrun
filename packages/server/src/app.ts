import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import websocket from '@fastify/websocket';
import { i18n, isLang } from '@microrun/core/i18n';
import type { OperationEvent } from '@microrun/core/protocol';
import { registerAuth } from './auth.ts';
import type { Config } from './config.ts';
import type { OperationRow, Repo } from './db/repo.ts';
import { registerAgentRoute, type Hub } from './hub.ts';
import type { Orchestrator } from './orchestrator.ts';
import type { Scheduler } from './scheduler.ts';
import { loginView } from './ui/login.ts';
import { registerApi } from './routes/api.ts';
import { registerUi } from './routes/ui.ts';

export class OpBus {
  private readonly subs = new Map<string, Set<(ev: OperationEvent) => void>>();

  emit(opId: string, ev: OperationEvent): void {
    for (const fn of [...(this.subs.get(opId) ?? [])]) fn(ev);
  }

  subscribe(opId: string, fn: (ev: OperationEvent) => void): () => void {
    const set = this.subs.get(opId) ?? new Set();
    set.add(fn);
    this.subs.set(opId, set);
    return () => {
      set.delete(fn);
      if (!set.size && this.subs.get(opId) === set) this.subs.delete(opId);
    };
  }
}

export interface AppDeps {
  config: Config;
  repo: Repo;
  hub: Hub;
  orchestrator: Orchestrator;
  scheduler: Scheduler;
  clock: () => number;
  bus: OpBus;
}

export type Frame = [event: string, data: string];

const oneLine = (s: string) => s.replace(/[\r\n]/g, '');

export const finished = (op: OperationRow) => op.status !== 'pending' && op.status !== 'running';

export async function streamOperation(
  reply: FastifyReply,
  d: Pick<AppDeps, 'bus' | 'repo'>,
  opId: string,
  frames: (op: OperationRow, ev: OperationEvent | null) => Promise<Frame[]> | Frame[],
): Promise<void> {
  let ended = false;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let chain = Promise.resolve();
  const unsubscribe = d.bus.subscribe(opId, (ev) => {
    chain = chain.then(() => write(ev));
  });
  const stop = () => {
    ended = true;
    clearInterval(keepalive);
    unsubscribe();
  };
  const end = () => {
    if (ended) return;
    stop();
    reply.raw.end();
  };
  const write = async (ev: OperationEvent | null) => {
    if (ended) return;
    const op = await d.repo.getOperation(opId);
    if (!op || ended) return;
    const out = await frames(op, ev);
    if (ended) return;
    for (const [event, data] of out) reply.raw.write(`event: ${oneLine(event)}\ndata: ${oneLine(data)}\n\n`);
    if (out.some(([event]) => event === 'done')) end();
  };
  reply.raw.on('close', stop);
  reply.hijack();
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  keepalive = setInterval(() => {
    if (!ended) reply.raw.write(': keepalive\n\n');
  }, 15_000);
  chain = chain.then(() => write(null));
  await chain;
}

function firstFile(candidates: (() => string)[]): string | null {
  for (const c of candidates) {
    try {
      const p = c();
      if (existsSync(p)) return p;
    } catch {}
  }
  return null;
}

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export async function buildApp(d: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: d.config.trustProxy ?? false });
  await app.register(websocket);
  registerAuth(app, {
    repo: d.repo,
    config: d.config,
    clock: d.clock,
    renderLogin: ({ error, csrf, lang }) => loginView(i18n(isLang(lang) ? lang : 'en'), { error, csrf }),
  });
  registerAgentRoute(app, d.hub, d.repo);

  const htmx = firstFile([() => here('./public/htmx.min.js'), () => createRequire(import.meta.url).resolve('htmx.org/dist/htmx.min.js')]);
  const css = firstFile([() => here('./public/app.css')]);
  app.get('/static/htmx.min.js', async (_req, reply) =>
    htmx ? reply.type('application/javascript; charset=utf-8').send(readFileSync(htmx)) : reply.code(404).send(),
  );
  app.get('/static/app.css', async (_req, reply) => (css ? reply.type('text/css; charset=utf-8').send(readFileSync(css)) : reply.code(404).send()));

  app.register(async (s) => registerApi(s, d));
  app.register(async (s) => registerUi(s, d));
  return app;
}
