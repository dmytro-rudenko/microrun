import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import { REJECT_CODES, type ApiError, type DeployAccepted, type OperationEvent } from '@microrun/core/protocol';
import { fromEnvLocale, i18n } from '@microrun/core/i18n';

export interface DeployDeps {
  fetch?: typeof fetch;
  git?: (args: string[]) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

const RETRY_MS = 10_000;
const DEFAULT_BUSY_TIMEOUT_S = 600;

const defaultGit = (args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile('git', args, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

function parseImages(refs: string[]): Record<string, string> | null {
  if (refs.length === 0) return null;
  const mapped = refs.filter((r) => r.includes('='));
  if (mapped.length === 0) return refs.length === 1 ? { '*': refs[0]! } : null;
  if (mapped.length !== refs.length) return null;
  return Object.fromEntries(
    refs.map((r) => {
      const i = r.indexOf('=');
      return [r.slice(0, i), r.slice(i + 1)];
    }),
  );
}

async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (e: OperationEvent) => boolean): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let name: string | undefined;
  let data: string[] = [];
  const dispatch = (): boolean => {
    const type = name;
    const text = data.join('\n');
    const pending = data.length > 0;
    name = undefined;
    data = [];
    if (!pending || (type !== 'step' && type !== 'log' && type !== 'done')) return false;
    try {
      return onEvent({ ...JSON.parse(text), type } as OperationEvent);
    } catch {
      return false;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? '' : lines.pop()!;
    for (const line of lines) {
      if (line === '') {
        if (dispatch()) return true;
      } else if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (done) return dispatch();
  }
}

type Translate = ReturnType<typeof i18n>['t'];
type Values = ReturnType<typeof parseArgs>['values'];

interface Ctx {
  fetch: typeof fetch;
  out: (s: string) => void;
  err: (s: string) => void;
  t: Translate;
  url: string;
  headers: Record<string, string>;
}

const OPTIONS = {
  url: { type: 'string' },
  token: { type: 'string' },
  image: { type: 'string', multiple: true },
  commit: { type: 'string' },
  branch: { type: 'string' },
  author: { type: 'string' },
  message: { type: 'string' },
  'busy-timeout': { type: 'string' },
  lang: { type: 'string' },
} as const;

function parseDeployArgs(argv: string[]): Values {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: false }).values;
  } catch {
    return {};
  }
}

function unreachable(ctx: Ctx): number {
  ctx.err(ctx.t('cli.unreachable'));
  return 3;
}

function doneResult(ctx: Ctx, e: Extract<OperationEvent, { type: 'done' }>): number {
  if (e.status === 'succeeded') {
    ctx.out(ctx.t('cli.done.ok'));
    return 0;
  }
  const detail = e.code ? `${e.code}: ${e.message}` : e.message;
  if (detail) ctx.err(detail);
  const rejected = e.code !== null && REJECT_CODES.includes(e.code);
  ctx.err(ctx.t(rejected ? 'cli.done.rejected' : 'cli.done.failed'));
  return rejected ? 2 : 1;
}

async function streamOperation(ctx: Ctx, operationId: string): Promise<number> {
  let result: number | undefined;
  try {
    const res = await ctx.fetch(`${ctx.url}/api/v1/operations/${operationId}/events`, {
      headers: { ...ctx.headers, accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) return unreachable(ctx);
    await readEvents(res.body, (e) => {
      if (e.type === 'done') {
        result = doneResult(ctx, e);
        return true;
      }
      if (e.type === 'log') ctx.out(e.line);
      else if (e.status === 'running') ctx.out(ctx.t('cli.step', { step: e.step }));
      return false;
    });
  } catch {
    return unreachable(ctx);
  }
  if (result === undefined) {
    ctx.err(ctx.t('cli.streamClosed', { op: operationId }));
    return 3;
  }
  return result;
}

function answerCode(ctx: Ctx, status: number, body: Partial<ApiError> | null): number {
  ctx.err(body?.code ? `${body.code}: ${body.message ?? ''}` : `HTTP ${status}`);
  if (body?.code && REJECT_CODES.includes(body.code)) return 2;
  return status === 422 ? 1 : 3;
}

async function postDeploy(ctx: Ctx, payload: string, busyTimeoutS: number, sleep: (ms: number) => Promise<void>): Promise<number> {
  let waitedMs = 0;
  for (;;) {
    let res: Response;
    try {
      res = await ctx.fetch(`${ctx.url}/api/v1/deploy`, {
        method: 'POST',
        headers: { ...ctx.headers, 'content-type': 'application/json' },
        body: payload,
      });
    } catch {
      return unreachable(ctx);
    }
    if (res.status === 202) return streamOperation(ctx, ((await res.json()) as DeployAccepted).operationId);
    const body = (await res.json().catch(() => null)) as Partial<ApiError> | null;
    if (res.status === 200 && body?.code === 'ALREADY_ACTIVE') {
      ctx.out(ctx.t('cli.done.ok'));
      return 0;
    }
    const busy = res.status === 409 && body?.code === 'ENV_BUSY';
    if (!busy || waitedMs + RETRY_MS > busyTimeoutS * 1000) return answerCode(ctx, res.status, body);
    ctx.out(ctx.t('cli.busy.wait', { s: RETRY_MS / 1000 }));
    await sleep(RETRY_MS);
    waitedMs += RETRY_MS;
  }
}

function resolveTarget(values: Values, env: NodeJS.ProcessEnv) {
  const url = ((values.url as string | undefined) ?? env.MICRORUN_URL)?.replace(/\/+$/, '');
  const token = (values.token as string | undefined) ?? env.MICRORUN_DEPLOY_TOKEN;
  const commit = values.commit as string | undefined;
  const branch = values.branch as string | undefined;
  const images = parseImages((values.image as string[] | undefined) ?? []);
  const busyTimeoutS = Number((values['busy-timeout'] as string | undefined) ?? DEFAULT_BUSY_TIMEOUT_S);
  if (!url || !token || !commit || !branch || !images || !Number.isFinite(busyTimeoutS) || busyTimeoutS < 0) return null;
  return { url, token, commit, branch, images, busyTimeoutS };
}

function withDefaults(deps: DeployDeps): Required<DeployDeps> {
  return {
    fetch: deps.fetch ?? fetch,
    git: deps.git ?? defaultGit,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    out: deps.out ?? ((s: string) => void process.stdout.write(`${s}\n`)),
    err: deps.err ?? ((s: string) => void process.stderr.write(`${s}\n`)),
  };
}

export async function runDeploy(argv: string[], env: NodeJS.ProcessEnv, deps: DeployDeps = {}): Promise<number> {
  const d = withDefaults(deps);
  const values = parseDeployArgs(argv);
  const lang = fromEnvLocale(env, values.lang as string | undefined);
  const t = i18n(lang).t;
  const target = resolveTarget(values, env);
  if (!target) {
    d.err(t('cli.usage'));
    return 3;
  }
  const { url, token, commit, branch, images, busyTimeoutS } = target;

  const gitLine = async (format: string) => {
    try {
      return (await d.git(['log', '-1', `--format=${format}`])).trim();
    } catch {
      return '';
    }
  };
  const author = (values.author as string | undefined) ?? (await gitLine('%an'));
  const message = (values.message as string | undefined) ?? (await gitLine('%s'));

  const ctx: Ctx = { fetch: d.fetch, out: d.out, err: d.err, t, url, headers: { authorization: `Bearer ${token}`, 'accept-language': lang } };
  return postDeploy(ctx, JSON.stringify({ images, commit, branch, author, message }), busyTimeoutS, d.sleep);
}
