import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentError, parseCleanupLines, type ComposeRef, type DbRef } from '@microrun/core/protocol';
import {
  diffSchema, normalizeDefault, normalizeType, snapshotSchema as snapshotShape,
  type DbKind, type SchemaSnapshot, type SqlSnapshot,
} from '@microrun/core/schema';
import { runOneOff } from './compose.ts';
import { docker } from './docker.ts';

const lib = () => import('./db.ts');

const IDLE = ['sh', '-c', "trap 'exit 0' TERM; while :; do sleep 1; done"];
const PRIMARY = /^(PRIMARY|_id_)$|_pkey$|^sqlite_autoindex_/;

const SQL_SEED = `
CREATE TABLE users (id integer PRIMARY KEY NOT NULL, email varchar(255) NOT NULL, name varchar(100), status varchar(20) NOT NULL DEFAULT 'new');
CREATE UNIQUE INDEX users_email_uq ON users (email);
CREATE INDEX users_name_idx ON users (name);
CREATE TABLE orders (id integer PRIMARY KEY NOT NULL, user_id integer NOT NULL);
CREATE INDEX orders_user_idx ON orders (user_id);
CREATE TABLE knex_migrations (id integer PRIMARY KEY NOT NULL, name varchar(255));
INSERT INTO knex_migrations (id, name) VALUES (1, '001_init');
INSERT INTO users (id, email, name) VALUES (1, 'a@example.com', 'Ann');
`;

const MONGO_SEED = `
db.createCollection('users', { validator: { $jsonSchema: { bsonType: 'object', required: ['email'] } } });
db.users.createIndex({ email: 1 }, { unique: true });
db.users.createIndex({ name: 1 });
db.createCollection('orders');
db.orders.createIndex({ user_id: 1 });
db.knex_migrations.insertOne({ name: '001_init' });
db.users.insertOne({ email: 'a@example.com', name: 'Ann' });
`;

const MYSQL_URL_SH = `rest=\${DATABASE_URL#*://}
creds=\${rest%%@*}
hostpart=\${rest#*@}
user=\${creds%%:*}
pass=\${creds#*:}
hostport=\${hostpart%%/*}
db=\${hostpart#*/}
db=\${db%%\\?*}
host=\${hostport%%:*}
port=3306
case $hostport in *:*) port=\${hostport##*:};; esac
exec mysql -h "$host" -P "$port" -u "$user" "-p$pass" "$db" "$@"
`;

const CLEANUP_SH = `echo 'starting cleanup preview'
echo '{"rule":"old-sessions","description":"Sessions older than 30 days","count":12}'
echo '{"rule":"bad","count":"many"}'
printf '{"rule":"%s","description":"x","count":1}\\n' "$(head -c 70000 /dev/zero | tr '\\0' a)"
echo '{"rule":"orphans","description":"Orphan uploads","count":0}'
echo 'not json {'
`;

interface Engine {
  kind: DbKind;
  services: Record<string, unknown>;
  volumes?: Record<string, unknown>;
  urls: { app: string; other: string };
  appImage: string;
  seed: (exec: (service: string, args: string[], input?: string) => Promise<string>) => Promise<void>;
  addCmd: string;
  dropCmd: string;
  addDiff: { kind: 'add'; object: string };
  dropDiff: { kind: 'drop'; object: string };
  types?: Record<string, string>;
}

function appService(image: string, url: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { image, command: IDLE, environment: { DATABASE_URL: url }, volumes: ['./:/fixture:ro'], ...extra };
}

const healthy = { interval: '2s', timeout: '5s', retries: 150 };

const engines: Engine[] = [
  {
    kind: 'postgres',
    appImage: 'postgres:17-alpine',
    urls: { app: 'postgres://postgres:pw-secret@db:5432/app', other: 'postgres://postgres:pw-secret@db:5432/other' },
    services: {
      db: {
        image: 'postgres:17-alpine',
        environment: { POSTGRES_PASSWORD: 'pw-secret', POSTGRES_DB: 'app' },
        healthcheck: { test: ['CMD', 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'app'], ...healthy },
      },
      app: appService('postgres:17-alpine', 'postgres://postgres:pw-secret@db:5432/app'),
      other: appService('postgres:17-alpine', 'postgres://postgres:pw-secret@db:5432/other'),
    },
    seed: async (exec) => {
      await exec('db', ['psql', '-U', 'postgres', '-d', 'app', '-v', 'ON_ERROR_STOP=1'], SQL_SEED);
      await exec('db', ['psql', '-U', 'postgres', '-c', 'CREATE DATABASE other']);
    },
    addCmd: 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "select name from knex_migrations" | grep -q 001_init && psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "ALTER TABLE users ADD COLUMN $NEW_COL varchar(50)"',
    dropCmd: 'psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "ALTER TABLE users DROP COLUMN status"',
    addDiff: { kind: 'add', object: 'users.nickname' },
    dropDiff: { kind: 'drop', object: 'users.status' },
    types: { id: 'int', email: 'varchar(255)', name: 'varchar(100)', status: 'varchar(20)', user_id: 'int' },
  },
  {
    kind: 'mysql',
    appImage: 'mysql:8.4',
    urls: { app: 'mysql://root:pw-secret@db:3306/app', other: 'mysql://root:pw-secret@db:3306/other' },
    services: {
      db: {
        image: 'mysql:8.4',
        environment: { MYSQL_ROOT_PASSWORD: 'pw-secret', MYSQL_DATABASE: 'app' },
        healthcheck: { test: ['CMD', 'mysqladmin', 'ping', '-h', '127.0.0.1', '-uroot', '-ppw-secret'], ...healthy },
      },
      app: appService('mysql:8.4', 'mysql://root:pw-secret@db:3306/app'),
      other: appService('mysql:8.4', 'mysql://root:pw-secret@db:3306/other'),
    },
    seed: async (exec) => {
      await exec('db', ['mysql', '-uroot', '-ppw-secret', 'app'], SQL_SEED);
      await exec('db', ['mysql', '-uroot', '-ppw-secret', '-e', 'CREATE DATABASE other']);
    },
    addCmd: 'sh /fixture/mysql-url.sh -N -e "select name from knex_migrations" | grep -q 001_init && sh /fixture/mysql-url.sh -e "ALTER TABLE users ADD COLUMN $NEW_COL varchar(50)"',
    dropCmd: 'sh /fixture/mysql-url.sh -e "ALTER TABLE users DROP COLUMN status"',
    addDiff: { kind: 'add', object: 'users.nickname' },
    dropDiff: { kind: 'drop', object: 'users.status' },
    types: { id: 'int', email: 'varchar(255)', name: 'varchar(100)', status: 'varchar(20)', user_id: 'int' },
  },
  {
    kind: 'mongodb',
    appImage: 'mongo:8',
    urls: {
      app: 'mongodb://root:pw-secret@db:27017/app?authSource=admin',
      other: 'mongodb://root:pw-secret@db:27017/other?authSource=admin',
    },
    services: {
      db: {
        image: 'mongo:8',
        environment: { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: 'pw-secret' },
        healthcheck: {
          test: ['CMD', 'mongosh', '--quiet', 'mongodb://root:pw-secret@db:27017/admin', '--eval', 'db.adminCommand({ ping: 1 }).ok'],
          ...healthy,
        },
      },
      app: appService('mongo:8', 'mongodb://root:pw-secret@db:27017/app?authSource=admin'),
      other: appService('mongo:8', 'mongodb://root:pw-secret@db:27017/other?authSource=admin'),
    },
    seed: async (exec) => {
      await exec('db', ['mongosh', '--quiet', 'mongodb://root:pw-secret@localhost:27017/app?authSource=admin', '--eval', MONGO_SEED]);
    },
    addCmd: `mongosh "$DATABASE_URL" --quiet --eval 'if (db.knex_migrations.countDocuments({ name: "001_init" }) !== 1) quit(5); db.createCollection(process.env.NEW_COL)'`,
    dropCmd: `mongosh "$DATABASE_URL" --quiet --eval 'db.orders.drop()'`,
    addDiff: { kind: 'add', object: 'nickname' },
    dropDiff: { kind: 'drop', object: 'orders' },
  },
  {
    kind: 'sqlite',
    appImage: 'keinos/sqlite3:3.50.4',
    urls: { app: 'file:/data/app.db', other: 'file:/data/other.db' },
    volumes: { data: {} },
    services: {
      app: appService('keinos/sqlite3:3.50.4', 'file:/data/app.db', {
        user: 'root', healthcheck: { disable: true }, volumes: ['./:/fixture:ro', 'data:/data'],
      }),
      other: appService('keinos/sqlite3:3.50.4', 'file:/data/other.db', {
        user: 'root', healthcheck: { disable: true }, volumes: ['./:/fixture:ro', 'data:/data'],
      }),
    },
    seed: async (exec) => {
      await exec('app', ['sqlite3', '/data/app.db'], SQL_SEED);
    },
    addCmd: 'f="${DATABASE_URL#file:}"; sqlite3 "$f" "select name from knex_migrations" | grep -q 001_init && sqlite3 "$f" "ALTER TABLE users ADD COLUMN $NEW_COL varchar(50)"',
    dropCmd: 'f="${DATABASE_URL#file:}"; sqlite3 "$f" "ALTER TABLE users DROP COLUMN status"',
    addDiff: { kind: 'add', object: 'users.nickname' },
    dropDiff: { kind: 'drop', object: 'users.status' },
    types: { id: 'INTEGER', email: 'TEXT', name: 'TEXT', status: 'TEXT', user_id: 'INTEGER' },
  },
];

async function dk(args: string[], input?: string): Promise<string> {
  const r = await docker(args, { input });
  if (r.code !== 0) throw new Error(`docker ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

async function dryrunContainers(opId: string): Promise<string[]> {
  const out = await dk(['ps', '-a', '--filter', `name=microrun-dryrun-${opId}`, '--format', '{{.Names}}']);
  return out.split('\n').filter((n) => n === `microrun-dryrun-${opId}`);
}

function sqlTables(s: SchemaSnapshot): SqlSnapshot['tables'] {
  if (s.kind !== 'sql') throw new Error(`expected an sql snapshot, got ${s.kind}`);
  return s.tables;
}

function expectSqlSnapshot(s: SchemaSnapshot, engine: 'postgres' | 'mysql' | 'sqlite', types: Record<string, string>): void {
  expect(s).toMatchObject({ kind: 'sql', engine });
  const tables = [...sqlTables(s)].sort((a, b) => a.name.localeCompare(b.name));
  expect(tables.map((t) => t.name)).toEqual(['orders', 'users']);
  const shape = (t: SqlSnapshot['tables'][number]) => ({
    columns: [...t.columns].sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ name: c.name, type: normalizeType(engine, c.type), nullable: c.nullable })),
    indexes: t.indexes.filter((i) => !PRIMARY.test(i.name)).sort((a, b) => a.name.localeCompare(b.name)),
  });
  const [orders, users] = tables;
  expect(shape(users!)).toEqual({
    columns: [
      { name: 'email', type: types.email, nullable: false },
      { name: 'id', type: types.id, nullable: false },
      { name: 'name', type: types.name, nullable: true },
      { name: 'status', type: types.status, nullable: false },
    ],
    indexes: [
      { name: 'users_email_uq', columns: ['email'], unique: true },
      { name: 'users_name_idx', columns: ['name'], unique: false },
    ],
  });
  expect(shape(orders!)).toEqual({
    columns: [
      { name: 'id', type: types.id, nullable: false },
      { name: 'user_id', type: types.user_id, nullable: false },
    ],
    indexes: [{ name: 'orders_user_idx', columns: ['user_id'], unique: false }],
  });
  const status = users!.columns.find((c) => c.name === 'status');
  const name = users!.columns.find((c) => c.name === 'name');
  expect(normalizeDefault(status!.default)?.replace(/'/g, '')).toBe('new');
  expect(name!.default).toBeNull();
}

function expectMongoSnapshot(s: SchemaSnapshot): void {
  if (s.kind !== 'mongo') throw new Error(`expected a mongo snapshot, got ${s.kind}`);
  const cols = [...s.collections].sort((a, b) => a.name.localeCompare(b.name));
  expect(cols.map((c) => c.name)).toEqual(['orders', 'users']);
  const idx = (c: (typeof cols)[number]) => c.indexes.filter((i) => !PRIMARY.test(i.name)).sort((a, b) => a.name.localeCompare(b.name));
  expect(idx(cols[0]!)).toEqual([{ name: 'user_id_1', keys: { user_id: 1 }, unique: false }]);
  expect(idx(cols[1]!)).toEqual([
    { name: 'email_1', keys: { email: 1 }, unique: true },
    { name: 'name_1', keys: { name: 1 }, unique: false },
  ]);
  expect(cols[1]!.validator).toEqual({ $jsonSchema: { bsonType: 'object', required: ['email'] } });
  expect(cols[0]!.validator).toBeNull();
}

describe.each(engines)('database layer on $kind', (e) => {
  const tag = randomBytes(3).toString('hex');
  const project = `mrdb-${e.kind}-${tag}`;
  const opIds: string[] = [];
  let dir = '';
  let ref: DbRef;
  let base: SchemaSnapshot;

  const op = (name: string) => {
    const id = `${e.kind}-${name}-${tag}`;
    opIds.push(id);
    return id;
  };
  const compose = (...extra: string[]) => ['compose', '-p', project, '--project-directory', dir, '-f', join(dir, 'compose.yml'), ...extra];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mrdb-'));
    await writeFile(join(dir, 'compose.yml'), JSON.stringify({ services: e.services, ...(e.volumes ? { volumes: e.volumes } : {}) }, null, 2));
    await writeFile(join(dir, 'mysql-url.sh'), MYSQL_URL_SH);
    await dk(compose('up', '-d', '--wait', '--wait-timeout', '300'));
    await e.seed((service, args, input) => dk(compose('exec', '-T', service, ...args), input));
    const c: ComposeRef = { project, dir, files: ['compose.yml'] };
    ref = { compose: c, service: 'app', dbKind: e.kind, dbUrlEnv: 'DATABASE_URL' };
  });

  afterAll(async () => {
    for (const id of opIds) await docker(['rm', '-f', `microrun-dryrun-${id}`]);
    if (dir) {
      await docker(compose('down', '-v', '--remove-orphans', '--timeout', '1'));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves the url, network and kind from the service env', async () => {
    const { resolveDb } = await lib();
    const r = await resolveDb(ref);
    expect(r).toMatchObject({ url: e.urls.app, network: `${project}_default`, kind: e.kind });
    if (e.kind === 'sqlite') {
      expect(r.volumesFrom).toEqual(expect.any(String));
      const info = await dk(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}} {{.State.Running}}', r.volumesFrom!]);
      expect(info.trim()).toBe(`${project} app true`);
    } else {
      expect(r.volumesFrom).toBeNull();
    }
    expect((await resolveDb(ref, 'other')).url).toBe(e.urls.other);
  });

  it('snapshots the known schema into normalized tables and indexes', async () => {
    const { snapshotSchema } = await lib();
    const s = await snapshotSchema(ref);
    expect(snapshotShape.safeParse(s).success).toBe(true);
    if (e.kind === 'mongodb') expectMongoSnapshot(s);
    else expectSqlSnapshot(s, e.kind, e.types!);
    base = s;
  });

  it('writes and reads markers, and reports the other env for a second database', async () => {
    const { readMarkers, writeMarker, snapshotSchema } = await lib();
    expect(await readMarkers(ref, ['app', 'other'])).toEqual([
      { service: 'app', marker: null },
      { service: 'other', marker: null },
    ]);
    await writeMarker(ref, 'env-a', 'staging');
    await writeMarker({ ...ref, service: 'other' }, 'env-b', 'production');
    expect(await readMarkers(ref, ['app', 'other'])).toEqual([
      { service: 'app', marker: { envId: 'env-a', envName: 'staging' } },
      { service: 'other', marker: { envId: 'env-b', envName: 'production' } },
    ]);
    expect(await snapshotSchema(ref)).toEqual(base);
  });

  it('dry-runs an expand adding a nullable column as add and leaves the real db unchanged', async () => {
    const { dryRunExpand, snapshotSchema } = await lib();
    const opId = op('add');
    const r = await dryRunExpand(ref, {
      image: e.appImage, cmd: e.addCmd, migrationTables: ['knex_migrations'], opId, env: { NEW_COL: 'nickname' },
    });
    expect(snapshotShape.safeParse(r.snapshot).success).toBe(true);
    expect(diffSchema(base, r.snapshot)).toEqual([{ ...e.addDiff, detail: expect.any(String) }]);
    expect(await snapshotSchema(ref)).toEqual(base);
    expect(await dryrunContainers(opId)).toEqual([]);
  });

  it('dry-runs an expand dropping a column as drop and the real db keeps it', async () => {
    const { dryRunExpand, snapshotSchema } = await lib();
    const opId = op('drop');
    const r = await dryRunExpand(ref, {
      image: e.appImage, cmd: e.dropCmd, migrationTables: ['knex_migrations'], opId, env: {},
    });
    expect(diffSchema(base, r.snapshot)).toEqual([{ ...e.dropDiff, detail: expect.any(String) }]);
    expect(await snapshotSchema(ref)).toEqual(base);
    expect(await dryrunContainers(opId)).toEqual([]);
  });

  it('fails a broken expand with MIGRATION_FAILED carrying the log and removes the temp container', async () => {
    const { dryRunExpand, snapshotSchema } = await lib();
    const opId = op('fail');
    const err = await dryRunExpand(ref, {
      image: e.appImage, cmd: 'echo expand-broke >&2; exit 3', migrationTables: ['knex_migrations'], opId, env: {},
    }).then(() => null, (x: unknown) => x);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe('MIGRATION_FAILED');
    expect(JSON.stringify((err as AgentError).params)).toContain('expand-broke');
    expect(await dryrunContainers(opId)).toEqual([]);
    expect(await snapshotSchema(ref)).toEqual(base);
  });
});

describe('cleanup --dry-run output through runOneOff', () => {
  const project = `mrdb-cleanup-${randomBytes(3).toString('hex')}`;
  let dir = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mrdb-'));
    await writeFile(join(dir, 'compose.yml'), JSON.stringify({
      services: { app: { image: 'postgres:17-alpine', command: IDLE, volumes: ['./:/fixture:ro'] } },
    }, null, 2));
    await writeFile(join(dir, 'cleanup.sh'), CLEANUP_SH);
  });

  afterAll(async () => {
    if (dir) {
      await docker(['compose', '-p', project, '--project-directory', dir, '-f', join(dir, 'compose.yml'), 'down', '--remove-orphans']);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('parses valid lines and sends non-JSON, wrong-shape and over-64KiB lines to the log', async () => {
    const r = await runOneOff({ project, dir, files: ['compose.yml'] }, {
      service: 'app', image: 'postgres:17-alpine', cmd: 'sh /fixture/cleanup.sh', args: [], env: {},
    });
    expect(r.exitCode).toBe(0);
    const parsed = parseCleanupLines(r.stdout, 'dry-run');
    expect(parsed.lines).toEqual([
      { rule: 'old-sessions', description: 'Sessions older than 30 days', count: 12 },
      { rule: 'orphans', description: 'Orphan uploads', count: 0 },
    ]);
    expect(parsed.other).toHaveLength(4);
    expect(parsed.other[0]).toBe('starting cleanup preview');
    expect(parsed.other[1]).toBe('{"rule":"bad","count":"many"}');
    expect(parsed.other[2]!.length).toBeGreaterThan(65536);
    expect(parsed.other[3]).toBe('not json {');
  });
});
