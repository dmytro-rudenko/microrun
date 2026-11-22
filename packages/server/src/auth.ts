import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import type { Config } from './config.ts';
import { hashToken, newToken } from './crypto.ts';
import type { Repo } from './db/repo.ts';

declare module 'fastify' {
  interface FastifyInstance {
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>;
  }
  interface FastifyRequest {
    csrfToken: string;
    sessionId: string;
  }
}

export type RenderLogin = (p: { error: boolean; csrf?: string; lang?: string }) => string;

export interface AuthDeps {
  repo: Repo;
  config: Config;
  clock: () => number;
  renderLogin?: RenderLogin;
}

const COOKIE = 'mr_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const minimalLogin: RenderLogin = ({ error }) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>microrun</title></head><body><form method="post" action="/login">${
    error ? '<p role="alert">Invalid credentials</p>' : ''
  }<label for="username">User</label><input id="username" name="username" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Sign in</button></form></body></html>`;

function sha(v: string): Buffer {
  return createHash('sha256').update(v).digest();
}

function sameString(a: string, b: string): boolean {
  return timingSafeEqual(sha(a), sha(b));
}

function field(body: unknown, name: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const v = (body as Record<string, unknown>)[name];
  return typeof v === 'string' ? v : undefined;
}

function isExempt(url: string): boolean {
  const path = url.split('?', 1)[0]!;
  return path === '/login' || path.startsWith('/api/v1/');
}

async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (req.sessionId) return;
  const htmx = req.headers['hx-request'] === 'true';
  const html = (req.headers.accept ?? '').includes('text/html');
  if (htmx || !html) return reply.code(401).send({ error: 'unauthorized' });
  return reply.redirect('/login');
}

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  const { repo, config, clock } = deps;
  const render = deps.renderLogin ?? minimalLogin;
  const csrfFor = (sid: string) => createHmac('sha256', config.secretKey).update(sid).digest('base64url');

  app.register(cookie);
  app.register(formbody);
  app.register(rateLimit, { global: false });

  app.decorateRequest('csrfToken', '');
  app.decorateRequest('sessionId', '');

  app.addHook('preValidation', async (req, reply) => {
    const sid = req.cookies[COOKIE];
    if (sid && (await repo.getSession(hashToken(sid), clock()))) {
      req.sessionId = sid;
      req.csrfToken = csrfFor(sid);
    }
    if (SAFE_METHODS.has(req.method) || isExempt(req.url)) return;
    const header = req.headers['x-csrf-token'];
    const given = typeof header === 'string' ? header : field(req.body, '_csrf');
    if (!req.sessionId || !given || !sameString(given, req.csrfToken)) {
      return reply.code(403).send({ error: 'csrf' });
    }
  });

  app.decorate('requireAdmin', requireAdmin);

  const page = (reply: FastifyReply, status: number, error: boolean, req: FastifyRequest) =>
    reply.code(status).type('text/html; charset=utf-8').send(render({ error, csrf: req.csrfToken || undefined }));

  app.register(async (s) => {
    s.get('/login', async (req, reply) => page(reply, 200, false, req));

    s.post('/login', { config: { rateLimit: { max: 5, timeWindow: 60_000 } } }, async (req, reply) => {
      const user = field(req.body, 'username') ?? '';
      const pass = field(req.body, 'password') ?? '';
      const userOk = sameString(user, config.adminUser);
      const passOk = sameString(pass, config.adminPassword);
      if (!(userOk && passOk)) return page(reply, 401, true, req);
      const sid = newToken();
      await repo.createSession(hashToken(sid), clock(), SESSION_MS);
      reply.setCookie(COOKIE, sid, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: config.secureCookies,
        maxAge: SESSION_MS / 1000,
      });
      return reply.redirect('/');
    });

    s.post('/logout', async (req, reply) => {
      if (req.sessionId) await repo.deleteSession(hashToken(req.sessionId));
      reply.clearCookie(COOKIE, { path: '/' });
      return reply.redirect('/login');
    });
  });
}
