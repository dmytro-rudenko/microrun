import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`alter table environments add column compose_env_files text not null default '[]'`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('alter table environments drop column compose_env_files');
}
