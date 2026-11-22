import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { codeMessage, i18n, negotiate, type I18n } from '@microrun/core/i18n';
import { deployRequest, type OperationEvent, type ResultCode } from '@microrun/core/protocol';
import { finished, streamOperation, type AppDeps } from '../app.ts';
import { hashToken } from '../crypto.ts';
import type { EnvRow, OperationRow } from '../db/repo.ts';

type Params = Record<string, string | number>;

export const wire = (p: Record<string, unknown> | null): Params =>
  Object.fromEntries(Object.entries(p ?? {}).filter((e): e is [string, string | number] => typeof e[1] === 'string' || typeof e[1] === 'number'));

export const statusFor = (code: ResultCode) =>
  code === 'ENV_BUSY' ? 409 : code === 'AGENT_OFFLINE' ? 503 : code === 'UNAUTHORIZED' ? 401 : 422;

const langOf = (req: FastifyRequest) => i18n(negotiate(undefined, req.headers['accept-language']));

const message = (i: I18n, code: string | null, params: Params) => (code ? codeMessage(i, code, params) : '');

function fail(req: FastifyRequest, reply: FastifyReply, code: ResultCode, params: Params = {}) {
  return reply.code(statusFor(code)).send({ code, message: message(langOf(req), code, params), params });
}

async function envOf(d: AppDeps, req: FastifyRequest): Promise<EnvRow | null> {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  return token ? d.repo.envByDeployTokenHash(hashToken(token)) : null;
}

function doneEvent(i: I18n, op: OperationRow): OperationEvent {
  const params = wire(op.params);
  return { type: 'done', status: op.status as 'succeeded' | 'failed' | 'rejected', code: op.code as ResultCode | null, message: message(i, op.code, params), params };
}

export function registerApi(app: FastifyInstance, d: AppDeps): void {
  app.post('/api/v1/deploy', async (req, reply) => {
    const env = await envOf(d, req);
    if (!env) return fail(req, reply, 'UNAUTHORIZED');
    const parsed = deployRequest.safeParse(req.body);
    if (!parsed.success) return fail(req, reply, 'INVALID_REQUEST');
    const res = await d.orchestrator.requestDeploy(env, parsed.data);
    if ('rejected' in res) return fail(req, reply, res.rejected.code, res.rejected.params);
    return reply.code(202).send({ operationId: res.operationId });
  });

  app.get<{ Params: { id: string } }>('/api/v1/operations/:id/events', async (req, reply) => {
    const env = await envOf(d, req);
    if (!env) return fail(req, reply, 'UNAUTHORIZED');
    const op = await d.repo.getOperation(req.params.id);
    if (!op || op.envId !== env.id) return reply.code(404).send({ error: 'not_found' });
    const i = langOf(req);
    await streamOperation(reply, d, op.id, (cur, ev) => {
      const json = (e: OperationEvent): [string, string] => [e.type, JSON.stringify(e)];
      if (ev === null) {
        const steps = Object.keys(cur.stepsDone ?? {}).map((step) => json({ type: 'step', step, status: 'done' }));
        return finished(cur) ? [...steps, json(doneEvent(i, cur))] : steps;
      }
      return [json(ev.type === 'done' ? { ...ev, message: message(i, ev.code, ev.params) } : ev)];
    });
  });
}
