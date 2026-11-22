import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentError, type ComposeRef, type ServiceSpec } from '@microrun/core/protocol';
import { inspectEnv, runOneOff } from './compose.ts';
import { docker } from './docker.ts';
import { switchServices, type ProxyHook } from './switch.ts';

const project = `mrt-switch-${randomBytes(3).toString('hex')}`;
const images = { a: 'mr-t:a', b: 'mr-t:b', bad: 'mr-t:bad', hc: 'mr-t:hc', exit: 'mr-t:exit' };

let dir = '';
let cwdBefore = '';
let runCwd = '';
let ref: ComposeRef;
let edgeUrl = '';

function sh(cmd: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function dk(args: string[], input?: string): Promise<string> {
  const r = await sh('docker', args, input);
  if (r.code !== 0) throw new Error(`docker ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function compose(...extra: string[]): string[] {
  return ['compose', '-p', project, '--project-directory', dir, '-f', join(dir, 'compose.yml'), ...extra];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function envFiles(): Promise<string[]> {
  const found: string[] = [];
  for (const d of [dir, tmpdir()]) {
    for (const f of await readdir(d).catch(() => [] as string[])) {
      if (f.startsWith('.microrun-env-')) found.push(join(d, f));
    }
  }
  return found;
}

async function processesExposing(value: string): Promise<string[]> {
  const hits: string[] = [];
  for (const pid of (await readdir('/proc')).filter((x) => /^\d+$/.test(x))) {
    for (const part of ['cmdline', 'environ']) {
      const data = await readFile(`/proc/${pid}/${part}`).catch(() => null);
      if (data?.includes(value)) hits.push(`${pid}/${part}`);
    }
  }
  return hits;
}

async function imageId(tag: string): Promise<string> {
  return (await dk(['image', 'inspect', '--format', '{{.Id}}', tag])).trim();
}

async function serviceContainers(service: string): Promise<{ id: string; name: string; image: string; health: string }[]> {
  const ids = (await dk(['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', `label=com.docker.compose.service=${service}`])).split('\n').filter(Boolean);
  if (ids.length === 0) return [];
  const out = await dk(['inspect', '--format', '{{.Id}} {{.Name}} {{.Image}} {{json .State}}', ...ids]);
  return out.split('\n').filter(Boolean).map((l) => {
    const [id, name, image, ...state] = l.split(' ');
    const health = (JSON.parse(state.join(' ')) as { Health?: { Status: string } }).Health?.Status ?? 'none';
    return { id: id!, name: name!.replace(/^\//, ''), image: image!, health };
  });
}

const appContainers = () => serviceContainers('app');

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await cond()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function request(): Promise<boolean> {
  try {
    const res = await fetch(edgeUrl, { signal: AbortSignal.timeout(2000) });
    await res.text();
    return res.ok;
  } catch {
    return false;
  }
}

function dockerfile(variant: string, cmd?: string[], healthcheck = false): string {
  return [
    'FROM traefik/whoami:v1.10',
    'COPY --from=busybox:1.36.1-uclibc /bin/busybox /bin/busybox',
    `LABEL mr-t.variant=${variant}`,
    ...(cmd ? [`CMD ${JSON.stringify(cmd)}`] : []),
    ...(healthcheck ? ['HEALTHCHECK --interval=1s --timeout=2s --retries=3 CMD ["/bin/busybox", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:80/health"]'] : []),
  ].join('\n');
}

const composeYml = `services:
  app:
    image: ${images.a}
    init: true
    deploy:
      replicas: 2
    healthcheck:
      test: ["CMD", "/bin/busybox", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:80/health"]
      interval: 1s
      timeout: 2s
      retries: 3
  worker:
    image: ${images.a}
    init: true
  imghc:
    image: ${images.hc}
    init: true
  nohc:
    image: ${images.hc}
    init: true
    healthcheck:
      disable: true
  edge:
    image: nginx:1.27-alpine
    ports:
      - "127.0.0.1::80"
    volumes:
      - ./edge.conf:/etc/nginx/conf.d/default.conf:ro
`;

const edgeConf = `server {
  listen 80;
  resolver 127.0.0.11 valid=1s ipv6=off;
  location / {
    set $up http://app:80;
    proxy_pass $up;
    proxy_next_upstream error timeout http_502 http_503;
    proxy_connect_timeout 1s;
  }
}
`;

const rolling = (image: string): ServiceSpec[] => [{ name: 'app', strategy: 'rolling', image }];

beforeAll(async () => {
  await dk(['pull', '-q', 'traefik/whoami:v1.10']);
  await dk(['pull', '-q', 'nginx:1.27-alpine']);
  await dk(['pull', '-q', 'busybox:1.36.1-uclibc']);
  await dk(['build', '-q', '-t', images.a, '-'], dockerfile('a'));
  await dk(['build', '-q', '-t', images.b, '-'], dockerfile('b'));
  await dk(['build', '-q', '-t', images.bad, '-'], dockerfile('bad', ['--port', '81']));
  await dk(['build', '-q', '-t', images.hc, '-'], dockerfile('hc', undefined, true));
  await dk(['build', '-q', '-t', images.exit, '-'], dockerfile('exit', ['--no-such-flag']));

  dir = await mkdtemp(join(tmpdir(), 'mrt-switch-'));
  await writeFile(join(dir, 'compose.yml'), composeYml);
  await writeFile(join(dir, 'edge.conf'), edgeConf);
  ref = { project, dir, files: ['compose.yml'] };
  cwdBefore = process.cwd();
  runCwd = await mkdtemp(join(tmpdir(), 'mrt-cwd-'));
  process.chdir(runCwd);

  await dk(compose('up', '-d', '--wait'));
  const port = (await dk(compose('port', 'edge', '80'))).trim();
  edgeUrl = `http://${port}/`;
  await waitFor(request, 30_000, 'edge to answer');
});

afterAll(async () => {
  if (cwdBefore) process.chdir(cwdBefore);
  if (runCwd) await rm(runCwd, { recursive: true, force: true });
  if (dir) {
    await sh('docker', compose('down', '-v', '--remove-orphans', '-t', '1'));
    const left = (await sh('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])).stdout
      .split('\n').filter(Boolean);
    if (left.length) await sh('docker', ['rm', '-f', '-v', ...left]);
    const nets = (await sh('docker', ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])).stdout
      .split('\n').filter(Boolean);
    if (nets.length) await sh('docker', ['network', 'rm', ...nets]);
    const vols = (await sh('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])).stdout
      .split('\n').filter(Boolean);
    if (vols.length) await sh('docker', ['volume', 'rm', '-f', ...vols]);
    await rm(dir, { recursive: true, force: true });
  }
  await sh('docker', ['rmi', '-f', ...Object.values(images)]);
});

describe('switchServices (real Docker)', () => {
  it('rolls a→b with zero failed requests through the edge', async () => {
    const b = await imageId(images.b);
    let stop = false;
    let total = 0;
    let errors = 0;
    const load = (async () => {
      while (!stop) {
        const started = Date.now();
        total++;
        if (!(await request())) errors++;
        await sleep(Math.max(0, 50 - (Date.now() - started)));
      }
    })();

    let result: { replaced: string[] };
    try {
      result = await switchServices(ref, rolling(images.b), 60, null);
      await sleep(2000);
    } finally {
      stop = true;
      await load;
    }

    expect(result.replaced).toEqual(['app']);
    expect(total).toBeGreaterThan(20);
    expect(errors).toBe(0);
    const after = await appContainers();
    expect(after).toHaveLength(2);
    expect(after.every((c) => c.image === b)).toBe(true);
  });

  it('a bad image fails with HEALTHCHECK_FAILED and leaves the old containers serving', async () => {
    const b = await imageId(images.b);
    const before = (await appContainers()).map((c) => c.id).sort();
    expect(before).toHaveLength(2);

    const err = await switchServices(ref, rolling(images.bad), 15, null).then(
      () => { throw new Error('switchServices resolved'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe('HEALTHCHECK_FAILED');
    expect((err as AgentError).params).toEqual({ svc: 'app' });

    const after = await appContainers();
    expect(after.map((c) => c.id).sort()).toEqual(before);
    expect(after.every((c) => c.image === b)).toBe(true);
    expect(await request()).toBe(true);
  });

  it('a second call after a killed switch finishes with N containers on the target', async () => {
    const a = await imageId(images.a);
    const old = (await appContainers()).map((c) => c.id);
    expect(old).toHaveLength(2);

    await writeFile(join(dir, 'docker-compose.microrun.yml'), `services:\n  app:\n    image: ${images.a}\n`);
    await dk([...compose('-f', join(dir, 'docker-compose.microrun.yml')),
      'up', '-d', '--no-deps', '--no-recreate', '--scale', 'app=4', 'app']);
    await waitFor(async () => {
      const cs = await appContainers();
      return cs.filter((c) => c.image === a && c.health === 'healthy').length === 2;
    }, 60_000, 'the half-switched new containers to be healthy');
    expect(await appContainers()).toHaveLength(4);

    const result = await switchServices(ref, rolling(images.a), 60, null);

    expect(result.replaced).toEqual(['app']);
    const after = await appContainers();
    expect(after).toHaveLength(2);
    expect(after.every((c) => c.image === a)).toBe(true);
    expect(after.some((c) => old.includes(c.id))).toBe(false);
    expect(await request()).toBe(true);
  });

  it('an image whose containers exit at once fails with HEALTHCHECK_FAILED, leaves no container behind, and the next switch succeeds', async () => {
    const a = await imageId(images.a);
    const b = await imageId(images.b);
    const exit = await imageId(images.exit);
    const before = (await appContainers()).map((c) => c.id).sort();
    expect(before).toHaveLength(2);

    const err = await switchServices(ref, rolling(images.exit), 15, null).then(
      () => { throw new Error('switchServices resolved'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe('HEALTHCHECK_FAILED');
    expect((err as AgentError).params).toEqual({ svc: 'app' });

    const all = (await dk(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`,
      '--filter', 'label=com.docker.compose.service=app'])).split('\n').filter(Boolean);
    const allImages = (await dk(['inspect', '--format', '{{.Image}}', ...all])).split('\n').filter(Boolean);
    expect(allImages).not.toContain(exit);
    expect((await appContainers()).map((c) => c.id).sort()).toEqual(before);
    expect((await appContainers()).every((c) => c.image === a)).toBe(true);

    const result = await switchServices(ref, rolling(images.b), 60, null);
    expect(result.replaced).toEqual(['app']);
    const after = await appContainers();
    expect(after).toHaveLength(2);
    expect(after.every((c) => c.image === b && c.health === 'healthy')).toBe(true);
  });

  it('an up that cannot get the image throws IMAGE_PULL_FAILED with the compose stderr and keeps the old containers', async () => {
    const b = await imageId(images.b);
    const before = (await appContainers()).map((c) => c.id).sort();
    expect(before).toHaveLength(2);

    const err = await switchServices(ref, rolling('mr-t:missing'), 15, null).then(
      () => { throw new Error('switchServices resolved'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe('IMAGE_PULL_FAILED');
    expect((err as AgentError).params.svc).toBe('app');
    expect(String((err as AgentError).params.stderr)).toMatch(/mr-t/);

    const after = await appContainers();
    expect(after.map((c) => c.id).sort()).toEqual(before);
    expect(after.every((c) => c.image === b)).toBe(true);
    expect(await request()).toBe(true);
  });

  it('IMAGE_PULL_FAILED keeps only the last 2048 chars of a long compose stderr', async () => {
    const vars = Array.from({ length: 60 }, (_, i) => `      N${i}: "\${MR_T_UNSET_VARIABLE_NUMBER_${i}}"`);
    await writeFile(join(dir, 'noise.yml'), ['services:', '  noise:', `    image: ${images.a}`, '    environment:', ...vars, ''].join('\n'));
    const noisy: ComposeRef = { project, dir, files: ['compose.yml', 'noise.yml'] };
    const before = (await appContainers()).map((c) => c.id).sort();

    const err = await switchServices(noisy, rolling('mr-t:missing'), 15, null).then(
      () => { throw new Error('switchServices resolved'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe('IMAGE_PULL_FAILED');
    const stderr = String((err as AgentError).params.stderr);
    expect(stderr.startsWith('…')).toBe(true);
    expect(stderr.length).toBeLessThanOrEqual(2049);
    expect(stderr.length).toBeGreaterThan(2000);
    expect(stderr).toMatch(/pull access denied for mr-t/);
    expect((await appContainers()).map((c) => c.id).sort()).toEqual(before);
  });

  it('calls addUpstreams with the new container names before stopping the old ones, removeUpstreams after with the old names', async () => {
    const a = await imageId(images.a);
    const old = await appContainers();
    expect(old).toHaveLength(2);
    const oldIds = new Set(old.map((c) => c.id));
    const oldRunning = async () => (await appContainers()).filter((c) => oldIds.has(c.id)).length;
    const events: { kind: string; svc: string; containers: string[]; oldRunning: number }[] = [];
    const proxy: ProxyHook = {
      async addUpstreams(svc, containers) {
        events.push({ kind: 'add', svc: svc.name, containers: [...containers].sort(), oldRunning: await oldRunning() });
      },
      async removeUpstreams(svc, containers) {
        events.push({ kind: 'remove', svc: svc.name, containers: [...containers].sort(), oldRunning: await oldRunning() });
      },
    };

    await switchServices(ref, rolling(images.a), 60, proxy);

    const after = await appContainers();
    expect(after).toHaveLength(2);
    expect(after.every((c) => c.image === a)).toBe(true);
    expect(events).toEqual([
      { kind: 'add', svc: 'app', containers: after.map((c) => c.name).sort(), oldRunning: 2 },
      { kind: 'remove', svc: 'app', containers: old.map((c) => c.name).sort(), oldRunning: 0 },
    ]);
  });

  it('recreate a→b without a healthcheck ends with the container running b', async () => {
    const b = await imageId(images.b);
    const result = await switchServices(ref, [{ name: 'worker', strategy: 'recreate', image: images.b }], 30, null);

    expect(result.replaced).toEqual(['worker']);
    const after = await serviceContainers('worker');
    expect(after).toHaveLength(1);
    expect(after[0]!.image).toBe(b);
  });

  it('recreate to an image whose container exits rolls back to the previous image and throws HEALTHCHECK_FAILED', async () => {
    const b = await imageId(images.b);
    const err = await switchServices(ref, [{ name: 'worker', strategy: 'recreate', image: images.exit }], 30, null).then(
      () => { throw new Error('switchServices resolved'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe('HEALTHCHECK_FAILED');
    expect((err as AgentError).params).toEqual({ svc: 'worker' });

    await waitFor(async () => {
      const cs = await serviceContainers('worker');
      return cs.length === 1 && cs[0]!.image === b;
    }, 30_000, 'worker to run the previous image');
  });

  it('runOneOff returns the command exit code and stdout', async () => {
    const echo = await runOneOff(ref, { service: 'edge', image: 'nginx:1.27-alpine', cmd: 'echo', args: ['hello', 'world'], env: {} });
    expect(echo.exitCode).toBe(0);
    expect(echo.stdout.trim()).toBe('hello world');

    const env = await runOneOff(ref, { service: 'edge', image: 'nginx:1.27-alpine', cmd: 'printenv MR_T_PASSWORD >&2; printenv', args: ['MR_T_PASSWORD'], env: { MR_T_PASSWORD: 'v-42-secret' } });
    expect(env.exitCode).toBe(0);
    expect(env.stdout.trim()).toBe('***');
    expect(env.log).toContain('***');
    expect(env.log).not.toContain('v-42-secret');

    const fail = await runOneOff(ref, { service: 'edge', image: 'nginx:1.27-alpine', cmd: 'exit', args: ['3'], env: {} });
    expect(fail.exitCode).toBe(3);

    const leftovers = (await sh('ls', ['-a', dir])).stdout.split('\n').filter((f) => f.startsWith('.microrun-run-'));
    expect(leftovers).toEqual([]);
  });

  it('runOneOff redacts only secret-named env values of 6+ chars, so protocol lines stay intact', async () => {
    const dbUrl = 'postgres://mr:s3cr3t-pw@db:5432/app';
    const r = await runOneOff(ref, {
      service: 'edge',
      image: 'nginx:1.27-alpine',
      cmd: `echo '{"rule":"x","count":5432}'; echo '{"rule":"y","count":1}'; printenv MR_DB_URL MR_MODE MR_PORT; printenv MR_T_SECRET >&2; printenv MR_MODE >&2`,
      args: [],
      env: { MR_PORT: '5432', MR_DB_URL: dbUrl, MR_MODE: 'production', MR_API_KEY: '1', MR_T_SECRET: 'hunter22' },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual([
      '{"rule":"x","count":5432}',
      '{"rule":"y","count":1}',
      '***',
      'production',
      '5432',
    ]);
    expect(r.log).toContain('***');
    expect(r.log).toContain('production');
    expect(r.log).not.toContain('hunter22');
  });

  it('runOneOff passes env through a 0600 env file, never through the docker CLI env or argv', async () => {
    const mark = `mr-mark-${randomBytes(6).toString('hex')}`;
    const seen = new Map<string, number>();
    const exposed = new Set<string>();
    let running = true;
    const watch = (async () => {
      while (running) {
        for (const f of await envFiles()) {
          const st = await stat(f).catch(() => null);
          if (st) seen.set(f, st.mode & 0o777);
        }
        for (const hit of await processesExposing(mark)) exposed.add(hit);
        await sleep(100);
      }
    })();

    let r: { exitCode: number; stdout: string; log: string };
    try {
      r = await runOneOff(ref, {
        service: 'edge',
        image: 'nginx:1.27-alpine',
        cmd: 'echo "$DOCKER_HOST|$PATH|$MR_T_MARK"; /bin/sleep 3',
        args: [],
        env: { DOCKER_HOST: 'tcp://127.0.0.1:1', PATH: '/nonexistent', MR_T_MARK: mark },
      });
    } finally {
      running = false;
      await watch;
    }

    expect(r.log).not.toMatch(/ENOENT|Cannot connect|not found/);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(`tcp://127.0.0.1:1|/nonexistent|${mark}`);
    expect([...exposed]).toEqual([]);
    expect(seen.size).toBeGreaterThan(0);
    expect([...seen.values()].every((m) => m === 0o600)).toBe(true);
    expect(await envFiles()).toEqual([]);
  });

  it('runOneOff caps a 10 MiB+ stdout with a [truncated] marker', async () => {
    const r = await runOneOff(ref, { service: 'edge', image: 'nginx:1.27-alpine', cmd: "head -c 11000000 /dev/zero | tr '\\0' a", args: [], env: {} });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.endsWith('\n[truncated]')).toBe(true);
    expect(r.stdout.length).toBe(10 * 1024 * 1024 + '\n[truncated]'.length);
    expect(/^a+$/.test(r.stdout.slice(0, 10 * 1024 * 1024))).toBe(true);
  });

  it('runOneOff past its timeout throws MIGRATION_FAILED with reason timeout and the command name', async () => {
    const err = await runOneOff(ref, { service: 'edge', image: 'nginx:1.27-alpine', cmd: 'sleep 30', args: [], env: { MR_T_X: 'y' }, timeoutMs: 1500 }).then(
      () => { throw new Error('runOneOff resolved'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe('MIGRATION_FAILED');
    expect((err as AgentError).params.reason).toBe('timeout');
    expect((err as AgentError).params.cmd).toBe('sleep');
    expect(await envFiles()).toEqual([]);
  });

  it('docker() reports a timeout kill in stderr', async () => {
    const r = await docker(['events'], { timeoutMs: 500 });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('timeout after 500 ms');
  });

  it('inspectEnv reports hasHealthcheck and hostPorts per service', async () => {
    const res = await inspectEnv(ref, 'DATABASE_URL');
    const app = res.services.find((s) => s.name === 'app');
    const edge = res.services.find((s) => s.name === 'edge');
    expect(app).toBeDefined();
    expect(edge).toBeDefined();
    expect(app!.hasHealthcheck).toBe(true);
    expect(edge!.hasHealthcheck).toBe(false);
    expect(app!.hostPorts).toEqual([]);
    expect(edge!.hostPorts).toHaveLength(1);
  });

  it('inspectEnv counts an image-level HEALTHCHECK unless compose disables it', async () => {
    const res = await inspectEnv(ref, 'DATABASE_URL');
    expect(res.services.find((s) => s.name === 'imghc')?.hasHealthcheck).toBe(true);
    expect(res.services.find((s) => s.name === 'nohc')?.hasHealthcheck).toBe(false);
    expect(res.services.find((s) => s.name === 'worker')?.hasHealthcheck).toBe(false);
  });
});
