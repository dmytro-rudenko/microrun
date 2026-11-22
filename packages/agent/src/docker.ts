import { spawn } from 'node:child_process';

const CAP = 10 * 1024 * 1024;

function collector() {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    push(chunk: Buffer) {
      if (size >= CAP) return;
      const part = chunk.subarray(0, CAP - size);
      chunks.push(part);
      size += part.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

export function docker(
  args: string[],
  opts: { input?: string; env?: Record<string, string>; timeoutMs?: number; redact?: string[] } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const scrub = (s: string) => (opts.redact ?? []).filter(Boolean).reduce((acc, r) => acc.split(r).join('***'), s);
    const out = collector();
    const err = collector();
    let done = false;
    const finish = (code: number, extra = '') => {
      if (done) return;
      done = true;
      resolve({ code, stdout: scrub(out.text()), stderr: scrub(err.text() + extra) });
    };
    const child = spawn('docker', args, {
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      timeout: opts.timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => finish(127, e.message));
    child.on('close', (code) => finish(code ?? 1));
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}
