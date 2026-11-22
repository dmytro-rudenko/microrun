import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { TarIndex } from './archive.ts';

const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

function header(name: string, size: number, type = '0'): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'latin1');
  h.write(type, 156, 1, 'latin1');
  h.write('ustar\0', 257, 6, 'latin1');
  h.write('00', 263, 2, 'latin1');
  return h;
}

const file = (name: string, body: string | Buffer, type = '0') => {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return Buffer.concat([header(name, b.length, type), pad(b)]);
};

function pax(path: string, body: string): Buffer {
  const rec = (n: number) => `${n} path=${path}\n`;
  let len = rec(0).length;
  while (rec(len).length !== len) len = rec(len).length;
  return Buffer.concat([file('PaxHeaders/x', rec(len), 'x'), file('ignored-short-name', body)]);
}

const end = Buffer.alloc(1024);
const manifest = (layers: string[]) =>
  JSON.stringify([{ Config: 'blobs/sha256/cfg', RepoTags: ['shop/web:1'], Layers: layers }]);

async function index(tar: Buffer, chunk = tar.length): Promise<{ idx: TarIndex; out: Buffer }> {
  const idx = new TarIndex();
  const parts: Buffer[] = [];
  const chunks = [];
  for (let i = 0; i < tar.length; i += chunk) chunks.push(tar.subarray(i, i + chunk));
  await pipeline(Readable.from(chunks), idx, new Writable({ write(c: Buffer, _e, cb) { parts.push(c); cb(); } }));
  return { idx, out: Buffer.concat(parts) };
}

describe('TarIndex', () => {
  it('passes the stream through unchanged and reports nothing missing for a complete archive', async () => {
    const tar = Buffer.concat([
      file('blobs/sha256/cfg', '{}'),
      file('blobs/sha256/l1', Buffer.alloc(1300, 7)),
      file('manifest.json', manifest(['blobs/sha256/l1'])),
      end,
    ]);
    const { idx, out } = await index(tar, 100);
    expect(out.equals(tar)).toBe(true);
    expect(idx.missing()).toBeNull();
  });

  it('names the image and the paths that manifest.json lists but the archive lacks', async () => {
    const tar = Buffer.concat([
      file('index.json', '{}'),
      file('manifest.json', manifest(['blobs/sha256/l1', 'blobs/sha256/l2'])),
      file('blobs/sha256/l1', 'layer'),
      end,
    ]);
    expect((await index(tar, 7)).idx.missing()).toEqual({ image: 'shop/web:1', paths: ['blobs/sha256/cfg', 'blobs/sha256/l2'] });
  });

  it('treats an archive without manifest.json as incomplete', async () => {
    const tar = Buffer.concat([file('index.json', '{}'), end]);
    expect((await index(tar)).idx.missing()).toEqual({ image: '', paths: ['manifest.json'] });
  });

  it('takes the entry name from a PAX header', async () => {
    const long = `blobs/sha256/${'a'.repeat(120)}`;
    const tar = Buffer.concat([file('blobs/sha256/cfg', '{}'), pax(long, 'x'), file('manifest.json', manifest([long])), end]);
    const { idx } = await index(tar, 33);
    expect(idx.names.has(long)).toBe(true);
    expect(idx.missing()).toBeNull();
  });
});
