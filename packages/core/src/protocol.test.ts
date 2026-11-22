import { describe, test, expect, expectTypeOf } from 'vitest';
import {
  PROTOCOL_VERSION,
  RESULT_CODES,
  REJECT_CODES,
  AgentError,
  commandSchema,
  wsAgentToServer,
  wsServerToAgent,
  deployRequest,
  parseCleanupLines,
} from './protocol.ts';
import type { Command, ComposeRef, DbRef, ResultMap, StorageConfig } from './protocol.ts';

const compose: ComposeRef = { project: 'shop', dir: '/srv/shop', files: ['docker-compose.yml', 'docker-compose.microrun.yml'] };
const db: DbRef = { compose, service: 'db', dbKind: 'postgres', dbUrlEnv: 'DATABASE_URL' };
const local: StorageConfig = { kind: 'local', path: '/var/lib/microrun/images' };
const registry: StorageConfig = { kind: 'registry', registry: 'ghcr.io', repository: 'acme/shop', username: 'bot', password: 'hunter2' };
const s3: StorageConfig = {
  kind: 's3', endpoint: 'https://s3.example.com', region: 'eu-central-1', bucket: 'releases', prefix: 'microrun/',
  accessKey: 'AK', secretKey: 'SK', forcePathStyle: true,
};
const images = { web: 'ghcr.io/acme/shop-web:abc1234', worker: 'ghcr.io/acme/shop-worker:abc1234' };

const commands: Command[] = [
  { type: 'ping' },
  { type: 'inspectEnv', compose, dbUrlEnv: 'DATABASE_URL' },
  { type: 'readMarker', db },
  { type: 'readMarker', db, viaService: 'web' },
  { type: 'writeMarker', db, envId: 'env_1', envName: 'staging' },
  { type: 'pullImages', refs: ['ghcr.io/acme/shop-web:abc1234'] },
  { type: 'snapshotSchema', db },
  {
    type: 'dryRunExpand', db, image: 'ghcr.io/acme/shop-web:abc1234', cmd: 'npm run migrate',
    migrationTables: ['knex_migrations'], opId: 'op_1', env: { MICRORUN_ENV: 'staging' },
  },
  {
    type: 'runCommand', compose, service: 'web', image: 'ghcr.io/acme/shop-web:abc1234', cmd: 'npm run cleanup',
    args: ['--dry-run'], env: { MICRORUN_ENV: 'staging' },
  },
  {
    type: 'switchServices', compose,
    services: [
      { name: 'web', strategy: 'rolling', image: 'ghcr.io/acme/shop-web:abc1234', domain: 'shop.example.com', port: 3000 },
      { name: 'worker', strategy: 'recreate', image: 'ghcr.io/acme/shop-worker:abc1234' },
    ],
    healthTimeoutS: 60, proxyMode: 'bundled',
  },
  { type: 'storeImages', storage: local, env: 'staging', sha: 'abc1234', images },
  { type: 'fetchImages', storage: registry, env: 'staging', sha: 'abc1234', images },
  { type: 'fetchImages', storage: local, env: 'staging', sha: 'abc1234', images, digests: { web: 'sha256:aa', worker: 'sha256:bb' } },
  { type: 'deleteImages', storage: s3, env: 'staging', sha: 'abc1234', images },
];

describe('constants', () => {
  test('protocol version is 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  test('every reject code is a result code', () => {
    for (const code of REJECT_CODES) expect(RESULT_CODES).toContain(code);
  });

  test('AGENT_ERROR is a result code that fails rather than rejects', () => {
    expect(RESULT_CODES).toContain('AGENT_ERROR');
    expect(REJECT_CODES).not.toContain('AGENT_ERROR');
  });

  test('inspectEnv reports hasHealthcheck as boolean or null', () => {
    expectTypeOf<ResultMap['inspectEnv']['services'][number]['hasHealthcheck']>().toEqualTypeOf<boolean | null>();
  });
});

describe('commandSchema', () => {
  test.each(commands.map((c) => [c.type, c] as const))('accepts %s', (_type, cmd) => {
    expect(commandSchema.parse(cmd)).toEqual(cmd);
  });

  test('rejects a fetchImages command with a non-string digest', () => {
    const cmd = { type: 'fetchImages', storage: local, env: 'staging', sha: 'abc1234', images, digests: { web: 1 } };
    expect(commandSchema.safeParse(cmd).success).toBe(false);
  });

  test('rejects an unknown type', () => {
    expect(() => commandSchema.parse({ type: 'formatDisk', compose })).toThrow();
  });

  test('rejects an unknown db kind', () => {
    expect(() => commandSchema.parse({ type: 'snapshotSchema', db: { ...db, dbKind: 'oracle' } })).toThrow();
  });
});

describe('deployRequest', () => {
  const valid = { images: { web: 'ghcr.io/acme/shop-web:abc1234' }, commit: 'abc1234', branch: 'main', author: 'dev', message: 'fix checkout' };

  test('accepts a valid request', () => {
    expect(deployRequest.parse(valid)).toEqual(valid);
  });

  test('accepts the wildcard images map and a full 40-char sha', () => {
    const req = { ...valid, images: { '*': 'ghcr.io/acme/shop:abc1234' }, commit: 'a'.repeat(40) };
    expect(deployRequest.parse(req)).toEqual(req);
  });

  test.each(['not-a-sha', 'abc12', 'a'.repeat(41), 'abc123g'])('rejects bad sha %s', (commit) => {
    expect(deployRequest.safeParse({ ...valid, commit }).success).toBe(false);
  });

  test('rejects an empty images map', () => {
    expect(deployRequest.safeParse({ ...valid, images: {} }).success).toBe(false);
  });

  test('accepts author of 500 chars and rejects 501', () => {
    expect(deployRequest.safeParse({ ...valid, author: 'a'.repeat(500) }).success).toBe(true);
    expect(deployRequest.safeParse({ ...valid, author: 'a'.repeat(501) }).success).toBe(false);
  });

  test('rejects message over 500 chars', () => {
    expect(deployRequest.safeParse({ ...valid, message: 'm'.repeat(501) }).success).toBe(false);
  });
});

describe('parseCleanupLines', () => {
  test('dry-run keeps preview lines and routes the rest to other', () => {
    const oversized = JSON.stringify({ rule: 'huge', description: 'x'.repeat(70000), count: 1 });
    const stdout = [
      'starting cleanup',
      '{"rule": "orphan_carts", "description": "Carts without users", "count": 12}',
      '{"rule": "old_sessions", "deleted": 3}',
      '{"rule": "bad_count", "description": "d", "count": "many"}',
      '{not json',
      oversized,
      '{"rule": "empty_logs", "description": "Empty log rows", "count": 0}',
    ].join('\n');

    const { lines, other } = parseCleanupLines(stdout, 'dry-run');

    expect(lines).toEqual([
      { rule: 'orphan_carts', description: 'Carts without users', count: 12 },
      { rule: 'empty_logs', description: 'Empty log rows', count: 0 },
    ]);
    expect(other).toEqual([
      'starting cleanup',
      '{"rule": "old_sessions", "deleted": 3}',
      '{"rule": "bad_count", "description": "d", "count": "many"}',
      '{not json',
      oversized,
    ]);
  });

  test('apply keeps deleted lines and routes preview lines to other', () => {
    const stdout = [
      '{"rule": "orphan_carts", "deleted": 12}',
      '{"rule": "empty_logs", "description": "Empty log rows", "count": 0}',
      'done',
    ].join('\n');

    const { lines, other } = parseCleanupLines(stdout, 'apply');

    expect(lines).toEqual([{ rule: 'orphan_carts', deleted: 12 }]);
    expect(other).toEqual(['{"rule": "empty_logs", "description": "Empty log rows", "count": 0}', 'done']);
  });

  test('never throws on hostile input', () => {
    expect(() => parseCleanupLines('null\n[]\n42\n"str"\n{"rule": null}', 'dry-run')).not.toThrow();
    expect(parseCleanupLines('null\n[]\n42', 'apply').lines).toEqual([]);
  });
});

describe('AgentError', () => {
  test('keeps code and params', () => {
    const err = new AgentError('DB_MARKER_MISMATCH', { service: 'db', envName: 'prod' });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('DB_MARKER_MISMATCH');
    expect(err.params).toEqual({ service: 'db', envName: 'prod' });
  });

  test('defaults params to an empty object', () => {
    expect(new AgentError('AGENT_OFFLINE').params).toEqual({});
  });
});

describe('ws schemas', () => {
  const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value));

  test.each([
    { t: 'hello', protocolVersion: 1, agentVersion: '1.0.0' },
    { t: 'res', id: 'r1', ok: true, result: { agentVersion: '1.0.0' } },
    { t: 'res', id: 'r2', ok: false, code: 'IMAGE_PULL_FAILED', params: { ref: 'web:abc' }, message: 'pull failed' },
    { t: 'pong' },
  ])('agent→server $t round-trips', (msg) => {
    expect(wsAgentToServer.parse(roundTrip(msg))).toEqual(msg);
  });

  test.each([
    { t: 'req', id: 'r1', key: { opId: 'op_1', step: 'pull' }, cmd: commands[5] },
    { t: 'ping' },
    { t: 'bye', code: 'PROTOCOL_MISMATCH' },
    { t: 'bye', code: 'UNAUTHORIZED' },
  ])('server→agent $t round-trips', (msg) => {
    expect(wsServerToAgent.parse(roundTrip(msg))).toEqual(msg);
  });

  test('rejects a failed result with an unknown code', () => {
    expect(wsAgentToServer.safeParse({ t: 'res', id: 'r', ok: false, code: 'NOPE', params: {}, message: '' }).success).toBe(false);
  });

  test('rejects bye with an unknown code', () => {
    expect(wsServerToAgent.safeParse({ t: 'bye', code: 'BORED' }).success).toBe(false);
  });
});
