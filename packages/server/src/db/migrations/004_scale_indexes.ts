import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('create index releases_env_deployed on releases(env_id, deployed_at)');
  await knex.raw('create index releases_deployed on releases(deployed_at)');
  await knex.raw('create index operations_env_started on operations(env_id, started_at)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('drop index operations_env_started');
  await knex.raw('drop index releases_deployed');
  await knex.raw('drop index releases_env_deployed');
}
