import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { openDb } from './db/db.ts';
import { Repo } from './db/repo.ts';
import { start } from './main.ts';

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];

function tempDir(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function env(dataDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    MICRORUN_ADMIN_USER: 'admin',
    MICRORUN_ADMIN_PASSWORD: 'correct-horse-9',
    MICRORUN_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    MICRORUN_PUBLIC_URL: 'http://127.0.0.1:18081',
    MICRORUN_DATA_DIR: dataDir,
    ...extra,
  };
}

async function servers(dataDir: string) {
  const db = await openDb(join(dataDir, 'microrun.db'));
  try {
    return await new Repo(db).listServers();
  } finally {
    await db.destroy();
  }
}

async function run(dataDir: string, dockerSocket: string) {
  const s = await start(env(dataDir), { dockerSocket, port: 0 });
  stops.push(s.stop);
  return s;
}

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('start', () => {
  test('serves the login page over HTTP on the configured port', async () => {
    const data = tempDir('mr-main-');
    const { app } = await run(data, join(data, 'no-such.sock'));
    const { port } = app.server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/login`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="username"');
  });

  test('rejects an admin password shorter than 12 characters with the config message', async () => {
    const data = tempDir('mr-main-');
    await expect(start(env(data, { MICRORUN_ADMIN_PASSWORD: 'short' }), { port: 0 })).rejects.toThrow(
      'MICRORUN_ADMIN_PASSWORD must be at least 12 characters',
    );
  });

  test('registers no built-in server when the docker socket is absent', async () => {
    const data = tempDir('mr-main-');
    const s = await run(data, join(data, 'no-such.sock'));
    await s.stop();
    stops.pop();
    expect(await servers(data)).toEqual([]);
  });

  test('registers one built-in server named local when the docker socket exists, also after a restart', async () => {
    const data = tempDir('mr-main-');
    const sock = join(data, 'docker.sock');
    writeFileSync(sock, '');
    const first = await run(data, sock);
    await first.stop();
    stops.pop();
    const second = await run(data, sock);
    await second.stop();
    stops.pop();
    const list = await servers(data);
    expect(list.map((s) => [s.name, s.builtin])).toEqual([['local', true]]);
  });
});
