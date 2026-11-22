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
    if (data.length === 0) return false;
    const parsed = JSON.parse(data.join('\n')) as { type?: string };
    const type = name ?? parsed.type;
    name = undefined;
    data = [];
    return onEvent({ ...parsed, type } as OperationEvent);
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

export async function runDeploy(argv: string[], env: NodeJS.ProcessEnv, deps: DeployDeps = {}): Promise<number> {
  const doFetch = deps.fetch ?? fetch;
  const git = deps.git ?? defaultGit;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const out = deps.out ?? ((s: string) => void process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s: string) => void process.stderr.write(`${s}\n`));

  let values: ReturnType<typeof parseArgs>['values'] = {};
  try {
    values = parseArgs({
      args: argv,
      options: {
        url: { type: 'string' },
        token: { type: 'string' },
        image: { type: 'string', multiple: true },
        commit: { type: 'string' },
        branch: { type: 'string' },
        author: { type: 'string' },
        message: { type: 'string' },
        'busy-timeout': { type: 'string' },
        lang: { type: 'string' },
      },
      allowPositionals: false,
    }).values;
  } catch {
    values = {};
  }

  const lang = fromEnvLocale(env, values.lang as string | undefined);
  const t = i18n(lang).t;
  const usage = (): number => {
    err(t('cli.usage'));
    return 3;
  };

  const url = ((values.url as string | undefined) ?? env.MICRORUN_URL)?.replace(/\/+$/, '');
  const token = (values.token as string | undefined) ?? env.MICRORUN_DEPLOY_TOKEN;
  const commit = values.commit as string | undefined;
  const branch = values.branch as string | undefined;
  const images = parseImages((values.image as string[] | undefined) ?? []);
  const busyTimeoutS = Number((values['busy-timeout'] as string | undefined) ?? DEFAULT_BUSY_TIMEOUT_S);
  if (!url || !token || !commit || !branch || !images || !Number.isFinite(busyTimeoutS) || busyTimeoutS < 0) return usage();

  const gitLine = async (format: string) => {
    try {
      return (await git(['log', '-1', `--format=${format}`])).trim();
    } catch {
      return '';
    }
  };
  const author = (values.author as string | undefined) ?? (await gitLine('%an'));
  const message = (values.message as string | undefined) ?? (await gitLine('%s'));

  const headers = { authorization: `Bearer ${token}`, 'accept-language': lang };
  const unreachable = (): number => {
    err(t('cli.unreachable'));
    return 3;
  };
  const apiError = async (res: Response): Promise<string> => {
    const body = (await res.json().catch(() => null)) as Partial<ApiError> | null;
    return body?.code ? `${body.code}: ${body.message ?? ''}` : `HTTP ${res.status}`;
  };

  let waitedMs = 0;
  for (;;) {
    let res: Response;
    try {
      res = await doFetch(`${url}/api/v1/deploy`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ images, commit, branch, author, message }),
      });
    } catch {
      return unreachable();
    }

    if (res.status === 202) {
      const { operationId } = (await res.json()) as DeployAccepted;
      return stream(operationId);
    }
    if (res.status === 200) {
      const body = (await res.json().catch(() => null)) as { code?: string } | null;
      if (body?.code === 'ALREADY_ACTIVE') {
        out(t('cli.done.ok'));
        return 0;
      }
    }
    if (res.status === 409) {
      const body = (await res.clone().json().catch(() => null)) as Partial<ApiError> | null;
      if (body?.code === 'ENV_BUSY') {
        if (waitedMs + RETRY_MS > busyTimeoutS * 1000) {
          err(await apiError(res));
          return 3;
        }
        out(t('cli.busy.wait', { s: RETRY_MS / 1000 }));
        await sleep(RETRY_MS);
        waitedMs += RETRY_MS;
        continue;
      }
    }
    err(await apiError(res));
    return res.status === 422 ? 2 : 3;
  }

  async function stream(operationId: string): Promise<number> {
    let result: number | undefined;
    try {
      const res = await doFetch(`${url}/api/v1/operations/${operationId}/events`, {
        headers: { ...headers, accept: 'text/event-stream' },
      });
      if (!res.ok || !res.body) return unreachable();
      await readEvents(res.body, (e) => {
        if (e.type === 'step') {
          if (e.status === 'running') out(t('cli.step', { step: e.step }));
        } else if (e.type === 'log') out(e.line);
        else {
          if (e.status === 'succeeded') {
            out(t('cli.done.ok'));
            result = 0;
          } else {
            if (e.code) err(`${e.code}: ${e.message}`);
            const rejected = e.code !== null && REJECT_CODES.includes(e.code);
            err(t(rejected ? 'cli.done.rejected' : 'cli.done.failed'));
            result = rejected ? 2 : 1;
          }
          return true;
        }
        return false;
      });
    } catch {
      return unreachable();
    }
    return result ?? unreachable();
  }
}
