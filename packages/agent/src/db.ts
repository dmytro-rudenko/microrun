import { posix } from 'node:path';
import { AgentError, type DbRef } from '@microrun/core/protocol';
import {
  snapshotSchema as snapshotShape,
  type DbKind, type Index, type MongoSnapshot, type SchemaSnapshot, type SqlSnapshot,
} from '@microrun/core/schema';
import { composeConfig, runOneOff, serviceEnv, serviceNetwork, type ComposeModel } from './compose.ts';
import { docker } from './docker.ts';

export const DEFAULT_MIGRATION_TABLES = [
  'knex_migrations', 'knex_migrations_lock', '_prisma_migrations', 'migrations', 'typeorm_metadata',
  'SequelizeMeta', 'schema_migrations', 'flyway_schema_history', 'changelog',
];

const MARKER = '_microrun_env';
const DRYRUN_PASSWORD = 'microrun-dryrun';
const TIMEOUT_MS = 15 * 60 * 1000;
const READY_ATTEMPTS = 180;
const LOG_TAIL = 8000;

const CLIENT_IMAGE: Record<DbKind, string> = {
  postgres: 'postgres:18-alpine',
  mysql: 'mysql:8.4',
  mongodb: 'mongo:8',
  sqlite: 'keinos/sqlite3:3.50.4',
};

const CLIENT_CMD: Record<DbKind, string> = {
  postgres: 'psql "$MR_DB_URL" -X -q -A -t -v ON_ERROR_STOP=1',
  mysql: 'mysql -h "$MR_HOST" -P "$MR_PORT" -u "$MR_USER" -N -B -r "$MR_DB"',
  mongodb: 'mongosh "$MR_DB_URL" --quiet --eval "$(cat)"',
  sqlite: 'sqlite3 -batch -bail "$MR_DB_FILE"',
};

const SQL_INTROSPECT = {
  postgres: `
select coalesce(jsonb_agg(c.relname), '[]'::jsonb) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p');
select coalesce(jsonb_agg(jsonb_build_object('table', c.relname, 'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
    'nullable', not a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid), 'pos', a.attnum)), '[]'::jsonb)
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped;
select coalesce(jsonb_agg(jsonb_build_object('table', c.relname, 'name', ic.relname, 'column', a.attname, 'seq', k.ord, 'unique', i.indisunique)), '[]'::jsonb)
  from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
  join pg_class ic on ic.oid = i.indexrelid
  cross join lateral unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
  join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
  where n.nspname = 'public' and k.ord <= i.indnkeyatts;
`,
  mysql: `
SELECT JSON_ARRAYAGG(TABLE_NAME) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE';
SELECT JSON_ARRAYAGG(JSON_OBJECT('table', TABLE_NAME, 'name', COLUMN_NAME, 'type', COLUMN_TYPE, 'nullable', IS_NULLABLE = 'YES',
  'default', COLUMN_DEFAULT, 'pos', ORDINAL_POSITION)) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE();
SELECT JSON_ARRAYAGG(JSON_OBJECT('table', TABLE_NAME, 'name', INDEX_NAME, 'column', COLUMN_NAME, 'seq', SEQ_IN_INDEX,
  'unique', NON_UNIQUE = 0)) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE();
`,
  sqlite: `
select json_group_array(name) from sqlite_schema where type = 'table' and name not like 'sqlite\\_%' escape '\\';
select json_group_array(json_object('table', m.name, 'name', p.name, 'type', p.type, 'nullable', p."notnull" = 0,
  'default', p.dflt_value, 'pos', p.cid)) from sqlite_schema m join pragma_table_info(m.name) p
  where m.type = 'table' and m.name not like 'sqlite\\_%' escape '\\';
select json_group_array(json_object('table', m.name, 'name', il.name, 'column', ii.name, 'seq', ii.seqno, 'unique', il."unique"))
  from sqlite_schema m join pragma_index_list(m.name) il join pragma_index_info(il.name) ii
  where m.type = 'table' and m.name not like 'sqlite\\_%' escape '\\';
`,
};

const MONGO_INTROSPECT = `print(EJSON.stringify(db.getCollectionInfos({ type: 'collection' })
  .filter((c) => !c.name.startsWith('system.'))
  .map((c) => ({
    name: c.name,
    validator: (c.options && c.options.validator) || null,
    indexes: db.getCollection(c.name).getIndexes().map((i) => ({ name: i.name, keys: i.key, unique: Boolean(i.unique) })),
  }))));`;

const READ_MARKER: Record<Exclude<DbKind, 'sqlite'>, string> = {
  postgres: `select to_regclass('public.${MARKER}') is not null as has \\gset
\\if :has
select json_build_object('envId', env_id, 'envName', env_name) from ${MARKER} limit 1;
\\endif
`,
  mysql: `SET @q = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${MARKER}') > 0,
  'SELECT JSON_OBJECT(''envId'', env_id, ''envName'', env_name) FROM ${MARKER} LIMIT 1', 'SELECT 1 FROM DUAL WHERE FALSE');
PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s;
`,
  mongodb: `const d = db.getCollection('${MARKER}').findOne(); print(EJSON.stringify(d ? { envId: d.env_id, envName: d.env_name } : null));`,
};

interface Target { url: string; network: string; volumesFrom: string | null; kind: DbKind }
type Marker = { envId: string; envName: string };
type RawCol = { table: string; name: string; type: string; nullable: unknown; default: unknown; pos: number };
type RawIdx = { table: string; name: string; column: string | null; seq: number; unique: unknown };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 't';
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function lastLine(out: string): string {
  return out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
}

function secrets(url: string): string[] {
  try {
    const u = new URL(url);
    return [url, u.password, decodeURIComponent(u.password)].filter(Boolean);
  } catch {
    return [url];
  }
}

function scrub(text: string, redact: string[]): string {
  return redact.filter(Boolean).reduce((acc, r) => acc.split(r).join('***'), text);
}

function sqliteFile(url: string): string {
  return url.replace(/^(sqlite|file):(\/\/)?/, '').replace(/\?.*$/, '');
}

function urlParts(url: string): { user: string; password: string; host: string; port: string; db: string } {
  const u = new URL(url);
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    host: u.hostname,
    port: u.port,
    db: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
}

function connEnv(t: Target): Record<string, string> {
  if (t.kind === 'sqlite') return { MR_DB_FILE: sqliteFile(t.url) };
  if (t.kind !== 'mysql') return { MR_DB_URL: t.url };
  const p = urlParts(t.url);
  return { MR_HOST: p.host, MR_PORT: p.port || '3306', MR_USER: p.user, MYSQL_PWD: p.password, MR_DB: p.db };
}

const envArgs = (env: Record<string, string>) => Object.keys(env).flatMap((k) => ['-e', k]);

async function runClient(
  t: Target, script: string,
  o: { input?: string; env?: Record<string, string>; args?: string[]; name?: string; redact?: string[] } = {},
): Promise<string> {
  const env = { ...connEnv(t), ...o.env };
  const redact = [...secrets(t.url), ...(o.redact ?? [])];
  const r = await docker([
    'run', '--rm', '-i', ...(o.name ? ['--name', o.name] : []), '--network', t.network,
    ...(t.volumesFrom ? ['--volumes-from', t.volumesFrom, '--user', '0'] : []),
    ...envArgs(env), '--entrypoint', '/bin/sh', CLIENT_IMAGE[t.kind], '-c', script, 'sh', ...(o.args ?? []),
  ], { input: o.input, env, redact, timeoutMs: TIMEOUT_MS });
  if (r.code !== 0) throw new Error(`${t.kind} client failed: ${r.stderr.trim()}`);
  return r.stdout;
}

const query = (t: Target, input: string) => runClient(t, CLIENT_CMD[t.kind], { input });

async function runningContainer(db: DbRef, service: string): Promise<string> {
  const r = await docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${db.compose.project}`,
    '--filter', `label=com.docker.compose.service=${service}`, '--filter', 'label=com.docker.compose.oneoff=False']);
  const id = r.code === 0 ? r.stdout.split('\n').map((s) => s.trim()).find(Boolean) : undefined;
  if (!id) throw new AgentError('DB_NOT_BOUND', { service, reason: 'no running container' });
  return id;
}

async function target(db: DbRef, model: ComposeModel, service: string): Promise<Target | null> {
  const url = serviceEnv(model, service)[db.dbUrlEnv];
  if (!url) return null;
  return {
    url,
    network: serviceNetwork(model, service, db.compose.project),
    volumesFrom: db.dbKind === 'sqlite' ? await runningContainer(db, service) : null,
    kind: db.dbKind,
  };
}

export async function resolveDb(db: DbRef, viaService: string = db.service): Promise<Target> {
  const t = await target(db, await composeConfig(db.compose), viaService);
  if (!t) throw new AgentError('DB_NOT_BOUND', { service: viaService, env: db.dbUrlEnv });
  return t;
}

function indexesOf(rows: RawIdx[]): Index[] {
  const m = new Map<string, { unique: boolean; cols: [number, string][] }>();
  for (const r of rows) {
    if (r.column == null) continue;
    const e = m.get(r.name) ?? { unique: truthy(r.unique), cols: [] };
    e.cols.push([Number(r.seq), r.column]);
    m.set(r.name, e);
  }
  return [...m].sort(([a], [b]) => byName(a, b))
    .map(([name, e]) => ({ name, columns: e.cols.sort((a, b) => a[0] - b[0]).map((c) => c[1]), unique: e.unique }));
}

async function rawSnapshot(t: Target): Promise<SchemaSnapshot> {
  if (t.kind === 'mongodb') {
    const cols = JSON.parse(lastLine(await query(t, MONGO_INTROSPECT)) || '[]') as MongoSnapshot['collections'];
    return { kind: 'mongo', collections: cols.sort((a, b) => byName(a.name, b.name)) };
  }
  const lines = (await query(t, SQL_INTROSPECT[t.kind])).split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => (l === 'NULL' ? [] : JSON.parse(l) as unknown[]));
  const [tables = [], cols = [], idx = []] = lines as [string[]?, RawCol[]?, RawIdx[]?];
  return {
    kind: 'sql',
    engine: t.kind,
    tables: [...tables].sort(byName).map((name) => ({
      name,
      columns: cols.filter((c) => c.table === name).sort((a, b) => a.pos - b.pos).map((c) => ({
        name: c.name, type: c.type, nullable: truthy(c.nullable), default: c.default == null ? null : String(c.default),
      })),
      indexes: indexesOf(idx.filter((i) => i.table === name)),
    })),
  };
}

function objectNames(s: SchemaSnapshot): string[] {
  return s.kind === 'sql' ? s.tables.map((t) => t.name) : s.collections.map((c) => c.name);
}

function excluding(s: SchemaSnapshot, extra: string[]): SchemaSnapshot {
  const skip = new Set([MARKER, ...DEFAULT_MIGRATION_TABLES, ...extra]);
  const out: SchemaSnapshot = s.kind === 'sql'
    ? { ...s, tables: s.tables.filter((t) => !skip.has(t.name)) } as SqlSnapshot
    : { ...s, collections: s.collections.filter((c) => !skip.has(c.name)) };
  return snapshotShape.parse(out);
}

export async function snapshotSchema(db: DbRef): Promise<SchemaSnapshot> {
  return excluding(await rawSnapshot(await resolveDb(db)), []);
}

async function readMarker(t: Target): Promise<Marker | null> {
  let out: string;
  if (t.kind === 'sqlite') {
    const has = await query(t, `select count(*) from sqlite_schema where type = 'table' and name = '${MARKER}';`);
    if (lastLine(has) !== '1') return null;
    out = await query(t, `select json_object('envId', env_id, 'envName', env_name) from ${MARKER} limit 1;`);
  } else {
    out = await query(t, READ_MARKER[t.kind]);
  }
  const line = lastLine(out);
  if (!line || line === 'NULL' || line === 'null') return null;
  const v = JSON.parse(line) as { envId?: unknown; envName?: unknown };
  return { envId: String(v.envId), envName: String(v.envName) };
}

export async function readMarkers(db: DbRef, services: string[]): Promise<{ service: string; marker: Marker | null }[]> {
  const model = await composeConfig(db.compose);
  const found = await Promise.all(services.map(async (service) => {
    const t = await target(db, model, service);
    return t ? { service, marker: await readMarker(t) } : null;
  }));
  return found.filter((x): x is { service: string; marker: Marker | null } => x !== null);
}

function lit(kind: DbKind, s: string): string {
  return `'${(kind === 'mysql' ? s.replace(/\\/g, '\\\\') : s).replace(/'/g, "''")}'`;
}

export async function writeMarker(db: DbRef, envId: string, envName: string): Promise<void> {
  const t = await resolveDb(db);
  if (t.kind === 'mongodb') {
    await query(t, `const c = db.getCollection('${MARKER}'); c.deleteMany({});
c.insertOne({ env_id: ${JSON.stringify(envId)}, env_name: ${JSON.stringify(envName)}, bound_at: new Date().toISOString() });`);
    return;
  }
  const now = {
    postgres: `to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
    mysql: `DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ')`,
    sqlite: `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
  }[t.kind];
  await query(t, `${t.kind === 'mysql' ? 'START TRANSACTION' : 'BEGIN'};
CREATE TABLE IF NOT EXISTS ${MARKER} (env_id text, env_name text, bound_at text);
DELETE FROM ${MARKER};
INSERT INTO ${MARKER} (env_id, env_name, bound_at) VALUES (${lit(t.kind, envId)}, ${lit(t.kind, envName)}, ${now});
COMMIT;
`);
}

async function dockerOk(args: string[], what: string, o: { env?: Record<string, string>; redact?: string[] } = {}): Promise<string> {
  const r = await docker(args, { env: o.env, redact: o.redact, timeoutMs: TIMEOUT_MS });
  if (r.code !== 0) throw new Error(`${what}: ${r.stderr.trim()}`);
  return r.stdout;
}

async function waitReady(name: string, cmd: string[], env: Record<string, string> = {}): Promise<void> {
  for (let i = 0; i < READY_ATTEMPTS; i++) {
    const r = await docker(['exec', ...envArgs(env), name, ...cmd], { env, timeoutMs: 30_000 });
    if (r.code === 0) return;
    await sleep(1000);
  }
  throw new Error(`dry-run database ${name} did not become ready`);
}

async function startTemp(name: string, network: string, env: Record<string, string>, image: string, cmd: string[] = []): Promise<void> {
  await dockerOk(['run', '-d', '--name', name, '--network', network, ...envArgs(env), image, ...cmd],
    'dry-run database failed to start', { env });
}

async function execIn(name: string, script: string, env: Record<string, string>, args: string[], redact: string[]): Promise<void> {
  await dockerOk(['exec', ...envArgs(env), name, 'sh', '-c', script, 'sh', ...args], 'dry-run load failed', { env, redact });
}

async function preparePostgres(src: Target, name: string, tables: string[]): Promise<Target> {
  const major = Math.floor(Number(lastLine(await query(src, 'show server_version_num;'))) / 10000);
  const p = urlParts(src.url);
  const user = p.user || 'postgres';
  const dbName = p.db || user;
  await startTemp(name, src.network, { POSTGRES_PASSWORD: DRYRUN_PASSWORD, POSTGRES_USER: user, POSTGRES_DB: dbName }, `postgres:${major}`);
  await waitReady(name, ['pg_isready', '-h', '127.0.0.1', '-U', user, '-d', dbName]);
  const load = 'psql -X -q -v ON_ERROR_STOP=1 -U "$MR_USER" -d "$MR_DB" -f';
  const env = { MR_SRC: src.url, MR_USER: user, MR_DB: dbName };
  await execIn(name, `pg_dump "$MR_SRC" --schema-only --no-owner --no-privileges -f /tmp/schema.sql && ${load} /tmp/schema.sql`,
    env, [], secrets(src.url));
  if (tables.length > 0) {
    await execIn(name, `pg_dump "$MR_SRC" --data-only --no-owner "$@" -f /tmp/data.sql && ${load} /tmp/data.sql`,
      env, tables.flatMap((t) => ['-t', `"public"."${t}"`]), secrets(src.url));
  }
  const url = `postgres://${encodeURIComponent(user)}:${DRYRUN_PASSWORD}@${name}:5432/${encodeURIComponent(dbName)}`;
  return { ...src, url };
}

async function prepareMysql(src: Target, name: string, tables: string[]): Promise<Target> {
  const m = /^(\d+)\.(\d+)/.exec(lastLine(await query(src, 'SELECT VERSION();')));
  if (!m) throw new Error('cannot detect the MySQL server version');
  const p = urlParts(src.url);
  await startTemp(name, src.network, { MYSQL_ROOT_PASSWORD: DRYRUN_PASSWORD, MYSQL_DATABASE: p.db }, `mysql:${m[1]}.${m[2]}`);
  await waitReady(name, ['mysqladmin', 'ping', '-h', '127.0.0.1', '-uroot', '--silent'], { MYSQL_PWD: DRYRUN_PASSWORD });
  const dump = 'MYSQL_PWD="$MR_SRC_PW" mysqldump -h "$MR_HOST" -P "$MR_PORT" -u "$MR_USER" --single-transaction --set-gtid-purged=OFF --no-tablespaces';
  const load = 'MYSQL_PWD="$MR_DST_PW" mysql -h 127.0.0.1 -uroot "$MR_DB" <';
  const env = { MR_HOST: p.host, MR_PORT: p.port || '3306', MR_USER: p.user, MR_SRC_PW: p.password, MR_DST_PW: DRYRUN_PASSWORD, MR_DB: p.db };
  await execIn(name, `${dump} --no-data "$MR_DB" > /tmp/schema.sql && ${load} /tmp/schema.sql`, env, [], secrets(src.url));
  if (tables.length > 0) {
    await execIn(name, `${dump} --no-create-info "$MR_DB" "$@" > /tmp/data.sql && ${load} /tmp/data.sql`, env, tables, secrets(src.url));
  }
  return { ...src, url: `mysql://root:${DRYRUN_PASSWORD}@${name}:3306/${encodeURIComponent(p.db)}` };
}

async function prepareMongo(src: Target, name: string, tables: string[]): Promise<Target> {
  const major = /^(\d+)/.exec(lastLine(await query(src, 'print(db.version())')))?.[1];
  if (!major) throw new Error('cannot detect the MongoDB server version');
  const p = urlParts(src.url);
  const dbName = p.db || 'test';
  await startTemp(name, src.network, {}, `mongo:${major}`);
  const url = `mongodb://${name}:27017/${encodeURIComponent(dbName)}`;
  await waitReady(name, ['mongosh', '--quiet', url, '--eval', 'db.adminCommand({ ping: 1 }).ok']);
  const script = `const src = new Mongo(process.env.MR_SRC).getDB(${JSON.stringify(dbName)});
const copy = ${JSON.stringify(tables)};
for (const c of src.getCollectionInfos({ type: 'collection' })) {
  if (c.name.startsWith('system.')) continue;
  db.createCollection(c.name, c.options || {});
  const idx = src.getCollection(c.name).getIndexes().filter((i) => i.name !== '_id_').map(({ v, ns, ...rest }) => rest);
  if (idx.length > 0) db.runCommand({ createIndexes: c.name, indexes: idx });
  if (copy.includes(c.name)) {
    const docs = src.getCollection(c.name).find().toArray();
    if (docs.length > 0) db.getCollection(c.name).insertMany(docs);
  }
}`;
  await execIn(name, 'mongosh --quiet "$MR_DST" --eval "$MR_SCRIPT"', { MR_SRC: src.url, MR_DST: url, MR_SCRIPT: script }, [], secrets(src.url));
  return { ...src, url };
}

function sqliteTemp(src: Target, opId: string): { file: string; url: string } {
  const f = sqliteFile(src.url);
  const file = posix.join(posix.dirname(f), `microrun-dryrun-${opId}.db`);
  return { file, url: src.url.replace(f, file) };
}

async function prepareSqlite(src: Target, name: string, tables: string[], opId: string): Promise<Target> {
  const tmp = sqliteTemp(src, opId);
  await runClient(src, `set -e
rm -f "$MR_TMP"
sqlite3 "$MR_DB_FILE" '.schema --nosys' > /tmp/load.sql
for t in "$@"; do sqlite3 "$MR_DB_FILE" ".mode insert \\"$t\\"" "SELECT * FROM \\"$t\\";" >> /tmp/load.sql; done
sqlite3 -bail "$MR_TMP" < /tmp/load.sql`, { name, env: { MR_TMP: tmp.file }, args: tables });
  return { ...src, url: tmp.url };
}

export async function dryRunExpand(
  db: DbRef,
  p: { image: string; cmd: string; migrationTables: string[]; opId: string; env: Record<string, string> },
): Promise<{ snapshot: SchemaSnapshot; log: string }> {
  const src = await resolveDb(db);
  const name = `microrun-dryrun-${p.opId}`;
  const present = new Set(objectNames(await rawSnapshot(src)));
  const tables = p.migrationTables.filter((t) => present.has(t));
  const redact = secrets(src.url);
  try {
    const tmp = src.kind === 'postgres' ? await preparePostgres(src, name, tables)
      : src.kind === 'mysql' ? await prepareMysql(src, name, tables)
        : src.kind === 'mongodb' ? await prepareMongo(src, name, tables)
          : await prepareSqlite(src, name, tables, p.opId);
    const r = await runOneOff(db.compose, {
      service: db.service, image: p.image, cmd: p.cmd, args: [], env: { ...p.env, [db.dbUrlEnv]: tmp.url },
    });
    const log = scrub([r.stdout, r.log].filter(Boolean).join('\n'), redact);
    if (r.exitCode !== 0) throw new AgentError('MIGRATION_FAILED', { exitCode: r.exitCode, log: log.slice(-LOG_TAIL) });
    return { snapshot: excluding(await rawSnapshot(tmp), p.migrationTables), log };
  } finally {
    await docker(['rm', '-f', '-v', name]);
    if (src.kind === 'sqlite') {
      await runClient(src, 'rm -f "$MR_TMP" "$MR_TMP-journal" "$MR_TMP-wal" "$MR_TMP-shm"', {
        env: { MR_TMP: sqliteTemp(src, p.opId).file },
      }).catch(() => undefined);
    }
  }
}
