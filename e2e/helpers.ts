import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const ROOT = resolve(import.meta.dirname, '..');
export const FIXTURE_SRC = join(ROOT, 'e2e', 'fixture-app');
export const MICRORUN_URL = 'http://127.0.0.1:18081';
export const APP_URL = 'http://127.0.0.1:18080';
export const ADMIN_USER = 'admin';
export const ADMIN_PASSWORD = 'correct-horse-9';
export const SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
export const MICRORUN_CONTAINER = 'mr-e2e';
export const FIXTURE_PROJECT = 'mrfix';

const VERSIONS: Record<string, string[]> = {
  v1: ['v1'],
  v2: ['v1', 'v2'],
  v3: ['v1', 'v2'],
  vbad: ['v1', 'vbad'],
};

export async function sh(cmd: string, args: string[], opts: { cwd?: string } = {}) {
  return run(cmd, args, { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 });
}

export async function buildImages() {
  await sh('docker', ['build', '-t', 'microrun/microrun:e2e', ROOT]);
  for (const [version, dirs] of Object.entries(VERSIONS)) {
    const ctx = mkdtempSync(join(tmpdir(), `mr-fixture-${version}-`));
    for (const f of ['Dockerfile', 'app.mjs', 'migrate.mjs']) cpSync(join(FIXTURE_SRC, f), join(ctx, f));
    const target = join(ctx, 'migrations', version);
    mkdirSync(target, { recursive: true });
    for (const d of dirs) {
      for (const f of readdirSync(join(FIXTURE_SRC, 'migrations', d))) cpSync(join(FIXTURE_SRC, 'migrations', d, f), join(target, f));
    }
    await sh('docker', ['build', '--build-arg', `APP_VERSION=${version}`, '-t', `microrun-fixture:${version}`, ctx]);
    rmSync(ctx, { recursive: true, force: true });
  }
}

const tempDirs: string[] = [];

export function prepareFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mr-e2e-app-'));
  tempDirs.push(dir);
  for (const f of ['compose.yml', 'nginx.conf']) cpSync(join(FIXTURE_SRC, f), join(dir, f));
  return dir;
}

export async function startFixture(dir: string) {
  await sh('docker', ['compose', '-p', FIXTURE_PROJECT, '-f', 'compose.yml', 'down', '-v'], { cwd: dir }).catch(() => {});
  await sh('docker', ['compose', '-p', FIXTURE_PROJECT, '-f', 'compose.yml', 'up', '-d', '--wait'], { cwd: dir });
  await waitFor(async () => (await fetch(`${APP_URL}/health`)).ok, 60_000);
}

export async function startMicrorun(fixtureDir: string) {
  await sh('docker', ['rm', '-f', MICRORUN_CONTAINER]).catch(() => {});
  await sh('docker', [
    'run', '-d', '--name', MICRORUN_CONTAINER, '-p', '18081:8080',
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${fixtureDir}:${fixtureDir}`,
    '-e', `MICRORUN_ADMIN_USER=${ADMIN_USER}`,
    '-e', `MICRORUN_ADMIN_PASSWORD=${ADMIN_PASSWORD}`,
    '-e', `MICRORUN_SECRET_KEY=${SECRET_KEY}`,
    '-e', `MICRORUN_PUBLIC_URL=${MICRORUN_URL}`,
    'microrun/microrun:e2e',
  ]);
  await waitFor(async () => (await fetch(`${MICRORUN_URL}/login`)).status === 200, 60_000);
}

export async function psql(fixtureDir: string, query: string): Promise<string> {
  const { stdout } = await sh('docker', ['compose', '-p', FIXTURE_PROJECT, '-f', 'compose.yml', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-tAc', query], { cwd: fixtureDir });
  return stdout.trim();
}

export function cliDeploy(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise(resolvePromise => {
    const child = spawn(process.execPath, [join(ROOT, 'packages/agent/dist/bin.js'), 'deploy', ...args], {
      env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: '' },
    });
    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    child.on('close', code => resolvePromise({ code: code ?? -1, output }));
  });
}

export function startNpmAgent(token: string): ChildProcess {
  const stateDir = mkdtempSync(join(tmpdir(), 'mr-e2e-agent-'));
  tempDirs.push(stateDir);
  return spawn(process.execPath, [join(ROOT, 'packages/agent/dist/bin.js'), 'agent', '--url', MICRORUN_URL, '--token', token, '--state-dir', stateDir], { stdio: 'ignore' });
}

export async function listeningPids(): Promise<string> {
  const { stdout } = await sh('ss', ['-ltnpH']);
  return stdout;
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${APP_URL}${path}`);
  return res.json() as Promise<T>;
}

export async function postJson(path: string, body: unknown) {
  return fetch(`${APP_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try { if (await check()) return; } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`timed out after ${timeoutMs} ms${last ? `: ${String(last)}` : ''}`);
}

export async function teardown(fixtureDir: string | undefined, agent: ChildProcess | undefined) {
  agent?.kill();
  await sh('docker', ['rm', '-f', MICRORUN_CONTAINER]).catch(() => {});
  if (fixtureDir) await sh('docker', ['compose', '-p', FIXTURE_PROJECT, '-f', 'compose.yml', 'down', '-v'], { cwd: fixtureDir }).catch(() => {});
  await sh('docker', ['rm', '-f', 'microrun-proxy']).catch(() => {});
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
}
