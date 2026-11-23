import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('alter table releases add column image_unpinned_at integer null');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('alter table releases drop column image_unpinned_at');
}
