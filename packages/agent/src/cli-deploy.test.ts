import { describe, expect, it } from 'vitest';
import { deployRequest, REJECT_CODES, type OperationEvent } from '@microrun/core/protocol';
import { i18n } from '@microrun/core/i18n';
import { runDeploy } from './cli-deploy.ts';

const URL_BASE = 'http://microrun.test';
const SHA = 'aaaaaaa';

const baseArgs = [
  '--url', URL_BASE,
  '--token', 'tok-1',
  '--image', 'web=registry/web:1',
  '--commit', SHA,
  '--branch', 'main',
  '--author', 'Ann',
  '--message', 'fix it',
  '--lang', 'en',
];

function without(args: string[], flag: string): string[] {
  const i = args.indexOf(flag);
  return [...args.slice(0, i), ...args.slice(i + 2)];
}

type Call = { url: string; init: RequestInit | undefined };
type Reply = Response | Error;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sse(events: OperationEvent[], chunkSize = Infinity): Response {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += Math.min(chunkSize, bytes.length)) chunks.push(bytes.slice(i, i + chunkSize));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const done = (
  status: 'succeeded' | 'failed' | 'rejected',
  code: Extract<OperationEvent, { type: 'done' }>['code'] = null,
  message = '',
): OperationEvent => ({ type: 'done', status, code, message, params: {} });

function harness(replies: Reply[], gitOut: Record<string, string> = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const gitCalls: string[][] = [];
  const output: string[] = [];
  const queue = [...replies];
  const deps = {
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const next = queue.shift();
      if (!next) throw new Error('unexpected fetch');
      if (next instanceof Error) throw next;
      return next;
    }) as typeof fetch,
    git: async (args: string[]) => {
      gitCalls.push(args);
      return gitOut[args.join(' ')] ?? '';
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    out: (s: string) => output.push(s),
    err: (s: string) => output.push(s),
  };
  return { deps, calls, sleeps, gitCalls, text: () => output.join('\n') };
}

const accepted = (id = 'op-1') => json(202, { operationId: id });
const busy = () => json(409, { code: 'ENV_BUSY', message: 'Environment is busy', params: {} });

function postBody(call: Call): unknown {
  return JSON.parse(String(call.init?.body));
}

function header(call: Call, name: string): string | null {
  return new Headers(call.init?.headers).get(name);
}

describe('runDeploy request', () => {
  it('posts the release to /api/v1/deploy with bearer token, language and a valid body', async () => {
    const h = harness([accepted(), sse([done('succeeded')])]);
    await runDeploy(baseArgs, {}, h.deps);
    const post = h.calls[0]!;
    expect(post.url).toBe(`${URL_BASE}/api/v1/deploy`);
    expect(post.init?.method).toBe('POST');
    expect(header(post, 'authorization')).toBe('Bearer tok-1');
    expect(header(post, 'accept-language')).toBe('en');
    expect(header(post, 'content-type')).toContain('application/json');
    expect(deployRequest.parse(postBody(post))).toEqual({
      images: { web: 'registry/web:1' },
      commit: SHA,
      branch: 'main',
      author: 'Ann',
      message: 'fix it',
    });
  });

  it('sends the --lang value as Accept-Language', async () => {
    const h = harness([accepted(), sse([done('succeeded')])]);
    await runDeploy([...without(baseArgs, '--lang'), '--lang', 'de'], {}, h.deps);
    expect(header(h.calls[0]!, 'accept-language')).toBe('de');
  });

  it('collects repeated svc=ref images into one map', async () => {
    const h = harness([accepted(), sse([done('succeeded')])]);
    await runDeploy([...without(baseArgs, '--image'), '--image', 'web=r/web:1', '--image', 'worker=r/worker:2'], {}, h.deps);
    expect((postBody(h.calls[0]!) as { images: unknown }).images).toEqual({ web: 'r/web:1', worker: 'r/worker:2' });
  });

  it('turns a bare --image into {"*": ref}', async () => {
    const h = harness([accepted(), sse([done('succeeded')])]);
    await runDeploy([...without(baseArgs, '--image'), '--image', 'registry/app:7'], {}, h.deps);
    expect((postBody(h.calls[0]!) as { images: unknown }).images).toEqual({ '*': 'registry/app:7' });
  });

  it('rejects mixing bare and svc=ref images without calling the server', async () => {
    const h = harness([]);
    const code = await runDeploy([...without(baseArgs, '--image'), '--image', 'web=r/web:1', '--image', 'r/other:2'], {}, h.deps);
    expect(code).toBeGreaterThan(0);
    expect(h.calls).toHaveLength(0);
  });

  it('reads url and token from MICRORUN_URL and MICRORUN_DEPLOY_TOKEN', async () => {
    const h = harness([accepted(), sse([done('succeeded')])]);
    const args = without(without(baseArgs, '--url'), '--token');
    const code = await runDeploy(args, { MICRORUN_URL: 'http://from-env.test', MICRORUN_DEPLOY_TOKEN: 'env-tok' }, h.deps);
    expect(code).toBe(0);
    expect(h.calls[0]!.url).toBe('http://from-env.test/api/v1/deploy');
    expect(header(h.calls[0]!, 'authorization')).toBe('Bearer env-tok');
  });

  it('defaults author and message from git log -1', async () => {
    const h = harness([accepted(), sse([done('succeeded')])], {
      'log -1 --format=%an': 'Git Author\n',
      'log -1 --format=%s': 'git subject\n',
    });
    const args = without(without(baseArgs, '--author'), '--message');
    await runDeploy(args, {}, h.deps);
    const body = postBody(h.calls[0]!) as { author: string; message: string };
    expect(body.author).toBe('Git Author');
    expect(body.message).toBe('git subject');
  });

  it('does not ask git when --author and --message are given', async () => {
    const h = harness([accepted(), sse([done('succeeded')])]);
    await runDeploy(baseArgs, {}, h.deps);
    expect(h.gitCalls).toHaveLength(0);
  });
});

describe('runDeploy usage errors', () => {
  it.each(['--url', '--token', '--image', '--commit', '--branch'])('returns 3 and prints usage when %s is missing', async (flag) => {
    const h = harness([]);
    const code = await runDeploy(without(baseArgs, flag), {}, h.deps);
    expect(code).toBe(3);
    expect(h.calls).toHaveLength(0);
    expect(h.text()).toContain(i18n('en').t('cli.usage'));
  });
});

describe('runDeploy event stream', () => {
  it('returns 0 on a succeeded stream and opens the operation events URL', async () => {
    const h = harness([accepted('op-42'), sse([{ type: 'step', step: 'pull', status: 'running' }, done('succeeded')])]);
    const code = await runDeploy(baseArgs, {}, h.deps);
    expect(code).toBe(0);
    expect(h.calls[1]!.url).toBe(`${URL_BASE}/api/v1/operations/op-42/events`);
    expect(h.calls[1]!.init?.method ?? 'GET').toBe('GET');
  });

  it('prints step and log events', async () => {
    const h = harness([
      accepted(),
      sse([
        { type: 'step', step: 'pull', status: 'running' },
        { type: 'log', line: 'layer abc123 pulled' },
        done('succeeded'),
      ]),
    ]);
    await runDeploy(baseArgs, {}, h.deps);
    expect(h.text()).toContain('pull');
    expect(h.text()).toContain('layer abc123 pulled');
  });

  it('parses events split across arbitrary chunk boundaries', async () => {
    const h = harness([
      accepted(),
      sse([{ type: 'log', line: 'split line here' }, done('failed', 'MIGRATION_FAILED', 'boom')], 7),
    ]);
    const code = await runDeploy(baseArgs, {}, h.deps);
    expect(h.text()).toContain('split line here');
    expect(code).toBe(1);
  });

  it('returns 1 when the stream ends failed with MIGRATION_FAILED', async () => {
    const h = harness([accepted(), sse([done('failed', 'MIGRATION_FAILED', 'expand_cmd exited with 1')])]);
    expect(await runDeploy(baseArgs, {}, h.deps)).toBe(1);
  });

  it('returns 2 and prints the code when the stream ends rejected with SCHEMA_DESTRUCTIVE', async () => {
    const h = harness([accepted(), sse([done('rejected', 'SCHEMA_DESTRUCTIVE', 'Column users.email would be dropped')])]);
    const code = await runDeploy(baseArgs, {}, h.deps);
    expect(code).toBe(2);
    expect(h.text()).toContain('SCHEMA_DESTRUCTIVE');
    expect(h.text()).toContain('users.email');
  });

  it.each(REJECT_CODES)('returns 2 for a done event with reject code %s', async (rejectCode) => {
    const h = harness([accepted(), sse([done('rejected', rejectCode, 'x')])]);
    expect(await runDeploy(baseArgs, {}, h.deps)).toBe(2);
  });
});

describe('runDeploy server answers', () => {
  it('returns 2 for a 422 and prints "<code>: <message>"', async () => {
    const message = 'Commit bbbbbbb is blocked on production: it was rolled back';
    const h = harness([json(422, { code: 'COMMIT_BLOCKED', message, params: { sha: 'bbbbbbb' } })]);
    const code = await runDeploy([...without(baseArgs, '--commit'), '--commit', 'bbbbbbb'], {}, h.deps);
    expect(code).toBe(2);
    expect(h.text()).toContain(`COMMIT_BLOCKED: ${message}`);
    expect(h.text()).toContain('bbbbbbb');
  });

  it('returns 0 on a 200 ALREADY_ACTIVE without opening a stream', async () => {
    const h = harness([json(200, { code: 'ALREADY_ACTIVE' })]);
    const code = await runDeploy(baseArgs, {}, h.deps);
    expect(code).toBe(0);
    expect(h.calls).toHaveLength(1);
  });

  it('returns 3 and prints the message on 401', async () => {
    const h = harness([json(401, { code: 'UNAUTHORIZED', message: 'Invalid deploy token', params: {} })]);
    expect(await runDeploy(baseArgs, {}, h.deps)).toBe(3);
    expect(h.text()).toContain('Invalid deploy token');
  });

  it('returns 3 and prints the message on 503', async () => {
    const h = harness([json(503, { code: 'AGENT_OFFLINE', message: 'Agent is offline', params: {} })]);
    expect(await runDeploy(baseArgs, {}, h.deps)).toBe(3);
    expect(h.text()).toContain('Agent is offline');
  });

  it('returns 3 and prints cli.unreachable on a network error', async () => {
    const h = harness([new TypeError('fetch failed')]);
    expect(await runDeploy(baseArgs, {}, h.deps)).toBe(3);
    expect(h.text()).toContain(i18n('en').t('cli.unreachable'));
  });
});

describe('runDeploy ENV_BUSY', () => {
  it('sleeps 10 s between retries and succeeds once the environment frees up', async () => {
    const h = harness([busy(), busy(), accepted(), sse([done('succeeded')])]);
    const code = await runDeploy(baseArgs, {}, h.deps);
    expect(code).toBe(0);
    expect(h.sleeps).toEqual([10_000, 10_000]);
    expect(h.calls.filter((c) => c.url.endsWith('/api/v1/deploy'))).toHaveLength(3);
    expect(h.text()).toContain(i18n('en').t('cli.busy.wait', { s: 10 }));
  });

  it('returns 3 when the environment stays busy beyond --busy-timeout', async () => {
    const h = harness(Array.from({ length: 20 }, busy));
    const code = await runDeploy([...baseArgs, '--busy-timeout', '25'], {}, h.deps);
    expect(code).toBe(3);
    expect(h.sleeps.length).toBeGreaterThanOrEqual(2);
    expect(h.sleeps.length).toBeLessThanOrEqual(3);
    expect(h.sleeps.every((ms) => ms === 10_000)).toBe(true);
  });

  it('defaults --busy-timeout to 600 s', async () => {
    const h = harness(Array.from({ length: 100 }, busy));
    const code = await runDeploy(baseArgs, {}, h.deps);
    expect(code).toBe(3);
    expect(h.sleeps.length).toBeGreaterThanOrEqual(59);
    expect(h.sleeps.length).toBeLessThanOrEqual(60);
  });
});
