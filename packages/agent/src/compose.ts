import { existsSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AgentError, type ComposeRef, type ResultMap } from '@microrun/core/protocol';
import { docker } from './docker.ts';

export const OVERRIDE_FILE = 'docker-compose.microrun.yml';
const RUN_TIMEOUT_MS = 15 * 60 * 1000;

export interface ComposePort { target: number; published?: string | number; host_ip?: string; protocol?: string }
export interface ComposeService {
  image?: string;
  container_name?: string;
  healthcheck?: { test?: string[] | string; disable?: boolean };
  ports?: ComposePort[];
  networks?: Record<string, unknown> | null;
  environment?: Record<string, string | null> | null;
  deploy?: { replicas?: number } | null;
  scale?: number;
}
export interface ComposeModel {
  name?: string;
  services: Record<string, ComposeService>;
  networks?: Record<string, { name?: string } | null>;
}

export function composeArgs(c: ComposeRef, extra: string[] = []): string[] {
  const override = join(c.dir, OVERRIDE_FILE);
  return [
    'compose', '-p', c.project, '--project-directory', c.dir,
    ...c.files.flatMap((f) => ['-f', resolve(c.dir, f)]),
    ...(existsSync(override) ? ['-f', override] : []),
    ...extra,
  ];
}

export async function composeConfig(c: ComposeRef): Promise<ComposeModel> {
  const r = await docker(composeArgs(c, ['config', '--format', 'json']));
  if (r.code !== 0) throw new Error(`docker compose config failed: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout) as ComposeModel;
}

export function serviceNetwork(model: ComposeModel, service: string, project: string): string {
  const key = Object.keys(model.services[service]?.networks ?? {})[0];
  if (!key) return `${project}_default`;
  return model.networks?.[key]?.name ?? `${project}_${key}`;
}

export function serviceEnv(model: ComposeModel, service: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(model.services[service]?.environment ?? {})) {
    if (typeof v === 'string') env[k] = v;
  }
  return env;
}

function overrideYaml(images: Record<string, string>): string {
  const services = Object.fromEntries(Object.entries(images).map(([svc, image]) => [svc, { image }]));
  return `${JSON.stringify({ services }, null, 2)}\n`;
}

export async function writeOverride(c: ComposeRef, images: Record<string, string>): Promise<void> {
  const path = join(c.dir, OVERRIDE_FILE);
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, overrideYaml(images));
  await rename(tmp, path);
}

const SECRET_NAME = /(URL|URI|DSN|CONN|PASS|PASSWORD|SECRET|TOKEN|KEY|CRED|AUTH)/i;

function secretValues(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_NAME.test(k) && v.length >= 6)
    .map(([, v]) => v)
    .sort((a, b) => b.length - a.length);
}

function envFileLine(k: string, v: string): string {
  if (!/['\n\r]/.test(v)) return `${k}='${v}'`;
  const escaped = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')
    .replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return `${k}="${escaped}"`;
}

export async function runOneOff(
  c: ComposeRef,
  p: { service: string; image: string; cmd: string; args: string[]; env: Record<string, string>; timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; log: string }> {
  const id = randomBytes(6).toString('hex');
  const tmp = join(c.dir, `.microrun-run-${id}.yml`);
  const envFile = join(c.dir, `.microrun-env-${id}`);
  const name = `microrun-run-${id}`;
  const hasEnv = Object.keys(p.env).length > 0;
  try {
    await writeFile(tmp, overrideYaml({ [p.service]: p.image }));
    if (hasEnv) {
      const body = Object.entries(p.env).map(([k, v]) => envFileLine(k, v)).join('\n');
      await writeFile(envFile, `${body}\n`, { mode: 0o600 });
    }
    const r = await docker(composeArgs(c, [
      '-f', tmp, 'run', '--rm', '--no-deps', '-T', '--name', name,
      ...(hasEnv ? ['--env-from-file', envFile] : []),
      p.service, '/bin/sh', '-c', `${p.cmd} "$@"`, 'sh', ...p.args,
    ]), { redact: secretValues(p.env), timeoutMs: p.timeoutMs ?? RUN_TIMEOUT_MS });
    if (r.timedOut) {
      await docker(['rm', '-f', name]);
      throw new AgentError('MIGRATION_FAILED', { reason: 'timeout', cmd: p.cmd.trim().split(/\s+/)[0] ?? '' });
    }
    return { exitCode: r.code, stdout: r.stdout, log: r.stderr };
  } finally {
    await rm(tmp, { force: true });
    await rm(envFile, { force: true });
  }
}

function healthTest(test: string[] | string | null | undefined): string[] {
  return Array.isArray(test) ? test : test ? [test] : [];
}

export async function hasHealthcheck(s: ComposeService, image: string | null | undefined = s.image): Promise<boolean> {
  if (s.healthcheck?.disable) return false;
  const own = healthTest(s.healthcheck?.test);
  if (own.length > 0) return own[0] !== 'NONE';
  if (!image) return false;
  const r = await docker(['image', 'inspect', '--format', '{{json .Config.Healthcheck}}', image]);
  if (r.code !== 0) return false;
  const test = healthTest((JSON.parse(r.stdout.trim() || 'null') as { Test?: string[] } | null)?.Test);
  return test.length > 0 && test[0] !== 'NONE';
}

export async function inspectEnv(c: ComposeRef, dbUrlEnv: string): Promise<ResultMap['inspectEnv']> {
  const model = await composeConfig(c);
  return {
    services: await Promise.all(Object.entries(model.services).map(async ([name, s]) => ({
      name,
      image: s.image ?? null,
      replicas: s.deploy?.replicas ?? s.scale ?? 1,
      hasHealthcheck: await hasHealthcheck(s),
      containerName: s.container_name ?? null,
      hostPorts: (s.ports ?? []).map((p) => `${p.host_ip ? `${p.host_ip}:` : ''}${p.published ?? ''}:${p.target}${p.protocol && p.protocol !== 'tcp' ? `/${p.protocol}` : ''}`),
      hasDbUrl: Boolean(serviceEnv(model, name)[dbUrlEnv]),
    }))),
  };
}
