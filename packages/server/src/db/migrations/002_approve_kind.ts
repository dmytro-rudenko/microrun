import type { Knex } from 'knex';

export const config = { transaction: false };

const table = (kinds: string[]) => `create table operations_new (
    id text primary key,
    env_id text not null references environments(id),
    kind text not null check (kind in (${kinds.map((k) => `'${k}'`).join(', ')})),
    from_release_id text null,
    to_release_id text null,
    actor text not null,
    status text not null check (status in ('pending', 'running', 'succeeded', 'failed', 'rejected')),
    code text null,
    params text null,
    log text not null default '',
    steps_done text not null default '{}',
    cleanup_result text null,
    started_at integer not null,
    finished_at integer null
  )`;

const KINDS = ['deploy', 'rollback', 'cleanup', 'contract', 'expire'];

async function rebuild(knex: Knex, kinds: string[]): Promise<void> {
  await knex.raw('pragma foreign_keys = off');
  try {
    await knex.transaction(async (tx) => {
      await tx.raw(table(kinds));
      await tx.raw('insert into operations_new select * from operations');
      await tx.raw('drop table operations');
      await tx.raw('alter table operations_new rename to operations');
      await tx.raw(`create unique index operations_one_running on operations(env_id) where status in ('pending', 'running')`);
      const broken = await tx.raw('pragma foreign_key_check');
      if (broken.length) throw new Error('operations rebuild broke a foreign key');
    });
  } finally {
    await knex.raw('pragma foreign_keys = on');
  }
}

export async function up(knex: Knex): Promise<void> {
  await rebuild(knex, [...KINDS, 'approve']);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`delete from operations where kind = 'approve'`);
  await rebuild(knex, KINDS);
}
