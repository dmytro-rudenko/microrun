import { Transform, type TransformCallback } from 'node:stream';

const BLOCK = 512;

interface ManifestEntry { Config?: string; Layers?: string[]; RepoTags?: string[] | null }

const cstr = (b: Buffer) => {
  const end = b.indexOf(0);
  return b.subarray(0, end === -1 ? b.length : end).toString('utf8');
};

function entrySize(h: Buffer): number {
  const field = h.subarray(124, 136);
  if ((field[0]! & 0x80) === 0) return parseInt(cstr(field).trim() || '0', 8);
  let n = 0;
  for (const byte of field.subarray(1)) n = n * 256 + byte;
  return n;
}

function paxPath(body: Buffer): string | null {
  for (const rec of body.toString('utf8').split('\n')) {
    const m = /^\d+ path=(.*)$/.exec(rec);
    if (m) return m[1]!;
  }
  return null;
}

const clean = (name: string) => name.replace(/^\.\//, '');

export class TarIndex extends Transform {
  readonly names = new Set<string>();
  private manifest: Buffer | null = null;
  private head = Buffer.alloc(0);
  private left = 0;
  private want = 0;
  private body: Buffer[] = [];
  private onBody: ((b: Buffer) => void) | null = null;
  private nextName: string | null = null;

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    let off = 0;
    while (off < chunk.length) {
      if (this.left > 0) {
        const n = Math.min(this.left, chunk.length - off);
        if (this.want > 0) {
          const take = Math.min(this.want, n);
          this.body.push(chunk.subarray(off, off + take));
          this.want -= take;
          if (this.want === 0) this.finishBody();
        }
        this.left -= n;
        off += n;
        continue;
      }
      const n = Math.min(BLOCK - this.head.length, chunk.length - off);
      this.head = Buffer.concat([this.head, chunk.subarray(off, off + n)]);
      off += n;
      if (this.head.length === BLOCK) {
        this.header(this.head);
        this.head = Buffer.alloc(0);
      }
    }
    cb(null, chunk);
  }

  private header(h: Buffer): void {
    if (h.every((b) => b === 0)) return;
    const size = entrySize(h);
    const type = String.fromCharCode(h[156]!);
    const ustar = h.subarray(257, 262).toString('latin1') === 'ustar';
    const prefix = ustar ? cstr(h.subarray(345, 500)) : '';
    const own = cstr(h.subarray(0, 100));
    this.left = Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x' || type === 'L') {
      this.collect(size, (b) => { this.nextName = type === 'x' ? paxPath(b) : cstr(b); });
      return;
    }
    if (type === 'g') return;
    const name = clean(this.nextName ?? (prefix ? `${prefix}/${own}` : own));
    this.nextName = null;
    this.names.add(name);
    if (name === 'manifest.json') this.collect(size, (b) => { this.manifest = b; });
  }

  private collect(size: number, done: (b: Buffer) => void): void {
    this.body = [];
    this.want = size;
    this.onBody = done;
    if (size === 0) this.finishBody();
  }

  private finishBody(): void {
    this.onBody?.(Buffer.concat(this.body));
    this.onBody = null;
    this.body = [];
  }

  missing(): { image: string; paths: string[] } | null {
    if (!this.manifest) return { image: '', paths: ['manifest.json'] };
    for (const m of JSON.parse(this.manifest.toString('utf8')) as ManifestEntry[]) {
      const paths = [m.Config, ...(m.Layers ?? [])].filter((p): p is string => !!p && !this.names.has(clean(p)));
      if (paths.length) return { image: m.RepoTags?.[0] ?? '', paths };
    }
    return null;
  }
}
