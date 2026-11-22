import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composeConfig } from './compose.ts';

describe('composeConfig with env files', () => {
  let dir: string;
  let secrets: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'microrun-envfile-'));
    secrets = await mkdtemp(join(tmpdir(), 'microrun-secrets-'));
    await writeFile(join(dir, 'compose.yml'),
      'services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: ${PG_PASSWORD:?PG_PASSWORD is required}\n');
    await writeFile(join(secrets, '.env'), 'PG_PASSWORD=from-outside\n');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(secrets, { recursive: true, force: true });
  });

  it('fails interpolation without the env file and resolves it from an env file outside the compose dir', async () => {
    const ref = { project: 'envfile', dir, files: ['compose.yml'] };
    await expect(composeConfig(ref)).rejects.toThrow(/PG_PASSWORD is required/);
    const model = await composeConfig({ ...ref, envFiles: [join(secrets, '.env')] });
    expect(model.services.db?.environment?.POSTGRES_PASSWORD).toBe('from-outside');
  });
});
