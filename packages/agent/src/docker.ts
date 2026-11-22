import { spawn } from 'node:child_process';

const CAP = 10 * 1024 * 1024;

function collector() {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk: Buffer) {
      if (size >= CAP) { truncated = true; return; }
      const part = chunk.subarray(0, CAP - size);
      if (part.length < chunk.length) truncated = true;
      chunks.push(part);
      size += part.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8') + (truncated ? '\n[truncated]' : ''),
  };
}

export function docker(
  args: string[],
  opts: { input?: string; env?: Record<string, string>; timeoutMs?: number; redact?: string[] } = {},
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const scrub = (s: string) => (opts.redact ?? []).filter(Boolean).reduce((acc, r) => acc.split(r).join('***'), s);
    const out = collector();
    const err = collector();
    let done = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number, extra = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const stderr = timedOut ? `timeout after ${opts.timeoutMs} ms` : err.text() + extra;
      resolve({ code: timedOut && code === 0 ? 124 : code, stdout: scrub(out.text()), stderr: scrub(stderr), timedOut });
    };
    const child = spawn('docker', args, {
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (opts.timeoutMs) {
      timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs);
    }
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => finish(127, e.message));
    child.on('close', (code) => finish(code ?? 124));
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}
