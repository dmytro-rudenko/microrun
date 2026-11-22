import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Knex } from 'knex';
import { openDb } from './db/db.ts';
import { Repo } from './db/repo.ts';
import { registerAuth } from './auth.ts';
import { loadConfig } from './config.ts';
import { decrypt, encrypt, hashToken, newToken } from './crypto.ts';

const HOUR = 60 * 60 * 1000;
const PASSWORD = 'correct-horse-battery';
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');

function env(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    MICRORUN_ADMIN_USER: 'admin',
    MICRORUN_ADMIN_PASSWORD: PASSWORD,
    MICRORUN_SECRET_KEY: KEY_B64,
    MICRORUN_PUBLIC_URL: 'http://localhost:8080',
    ...over,
  };
}

let db: Knex;
let repo: Repo;
let now: number;
let app: FastifyInstance;
let opened: FastifyInstance[];

type RenderLogin = (p: { error: boolean; csrf?: string; lang?: string }) => string;

async function build(opts: { publicUrl?: string; renderLogin?: RenderLogin } = {}): Promise<FastifyInstance> {
  const config = loadConfig(env({ MICRORUN_PUBLIC_URL: opts.publicUrl ?? 'http://localhost:8080' }));
  const a = Fastify();
  opened.push(a);
  const deps = { repo, config, clock: () => now, ...(opts.renderLogin ? { renderLogin: opts.renderLogin } : {}) };
  registerAuth(a, deps);
  await a.after();
  a.get('/token', { preHandler: a.requireAdmin }, async (req) => ({ csrf: req.csrfToken }));
  a.post('/things', { preHandler: a.requireAdmin }, async () => ({ ok: true }));
  a.post('/api/v1/ping', async () => ({ pong: true }));
  await a.ready();
  return a;
}

function form(fields: Record<string, string>) {
  return {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  };
}

function login(a: FastifyInstance, username: string, password: string, remoteAddress = '10.0.0.1') {
  const f = form({ username, password });
  return a.inject({ method: 'POST', url: '/login', remoteAddress, headers: f.headers, payload: f.payload });
}

function sessionCookie(res: LightMyRequestResponse) {
  return res.cookies.find((c) => c.name === 'mr_session');
}

async function loggedIn(a: FastifyInstance, ip = '10.0.0.1'): Promise<{ cookie: string; csrf: string }> {
  const res = await login(a, 'admin', PASSWORD, ip);
  expect(res.statusCode).toBe(302);
  const c = sessionCookie(res)!;
  const cookie = `mr_session=${c.value}`;
  const tok = await a.inject({ method: 'GET', url: '/token', headers: { cookie, accept: 'application/json' } });
  expect(tok.statusCode).toBe(200);
  return { cookie, csrf: tok.json().csrf };
}

beforeEach(async () => {
  db = await openDb(':memory:');
  repo = new Repo(db);
  now = 1_700_000_000_000;
  opened = [];
});

afterEach(async () => {
  for (const a of opened) await a.close();
  await db.destroy();
});

describe('login', () => {
  beforeEach(async () => {
    app = await build();
  });

  it('GET /login without a renderer returns a minimal form', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toMatch(/id="username"/);
    expect(res.body).toMatch(/id="password"/);
    expect(res.body).toMatch(/type="submit"/);
  });

  it('wrong password returns 401 without a session cookie', async () => {
    const res = await login(app, 'admin', 'wrong-password-123');
    expect(res.statusCode).toBe(401);
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('wrong user with the right password returns 401', async () => {
    const res = await login(app, 'root', PASSWORD);
    expect(res.statusCode).toBe(401);
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('right credentials return 302 with an httpOnly SameSite=Strict mr_session cookie', async () => {
    const res = await login(app, 'admin', PASSWORD);
    expect(res.statusCode).toBe(302);
    const c = sessionCookie(res);
    expect(c).toBeDefined();
    expect(c!.value).not.toBe('');
    expect(c!.httpOnly).toBe(true);
    expect(c!.sameSite).toBe('Strict');
    expect(c!.secure).toBeFalsy();
  });

  it('sets the session cookie for 12 h on path /', async () => {
    const c = sessionCookie(await login(app, 'admin', PASSWORD));
    expect(c).toMatchObject({ maxAge: 43200, path: '/' });
  });

  it('the 6th attempt within a minute from one IP returns 429', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login(app, 'admin', 'wrong-password-123', '10.0.0.9')).statusCode).toBe(401);
    }
    expect((await login(app, 'admin', PASSWORD, '10.0.0.9')).statusCode).toBe(429);
    expect((await login(app, 'admin', 'wrong-password-123', '10.0.0.10')).statusCode).toBe(401);
  });

  it('limits attempts per IP and lowercased username, so another username from the same IP still gets through', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await login(app, 'admin', 'wrong-password-123', '10.0.0.9')).statusCode).toBe(401);
    }
    expect((await login(app, 'ADMIN', PASSWORD, '10.0.0.9')).statusCode).toBe(429);
    expect((await login(app, 'mallory', 'wrong-password-123', '10.0.0.9')).statusCode).toBe(401);
  });
});

describe('login page language', () => {
  beforeEach(async () => {
    app = await build({ renderLogin: (p) => `<main>LOGIN lang=${p.lang}</main>` });
  });

  it.each([
    ['the mr_lang cookie', { cookie: 'mr_lang=de', 'accept-language': 'fr' }, 'de'],
    ['Accept-Language', { 'accept-language': 'fr-FR,fr;q=0.9' }, 'fr'],
    ['Accept-Language over an unsupported cookie', { cookie: 'mr_lang=xx', 'accept-language': 'pl' }, 'pl'],
    ['en by default', {}, 'en'],
  ])('renders GET /login in the language of %s', async (_, headers, lang) => {
    const res = await app.inject({ method: 'GET', url: '/login', headers });
    expect(res.body).toContain(`LOGIN lang=${lang}`);
  });

  it('renders a failed POST /login in the negotiated language', async () => {
    const f = form({ username: 'admin', password: 'wrong-password-123' });
    const res = await app.inject({ method: 'POST', url: '/login', headers: { ...f.headers, 'accept-language': 'uk' }, payload: f.payload });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('LOGIN lang=uk');
  });
});

describe('login with https public URL', () => {
  it('sets a Secure session cookie', async () => {
    app = await build({ publicUrl: 'https://deploy.example.com' });
    const res = await login(app, 'admin', PASSWORD);
    expect(res.statusCode).toBe(302);
    expect(sessionCookie(res)!.secure).toBe(true);
  });
});

describe('login with an injected renderer', () => {
  it('renders the login page and the error state through renderLogin', async () => {
    app = await build({ renderLogin: (p) => `<main>LOGIN error=${p.error}</main>` });
    const page = await app.inject({ method: 'GET', url: '/login' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('LOGIN error=false');
    const bad = await login(app, 'admin', 'wrong-password-123');
    expect(bad.statusCode).toBe(401);
    expect(bad.body).toContain('LOGIN error=true');
  });
});

describe('requireAdmin', () => {
  beforeEach(async () => {
    app = await build();
  });

  it('redirects an HTML request without a session to /login', async () => {
    const res = await app.inject({ method: 'GET', url: '/token', headers: { accept: 'text/html' } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('returns 401 to an htmx request without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/token', headers: { accept: 'text/html', 'hx-request': 'true' } });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 to a JSON request without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/token', headers: { accept: 'application/json' } });
    expect(res.statusCode).toBe(401);
  });

  it('keeps the session for 12 h and rejects it after', async () => {
    const { cookie } = await loggedIn(app);
    now += 12 * HOUR - 1000;
    const alive = await app.inject({ method: 'GET', url: '/token', headers: { cookie, accept: 'application/json' } });
    expect(alive.statusCode).toBe(200);
    now += 2000;
    const dead = await app.inject({ method: 'GET', url: '/token', headers: { cookie, accept: 'application/json' } });
    expect(dead.statusCode).toBe(401);
  });
});

describe('CSRF', () => {
  beforeEach(async () => {
    app = await build();
  });

  it('rejects a POST without a CSRF token with 403', async () => {
    const { cookie } = await loggedIn(app);
    const res = await app.inject({ method: 'POST', url: '/things', headers: { cookie, accept: 'application/json' } });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a POST with a wrong CSRF token with 403', async () => {
    const { cookie } = await loggedIn(app);
    const res = await app.inject({
      method: 'POST',
      url: '/things',
      headers: { cookie, accept: 'application/json', 'x-csrf-token': 'not-the-token' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects the CSRF token of another session with 403', async () => {
    const a = await loggedIn(app);
    const b = await loggedIn(app);
    expect(a.csrf).not.toBe(b.csrf);
    const res = await app.inject({
      method: 'POST',
      url: '/things',
      headers: { cookie: b.cookie, accept: 'application/json', 'x-csrf-token': a.csrf },
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts the token in the x-csrf-token header', async () => {
    const { cookie, csrf } = await loggedIn(app);
    const res = await app.inject({
      method: 'POST',
      url: '/things',
      headers: { cookie, accept: 'application/json', 'x-csrf-token': csrf },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('accepts the token in the _csrf form field', async () => {
    const { cookie, csrf } = await loggedIn(app);
    const f = form({ _csrf: csrf, name: 'x' });
    const res = await app.inject({
      method: 'POST',
      url: '/things',
      headers: { ...f.headers, cookie, accept: 'application/json' },
      payload: f.payload,
    });
    expect(res.statusCode).toBe(200);
  });

  it('exempts /api/v1/* routes', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/ping', headers: { accept: 'application/json' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pong: true });
  });

  it('POST /logout requires CSRF and ends the session', async () => {
    const { cookie, csrf } = await loggedIn(app);
    const denied = await app.inject({ method: 'POST', url: '/logout', headers: { cookie } });
    expect(denied.statusCode).toBe(403);
    const out = await app.inject({ method: 'POST', url: '/logout', headers: { cookie, 'x-csrf-token': csrf } });
    expect(out.statusCode).toBeLessThan(400);
    const after = await app.inject({ method: 'GET', url: '/token', headers: { cookie, accept: 'application/json' } });
    expect(after.statusCode).toBe(401);
  });
});

describe('crypto', () => {
  const key = Buffer.alloc(32, 7);

  it('round-trips through encrypt and decrypt', () => {
    const plain = 'postgres://user:päss@db/app';
    const blob = encrypt(key, plain);
    expect(blob.length).toBe(12 + 16 + Buffer.byteLength(plain));
    expect(blob.includes(Buffer.from(plain))).toBe(false);
    expect(decrypt(key, blob)).toBe(plain);
  });

  it('uses a fresh IV for each encryption', () => {
    expect(encrypt(key, 'same').equals(encrypt(key, 'same'))).toBe(false);
  });

  it('throws on a tampered blob', () => {
    const blob = encrypt(key, 'secret value');
    blob[blob.length - 1]! ^= 0x01;
    expect(() => decrypt(key, blob)).toThrow();
  });

  it('throws on a tampered tag', () => {
    const blob = encrypt(key, 'secret value');
    blob[12]! ^= 0x01;
    expect(() => decrypt(key, blob)).toThrow();
  });

  it('throws with the wrong key', () => {
    const blob = encrypt(key, 'secret value');
    expect(() => decrypt(Buffer.alloc(32, 8), blob)).toThrow();
  });

  it('newToken is 32 random bytes in base64url', () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(t, 'base64url').length).toBe(32);
    expect(newToken()).not.toBe(t);
  });

  it('hashToken is sha256 hex', () => {
    expect(hashToken('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('loadConfig', () => {
  it('reads a valid environment with defaults', () => {
    const c = loadConfig(env());
    expect(c.adminUser).toBe('admin');
    expect(c.adminPassword).toBe(PASSWORD);
    expect(c.secretKey.length).toBe(32);
    expect(c.publicUrl.href).toBe('http://localhost:8080/');
    expect(c.dataDir).toBe('/data');
    expect(c.port).toBe(8080);
    expect(c.secureCookies).toBe(false);
    expect(c.trustProxy).toBe(false);
  });

  it('reads MICRORUN_TRUST_PROXY', () => {
    expect(loadConfig(env({ MICRORUN_TRUST_PROXY: '10.0.0.0/8' })).trustProxy).toBe('10.0.0.0/8');
  });

  it('reads MICRORUN_DATA_DIR and PORT, and https enables secure cookies', () => {
    const c = loadConfig(env({ MICRORUN_DATA_DIR: '/srv/mr', PORT: '9000', MICRORUN_PUBLIC_URL: 'https://deploy.example.com' }));
    expect(c.dataDir).toBe('/srv/mr');
    expect(c.port).toBe(9000);
    expect(c.secureCookies).toBe(true);
  });

  it('rejects a password shorter than 12 characters', () => {
    expect(() => loadConfig(env({ MICRORUN_ADMIN_PASSWORD: 'short-pass1' }))).toThrow(
      'MICRORUN_ADMIN_PASSWORD must be at least 12 characters',
    );
  });

  it('rejects a secret key that decodes to 31 bytes', () => {
    expect(() => loadConfig(env({ MICRORUN_SECRET_KEY: Buffer.alloc(31, 7).toString('base64') }))).toThrow(
      /MICRORUN_SECRET_KEY/,
    );
  });

  it.each(['MICRORUN_ADMIN_USER', 'MICRORUN_ADMIN_PASSWORD', 'MICRORUN_SECRET_KEY', 'MICRORUN_PUBLIC_URL'])(
    'rejects a missing %s',
    (name) => {
      expect(() => loadConfig(env({ [name]: undefined }))).toThrow(new RegExp(name));
    },
  );

  it('rejects an invalid MICRORUN_PUBLIC_URL', () => {
    expect(() => loadConfig(env({ MICRORUN_PUBLIC_URL: 'not a url' }))).toThrow(/MICRORUN_PUBLIC_URL/);
  });
});
