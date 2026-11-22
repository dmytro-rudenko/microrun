import { z } from 'zod';

export type DbKind = 'postgres' | 'mysql' | 'sqlite' | 'mongodb';
export interface Column { name: string; type: string; nullable: boolean; default: string | null }
export interface Index { name: string; columns: string[]; unique: boolean }
export interface SqlSnapshot {
  kind: 'sql';
  engine: 'postgres' | 'mysql' | 'sqlite';
  tables: { name: string; columns: Column[]; indexes: Index[] }[];
}
export interface MongoSnapshot {
  kind: 'mongo';
  collections: { name: string; indexes: { name: string; keys: Record<string, number | string>; unique: boolean }[]; validator: unknown | null }[];
}
export type SchemaSnapshot = SqlSnapshot | MongoSnapshot;
export interface DiffEntry { kind: 'add' | 'warn' | 'drop'; object: string; detail: string }

type SqlEngine = SqlSnapshot['engine'];

const columnSchema = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean(),
  default: z.string().nullable(),
});

const indexSchema = z.object({ name: z.string(), columns: z.array(z.string()), unique: z.boolean() });

const sqlSchema = z.object({
  kind: z.literal('sql'),
  engine: z.enum(['postgres', 'mysql', 'sqlite']),
  tables: z.array(z.object({ name: z.string(), columns: z.array(columnSchema), indexes: z.array(indexSchema) })),
});

const mongoSchema = z.object({
  kind: z.literal('mongo'),
  collections: z.array(
    z.object({
      name: z.string(),
      indexes: z.array(
        z.object({
          name: z.string(),
          keys: z.record(z.string(), z.union([z.number(), z.string()])),
          unique: z.boolean(),
        }),
      ),
      validator: z.custom<unknown>((v) => v !== undefined).nullable(),
    }),
  ),
});

export const snapshotSchema: z.ZodType<SchemaSnapshot> = z.discriminatedUnion('kind', [sqlSchema, mongoSchema]);

const POSTGRES_ALIASES: Record<string, string> = {
  integer: 'int',
  int4: 'int',
  int8: 'bigint',
  int2: 'smallint',
  'timestamp with time zone': 'timestamptz',
  boolean: 'bool',
};

function sqliteAffinity(t: string): string {
  if (t.includes('int')) return 'INTEGER';
  if (t.includes('char') || t.includes('clob') || t.includes('text')) return 'TEXT';
  if (t === '' || t.includes('blob')) return 'BLOB';
  if (t.includes('real') || t.includes('floa') || t.includes('doub')) return 'REAL';
  return 'NUMERIC';
}

export function normalizeType(engine: SqlEngine, raw: string): string {
  const t = raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1');
  if (engine === 'postgres') {
    const v = t.replace(/^character varying/, 'varchar');
    return POSTGRES_ALIASES[v] ?? v;
  }
  if (engine === 'mysql') return t.replace(/^(tinyint|smallint|mediumint|int|integer|bigint)\(\d+\)/, '$1').replace(/^decimal\b/, 'numeric');
  return sqliteAffinity(t);
}

function wrappedInParens(s: string): boolean {
  if (!s.startsWith('(') || !s.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    if (depth === 0 && i < s.length - 1) return false;
  }
  return depth === 0;
}

export function normalizeDefault(raw: string | null): string | null {
  if (raw === null) return null;
  let s = raw.trim().replace(/\s+/g, ' ');
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(/::[a-z_][a-z0-9_ ]*(\(\d+(,\s*\d+)?\))?(\[\])?$/i, '').trim();
    if (wrappedInParens(s)) s = s.slice(1, -1).trim();
    s = s.replace(/^'('.*')'$/, '$1');
  }
  return s.replace(/\bnow\(\)/gi, 'now()').replace(/\bcurrent_timestamp\b/gi, 'current_timestamp');
}

function parseType(t: string): { base: string; args: number[] | null } {
  const m = /^([a-z ]+)\((\d+(?:,\d+)*)\)$/.exec(t);
  if (!m) return { base: t, args: null };
  return { base: m[1] ?? t, args: (m[2] ?? '').split(',').map(Number) };
}

const INTEGER_RANK = ['smallint', 'int', 'bigint'];

type ParsedType = ReturnType<typeof parseType>;

function varcharWidening(a: ParsedType, b: ParsedType): boolean {
  if (b.args === null) return true;
  return a.args !== null && (b.args[0] ?? 0) > (a.args[0] ?? 0);
}

function numericWidening(from: number[], b: ParsedType): boolean {
  if (b.args === null) return true;
  const [p = 0, s = 0] = from;
  const [p2 = 0, s2 = 0] = b.args;
  return p2 - s2 >= p - s && s2 >= s;
}

function isWidening(from: string, to: string): boolean {
  const a = parseType(from);
  const b = parseType(to);
  if (a.base === 'varchar' && b.base === 'varchar') return varcharWidening(a, b);
  if (a.base === 'varchar' && to === 'text') return true;
  const ia = INTEGER_RANK.indexOf(from);
  const ib = INTEGER_RANK.indexOf(to);
  if (ia >= 0 && ib >= 0) return ib > ia;
  if (a.base === 'numeric' && b.base === 'numeric' && a.args !== null) return numericWidening(a.args, b);
  return false;
}

function byName<T extends { name: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.name, i]));
}

function diffIndexes<T extends { name: string; unique: boolean }>(base: T[], next: T[]): DiffEntry[] {
  const out: DiffEntry[] = [];
  const b = byName(base);
  const n = byName(next);
  for (const [name, bi] of b) {
    const ni = n.get(name);
    if (!ni) out.push({ kind: 'warn', object: `index:${name}`, detail: 'index removed' });
    else if (JSON.stringify(bi) !== JSON.stringify(ni)) out.push({ kind: 'warn', object: `index:${name}`, detail: 'index changed' });
  }
  for (const [name, ni] of n) {
    if (b.has(name)) continue;
    out.push(ni.unique
      ? { kind: 'warn', object: `index:${name}`, detail: 'unique index added' }
      : { kind: 'add', object: `index:${name}`, detail: 'index added' });
  }
  return out;
}

function diffColumn(engine: SqlEngine, object: string, bc: Column, nc: Column): DiffEntry[] {
  const out: DiffEntry[] = [];
  const from = normalizeType(engine, bc.type);
  const to = normalizeType(engine, nc.type);
  if (from !== to) out.push({ kind: isWidening(from, to) ? 'add' : 'drop', object, detail: `${from} → ${to}` });
  if (bc.nullable && !nc.nullable) out.push({ kind: 'drop', object, detail: 'nullable → NOT NULL' });
  if (!bc.nullable && nc.nullable) out.push({ kind: 'add', object, detail: 'NOT NULL → nullable' });
  const d1 = normalizeDefault(bc.default);
  const d2 = normalizeDefault(nc.default);
  if (d1 !== d2) out.push({ kind: 'add', object, detail: `default ${d1} → ${d2}` });
  return out;
}

const addedColumn = (object: string, nc: Column): DiffEntry =>
  nc.nullable || nc.default !== null
    ? { kind: 'add', object, detail: 'column added' }
    : { kind: 'drop', object, detail: 'NOT NULL column added without default' };

function diffColumns(table: string, engine: SqlEngine, base: Column[], next: Column[]): DiffEntry[] {
  const out: DiffEntry[] = [];
  const b = byName(base);
  const n = byName(next);
  for (const [name, bc] of b) {
    const nc = n.get(name);
    if (nc) out.push(...diffColumn(engine, `${table}.${name}`, bc, nc));
    else out.push({ kind: 'drop', object: `${table}.${name}`, detail: 'column removed' });
  }
  for (const [name, nc] of n) if (!b.has(name)) out.push(addedColumn(`${table}.${name}`, nc));
  return out;
}

function diffSql(base: SqlSnapshot, next: SqlSnapshot): DiffEntry[] {
  const out: DiffEntry[] = [];
  const b = byName(base.tables);
  const n = byName(next.tables);
  for (const [name, bt] of b) {
    const nt = n.get(name);
    if (!nt) out.push({ kind: 'drop', object: name, detail: 'table removed' });
    else out.push(...diffColumns(name, next.engine, bt.columns, nt.columns), ...diffIndexes(bt.indexes, nt.indexes));
  }
  for (const name of n.keys()) if (!b.has(name)) out.push({ kind: 'add', object: name, detail: 'table added' });
  return out;
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableJson(x)}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function diffMongo(base: MongoSnapshot, next: MongoSnapshot): DiffEntry[] {
  const out: DiffEntry[] = [];
  const b = byName(base.collections);
  const n = byName(next.collections);
  for (const [name, bc] of b) {
    const nc = n.get(name);
    if (!nc) {
      out.push({ kind: 'drop', object: name, detail: 'collection removed' });
      continue;
    }
    out.push(...diffIndexes(bc.indexes, nc.indexes));
    if (stableJson(bc.validator) !== stableJson(nc.validator)) out.push({ kind: 'warn', object: name, detail: 'validator changed' });
  }
  for (const name of n.keys()) if (!b.has(name)) out.push({ kind: 'add', object: name, detail: 'collection added' });
  return out;
}

function emptied(s: SchemaSnapshot): SchemaSnapshot {
  return s.kind === 'sql' ? { ...s, tables: [] } : { ...s, collections: [] };
}

export function diffSchema(base: SchemaSnapshot, next: SchemaSnapshot): DiffEntry[] {
  if (base.kind === 'sql' && next.kind === 'sql') return diffSql(base, next);
  if (base.kind === 'mongo' && next.kind === 'mongo') return diffMongo(base, next);
  return [...diffSchema(base, emptied(base)), ...diffSchema(emptied(next), next)];
}

export function isDestructive(d: DiffEntry[]): boolean {
  return d.some((e) => e.kind === 'drop');
}

function dropKeys(d: DiffEntry[]): string[] {
  return [...new Set(d.filter((e) => e.kind === 'drop').map((e) => `${e.object}|${e.detail}`))].sort();
}

export function sameDestructive(a: DiffEntry[], b: DiffEntry[]): boolean {
  const ka = dropKeys(a);
  const kb = dropKeys(b);
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}
