import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceSpec } from '@microrun/core/protocol';
import { docker } from './docker.ts';
import type { ProxyHook } from './switch.ts';

const NAME = 'microrun-proxy';
const IMAGE = 'caddy:2.10-alpine';

export type BundledProxyOptions = { httpPort?: number; httpsPort?: number; labels?: Record<string, string> };

async function must(args: string[]): Promise<string> {
  const r = await docker(args);
  if (r.code !== 0) throw new Error(`docker ${args[0]} ${args[1] ?? ''} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

export function bundledProxy(
  stateDir: string,
  opts: BundledProxyOptions = {},
): ProxyHook & { ensure(): Promise<void>; routes(): Record<string, string[]> } {
  const routesFile = join(stateDir, 'routes.json');
  const caddyfile = join(stateDir, 'Caddyfile');
  let table: Record<string, string[]> = {};
  try {
    table = JSON.parse(readFileSync(routesFile, 'utf8')) as Record<string, string[]>;
  } catch {
    table = {};
  }

  const tlsOff = () => process.env.MICRORUN_PROXY_TLS === 'off';

  function render(): string {
    const head = tlsOff() ? '{\n auto_https off\n}\n' : '';
    const sites = Object.entries(table).map(
      ([domain, ups]) =>
        `${tlsOff() ? `http://${domain}` : domain} {\n reverse_proxy ${ups.join(' ')} {\n  lb_policy round_robin\n  lb_try_duration 5s\n  lb_try_interval 250ms\n  health_uri /\n }\n}\n`,
    );
    return head + sites.join('');
  }

  function persist(): void {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(routesFile, JSON.stringify(table, null, 2));
    writeFileSync(caddyfile, render());
  }

  async function reload(): Promise<void> {
    let last = '';
    for (let i = 0; i < 40; i++) {
      const r = await docker(['exec', NAME, 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile']);
      if (r.code === 0) return;
      last = r.stderr.trim();
      await new Promise((res) => setTimeout(res, 250));
    }
    throw new Error(`caddy reload failed: ${last}`);
  }

  async function ensure(): Promise<void> {
    if ((await docker(['network', 'inspect', NAME])).code !== 0) {
      const r = await docker(['network', 'create', NAME]);
      if (r.code !== 0 && !r.stderr.includes('already exists')) throw new Error(`docker network create failed: ${r.stderr.trim()}`);
    }
    const state = await docker(['inspect', '--format', '{{.State.Running}}', NAME]);
    if (state.code === 0) {
      if (state.stdout.trim() !== 'true') await must(['start', NAME]);
      return;
    }
    mkdirSync(join(stateDir, 'caddy'), { recursive: true });
    persist();
    const labels = Object.entries(opts.labels ?? {}).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
    await must([
      'run', '-d', '--name', NAME, '--restart', 'unless-stopped', '--network', NAME,
      '-p', `${opts.httpPort ?? 80}:80`, '-p', `${opts.httpsPort ?? 443}:443`,
      '-v', `${join(stateDir, 'caddy')}:/data`, '-v', `${caddyfile}:/etc/caddy/Caddyfile`,
      ...labels, IMAGE,
    ]);
  }

  async function addUpstreams(svc: ServiceSpec, containers: string[]): Promise<void> {
    if (!svc.domain || !svc.port) return;
    for (const c of containers) {
      const r = await docker(['network', 'connect', NAME, c]);
      if (r.code !== 0 && !r.stderr.includes('already exists')) throw new Error(`docker network connect failed: ${r.stderr.trim()}`);
    }
    const ups = table[svc.domain] ?? [];
    for (const c of containers) {
      const up = `${c}:${svc.port}`;
      if (!ups.includes(up)) ups.push(up);
    }
    table[svc.domain] = ups;
    persist();
    await reload();
  }

  async function removeUpstreams(svc: ServiceSpec, containers: string[]): Promise<void> {
    if (!svc.domain || !svc.port) return;
    const gone = new Set(containers.map((c) => `${c}:${svc.port}`));
    const ups = (table[svc.domain] ?? []).filter((u) => !gone.has(u));
    if (ups.length) table[svc.domain] = ups;
    else delete table[svc.domain];
    persist();
    await reload();
  }

  return { ensure, addUpstreams, removeUpstreams, routes: () => structuredClone(table) };
}
