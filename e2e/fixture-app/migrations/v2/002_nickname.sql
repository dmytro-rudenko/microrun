alter table users add column nickname text;
create table notifications(id serial primary key, type text not null, created_at timestamptz not null default now());
