import type { Knex } from 'knex';

const statements = [
  `create table servers (
    id text primary key,
    name text not null unique,
    agent_token_hash text not null,
    builtin integer not null check (builtin in (0, 1)),
    proxy_mode text not null default 'external' check (proxy_mode in ('external', 'bundled')),
    last_seen_at integer null,
    agent_version text null
  )`,
  `create table environments (
    id text primary key,
    name text not null unique,
    branch text not null unique,
    is_production integer not null check (is_production in (0, 1)),
    position integer not null,
    server_id text not null references servers(id),
    compose_project text not null,
    compose_dir text not null,
    compose_files text not null,
    services text not null,
    migration_service text not null,
    db_kind text not null check (db_kind in ('postgres', 'mysql', 'sqlite', 'mongodb')),
    db_url_env text not null,
    db_marker_id text null unique,
    migration_tables text not null,
    expand_cmd text not null,
    contract_cmd text null,
    cleanup_cmd text null,
    schema_check text not null check (schema_check in ('dry_run', 'post_check')),
    health_timeout_s integer not null default 120,
    storage_kind text not null check (storage_kind in ('local', 'registry', 's3')),
    storage_config_enc blob not null,
    retention_s integer not null check (retention_s >= 3600),
    deploy_token_hash text not null
  )`,
  `create table operations (
    id text primary key,
    env_id text not null references environments(id),
    kind text not null check (kind in ('deploy', 'rollback', 'cleanup', 'contract', 'expire')),
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
  )`,
  `create unique index operations_one_running on operations(env_id) where status in ('pending', 'running')`,
  `create table releases (
    id text primary key,
    env_id text not null references environments(id),
    commit_sha text not null,
    images text not null,
    author text not null,
    message text not null,
    deployed_at integer not null,
    superseded_at integer null,
    activation_seq integer null,
    schema_snapshot text not null,
    schema_diff text not null,
    state text not null check (state in ('active', 'available', 'blocked', 'expired', 'failed')),
    destructive_approved integer not null default 0 check (destructive_approved in (0, 1)),
    cleanup_state text not null default 'none' check (cleanup_state in ('none', 'pending', 'applied', 'dismissed', 'lapsed')),
    cleanup_preview text null,
    blocked_at integer null,
    blocked_by_op text null references operations(id),
    stored integer not null check (stored in (0, 1)),
    image_purged_at integer null,
    contracted_at integer null,
    unique (env_id, commit_sha)
  )`,
  `create unique index releases_one_active on releases(env_id) where state = 'active'`,
  `create table destructive_approvals (
    env_id text not null references environments(id),
    commit_sha text not null,
    diff text not null,
    approved_at integer not null,
    used_by_op text null,
    primary key (env_id, commit_sha)
  )`,
  `create table sessions (
    id text primary key,
    created_at integer not null,
    expires_at integer not null
  )`,
];

export async function up(knex: Knex): Promise<void> {
  for (const s of statements) await knex.raw(s);
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['sessions', 'destructive_approvals', 'releases', 'operations', 'environments', 'servers']) {
    await knex.raw(`drop table if exists ${t}`);
  }
}
