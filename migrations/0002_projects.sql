-- App projects table for DB-backed share / persistence when DATABASE_URL is set.
-- Without DATABASE_URL the client keeps using Zustand localStorage only.

create table if not exists projects (
  id text primary key,
  user_id text,
  name text not null,
  kind text not null,
  fidelity text not null,
  html text not null default '',
  tweaks jsonb not null default '[]'::jsonb,
  share text not null default 'private',
  model text not null default 'grok-4.6',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists projects_user_id_idx on projects (user_id);
create index if not exists projects_share_idx on projects (share) where share <> 'private';
