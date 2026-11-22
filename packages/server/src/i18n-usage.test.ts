import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allKeys } from '@microrun/core/i18n';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const KEY = /\bt\('([^']+)'/g;

function usedKeys(): { file: string; key: string }[] {
  const files = [...globSync('packages/server/src/**/*.ts', { cwd: root }), ...globSync('packages/agent/src/**/*.ts', { cwd: root })];
  return files.flatMap((file) => [...readFileSync(join(root, file), 'utf8').matchAll(KEY)].map((m) => ({ file, key: m[1]! })));
}

describe('i18n usage', () => {
  it('every literal t() key in server and agent sources exists in the en catalog', () => {
    const used = usedKeys();
    expect(used.some((u) => u.file.startsWith('packages/server/'))).toBe(true);
    const known = new Set(allKeys().en);
    expect(used.filter((u) => !known.has(u.key))).toEqual([]);
  });
});
