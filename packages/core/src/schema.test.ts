import { describe, test, expect } from 'vitest';
import {
  snapshotSchema,
  normalizeType,
  normalizeDefault,
  diffSchema,
  isDestructive,
  sameDestructive,
} from './schema.ts';
import type { Column, DiffEntry, Index, MongoSnapshot, SqlSnapshot } from './schema.ts';

const col = (name: string, type: string, nullable = true, def: string | null = null): Column => ({
  name,
  type,
  nullable,
  default: def,
});

const idx = (name: string, columns: string[], unique = false): Index => ({ name, columns, unique });

const sql = (
  tables: { name: string; columns: Column[]; indexes?: Index[] }[],
  engine: SqlSnapshot['engine'] = 'postgres',
): SqlSnapshot => ({
  kind: 'sql',
  engine,
  tables: tables.map((t) => ({ name: t.name, columns: t.columns, indexes: t.indexes ?? [] })),
});

const usersBase = (): { name: string; columns: Column[]; indexes: Index[] } => ({
  name: 'users',
  columns: [col('id', 'int', false), col('email', 'varchar(50)', false)],
  indexes: [],
});

const withUsers = (patch: (u: { name: string; columns: Column[]; indexes: Index[] }) => void): SqlSnapshot => {
  const u = usersBase();
  patch(u);
  return sql([u]);
};

const typeChange = (from: string, to: string): DiffEntry[] =>
  diffSchema(
    sql([{ name: 't', columns: [col('c', from)] }]),
    sql([{ name: 't', columns: [col('c', to)] }]),
  );

const mongo = (collections: MongoSnapshot['collections']): MongoSnapshot => ({ kind: 'mongo', collections });

const summary = (d: DiffEntry[]): string[] => d.map((e) => `${e.kind} ${e.object}`).sort();

describe('diffSchema classification', () => {
  test('identical snapshots give no diff', () => {
    expect(diffSchema(sql([usersBase()]), sql([usersBase()]))).toEqual([]);
  });

  test('new table is add', () => {
    const next = sql([usersBase(), { name: 'posts', columns: [col('id', 'int', false)] }]);
    expect(summary(diffSchema(sql([usersBase()]), next))).toEqual(['add posts']);
  });

  test('new collection is add', () => {
    const next = mongo([{ name: 'events', indexes: [], validator: null }]);
    expect(summary(diffSchema(mongo([]), next))).toEqual(['add events']);
  });

  test('new nullable column is add', () => {
    const next = withUsers((u) => u.columns.push(col('nickname', 'text', true)));
    expect(summary(diffSchema(sql([usersBase()]), next))).toEqual(['add users.nickname']);
  });

  test('new NOT NULL column with default is add', () => {
    const next = withUsers((u) => u.columns.push(col('active', 'bool', false, 'true')));
    expect(summary(diffSchema(sql([usersBase()]), next))).toEqual(['add users.active']);
  });

  test('new non-unique index is add', () => {
    const next = withUsers((u) => u.indexes.push(idx('users_email_idx', ['email'], false)));
    expect(summary(diffSchema(sql([usersBase()]), next))).toEqual(['add index:users_email_idx']);
  });

  test('varchar(n) → varchar(m>n) is add', () => {
    expect(summary(typeChange('varchar(50)', 'varchar(100)'))).toEqual(['add t.c']);
  });

  test('varchar(n) → varchar is add', () => {
    expect(summary(typeChange('varchar(50)', 'varchar'))).toEqual(['add t.c']);
  });

  test('varchar → text is add', () => {
    expect(summary(typeChange('varchar', 'text'))).toEqual(['add t.c']);
  });

  test('int → bigint is add', () => {
    expect(summary(typeChange('int', 'bigint'))).toEqual(['add t.c']);
  });

  test('smallint → int is add', () => {
    expect(summary(typeChange('smallint', 'int'))).toEqual(['add t.c']);
  });

  test('numeric(p,s) → numeric(p2,s2) with p2−s2 ≥ p−s and s2 ≥ s is add', () => {
    expect(summary(typeChange('numeric(10,2)', 'numeric(12,4)'))).toEqual(['add t.c']);
  });

  test('smallint → bigint is add', () => {
    expect(summary(typeChange('smallint', 'bigint'))).toEqual(['add t.c']);
  });

  test('bigint → int is drop', () => {
    expect(summary(typeChange('bigint', 'int'))).toEqual(['drop t.c']);
  });

  test('numeric(10,0) → numeric(10,5) cuts integer digits and is drop', () => {
    expect(summary(typeChange('numeric(10,0)', 'numeric(10,5)'))).toEqual(['drop t.c']);
  });

  test('numeric(p,s) → unbounded numeric is add on postgres', () => {
    expect(summary(typeChange('numeric(10,2)', 'numeric'))).toEqual(['add t.c']);
  });

  test('mysql decimal widening follows the numeric rule', () => {
    const mysqlChange = (from: string, to: string): DiffEntry[] =>
      diffSchema(
        sql([{ name: 't', columns: [col('c', from)] }], 'mysql'),
        sql([{ name: 't', columns: [col('c', to)] }], 'mysql'),
      );
    expect(summary(mysqlChange('decimal(10,2)', 'decimal(12,4)'))).toEqual(['add t.c']);
    expect(summary(mysqlChange('decimal(10,0)', 'decimal(10,5)'))).toEqual(['drop t.c']);
  });

  test('mysql normalizes decimal to numeric', () => {
    expect(normalizeType('mysql', 'decimal(10,2)')).toBe('numeric(10,2)');
  });

  test('new unique index is warn', () => {
    const next = withUsers((u) => u.indexes.push(idx('users_email_key', ['email'], true)));
    expect(summary(diffSchema(sql([usersBase()]), next))).toEqual(['warn index:users_email_key']);
  });

  test('removed index is warn', () => {
    const base = withUsers((u) => u.indexes.push(idx('users_email_idx', ['email'], false)));
    expect(summary(diffSchema(base, sql([usersBase()])))).toEqual(['warn index:users_email_idx']);
  });

  test('any Mongo validator change is warn', () => {
    const base = mongo([{ name: 'events', indexes: [], validator: { $jsonSchema: { required: ['a'] } } }]);
    const next = mongo([{ name: 'events', indexes: [], validator: { $jsonSchema: { required: ['a', 'b'] } } }]);
    expect(summary(diffSchema(base, next))).toEqual(['warn events']);
  });

  test('removed table is drop', () => {
    const base = sql([usersBase(), { name: 'posts', columns: [col('id', 'int', false)] }]);
    expect(summary(diffSchema(base, sql([usersBase()])))).toEqual(['drop posts']);
  });

  test('removed collection is drop', () => {
    const base = mongo([{ name: 'events', indexes: [], validator: null }]);
    expect(summary(diffSchema(base, mongo([])))).toEqual(['drop events']);
  });

  test('removed column is drop', () => {
    const next = withUsers((u) => {
      u.columns = u.columns.filter((c) => c.name !== 'email');
    });
    expect(summary(diffSchema(sql([usersBase()]), next))).toEqual(['drop users.email']);
  });

  test('any other type change is drop with a from → to detail', () => {
    const d = typeChange('varchar(50)', 'int');
    expect(summary(d)).toEqual(['drop t.c']);
    expect(d[0]?.detail).toBe('varchar(50) → int');
  });

  test('narrowing varchar is drop', () => {
    expect(summary(typeChange('varchar(100)', 'varchar(50)'))).toEqual(['drop t.c']);
  });

  test('nullable → NOT NULL is drop', () => {
    const base = sql([{ name: 't', columns: [col('c', 'text', true)] }]);
    const next = sql([{ name: 't', columns: [col('c', 'text', false)] }]);
    expect(summary(diffSchema(base, next))).toEqual(['drop t.c']);
  });

  test('new NOT NULL column without default is drop', () => {
    const next = withUsers((u) => u.columns.push(col('age', 'int', false, null)));
    expect(summary(diffSchema(sql([usersBase()]), next))).toEqual(['drop users.age']);
  });

  test('a renamed column gives drop + add', () => {
    const next = withUsers((u) => {
      u.columns = [col('id', 'int', false), col('mail', 'varchar(50)', true)];
    });
    expect(summary(diffSchema(sql([usersBase()]), next))).toEqual(['add users.mail', 'drop users.email']);
  });
});

describe('normalization', () => {
  test('character varying(20) and varchar(20) give no diff', () => {
    expect(typeChange('character varying(20)', 'varchar(20)')).toEqual([]);
  });

  test("'x'::text and 'x' defaults give no diff", () => {
    const base = sql([{ name: 't', columns: [col('c', 'text', false, "'x'::text")] }]);
    const next = sql([{ name: 't', columns: [col('c', 'text', false, "'x'")] }]);
    expect(diffSchema(base, next)).toEqual([]);
  });

  test.each([
    ['character varying(255)', 'varchar(255)'],
    ['character varying', 'varchar'],
    ['integer', 'int'],
    ['int4', 'int'],
    ['int8', 'bigint'],
    ['bigint', 'bigint'],
    ['int2', 'smallint'],
    ['smallint', 'smallint'],
    ['timestamp with time zone', 'timestamptz'],
    ['boolean', 'bool'],
    ['  TIMESTAMP   WITH TIME   ZONE ', 'timestamptz'],
  ])('postgres %s → %s', (raw, expected) => {
    expect(normalizeType('postgres', raw)).toBe(expected);
  });

  test('mysql strips int display widths', () => {
    expect(normalizeType('mysql', 'int(11)')).toBe('int');
    expect(normalizeType('mysql', 'INT(11)')).toBe('int');
  });

  test('sqlite maps declared types to their affinity', () => {
    const n = (raw: string): string => normalizeType('sqlite', raw);
    expect(n('BIGINT')).toBe(n('INTEGER'));
    expect(n('int')).toBe(n('INTEGER'));
    expect(n('VARCHAR(10)')).toBe(n('TEXT'));
    expect(n('CLOB')).toBe(n('TEXT'));
    expect(n('DOUBLE')).toBe(n('REAL'));
    expect(n('FLOAT')).toBe(n('REAL'));
    expect(n('BLOB')).not.toBe(n('TEXT'));
    expect(n('DECIMAL(10,2)')).toBe(n('NUMERIC'));
    expect(n('INTEGER')).not.toBe(n('TEXT'));
    expect(n('REAL')).not.toBe(n('NUMERIC'));
  });

  test('normalizeDefault strips casts and parentheses and lower-cases time functions', () => {
    expect(normalizeDefault(null)).toBeNull();
    expect(normalizeDefault("'x'::text")).toBe(normalizeDefault("'x'"));
    expect(normalizeDefault("('x'::character varying)")).toBe(normalizeDefault("'x'"));
    expect(normalizeDefault('NOW()')).toBe('now()');
    expect(normalizeDefault('CURRENT_TIMESTAMP')).toBe('current_timestamp');
  });
});

describe('isDestructive and sameDestructive', () => {
  const dropA: DiffEntry = { kind: 'drop', object: 'users.email', detail: 'column removed' };
  const dropB: DiffEntry = { kind: 'drop', object: 'posts', detail: 'table removed' };
  const add: DiffEntry = { kind: 'add', object: 'users.nickname', detail: 'column added' };
  const warn: DiffEntry = { kind: 'warn', object: 'index:i', detail: 'index removed' };

  test('isDestructive is true only when a drop is present', () => {
    expect(isDestructive([add, warn])).toBe(false);
    expect(isDestructive([add, dropA])).toBe(true);
    expect(isDestructive([])).toBe(false);
  });

  test('sameDestructive is true for the same drops in a different order', () => {
    expect(sameDestructive([dropA, add, dropB], [dropB, warn, dropA])).toBe(true);
  });

  test('sameDestructive is false for an extra drop', () => {
    expect(sameDestructive([dropA], [dropA, dropB])).toBe(false);
  });
});

describe('snapshotSchema', () => {
  test('round-trips a SQL snapshot', () => {
    const s = sql([
      {
        name: 'users',
        columns: [col('id', 'int', false), col('created_at', 'timestamptz', false, 'now()')],
        indexes: [idx('users_pkey', ['id'], true)],
      },
    ]);
    expect(snapshotSchema.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  test('round-trips a Mongo snapshot', () => {
    const s = mongo([
      {
        name: 'events',
        indexes: [{ name: 'ts_1', keys: { ts: 1, kind: 'hashed' }, unique: false }],
        validator: { $jsonSchema: { required: ['ts'] } },
      },
      { name: 'logs', indexes: [], validator: null },
    ]);
    expect(snapshotSchema.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  test('rejects an unknown engine', () => {
    expect(() => snapshotSchema.parse({ kind: 'sql', engine: 'oracle', tables: [] })).toThrow();
  });
});
