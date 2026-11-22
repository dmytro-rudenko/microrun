import knex from 'knex';
import type { Knex } from 'knex';
import * as init from './migrations/001_init.ts';

const migrations: Record<string, Knex.Migration> = { '001_init': init };

const migrationSource: Knex.MigrationSource<string> = {
  getMigrations: async () => Object.keys(migrations),
  getMigrationName: (m) => m,
  getMigration: async (m) => migrations[m]!,
};

export async function openDb(file: string): Promise<Knex> {
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: file },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: 1,
      afterCreate: (conn: { pragma(s: string): unknown }, done: (err: Error | null, conn: unknown) => void) => {
        conn.pragma('journal_mode = WAL');
        conn.pragma('foreign_keys = ON');
        done(null, conn);
      },
    },
  });
  await db.migrate.latest({ migrationSource });
  return db;
}
