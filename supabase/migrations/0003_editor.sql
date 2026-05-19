-- Editor extensions: per-clip trim/volume/word-timings, project-level
-- overlays. Applied to arkzlehcpbzohmxwpntl via MCP.
alter table public.clips add column if not exists in_ms integer;
alter table public.clips add column if not exists out_ms integer;
alter table public.clips add column if not exists audio_volume real not null default 1.0;
alter table public.clips add column if not exists transcript_words text;

create table if not exists public.overlays (
  id text primary key,
  user_id text not null default (auth.jwt()->>'sub'),
  project_id text not null,
  kind text not null,
  text text not null,
  start_ms integer not null,
  end_ms integer not null,
  x real not null default 0.5,
  y real not null default 0.82,
  color text not null default '#ffffff',
  size integer not null default 22,
  created_at bigint not null,
  updated_at bigint not null default 0,
  deleted boolean not null default false
);
create index if not exists idx_overlays_user on public.overlays(user_id);
create index if not exists idx_overlays_project on public.overlays(project_id);
alter table public.overlays enable row level security;
create policy "own rows" on public.overlays for all
  using ((select auth.jwt()->>'sub') = user_id)
  with check ((select auth.jwt()->>'sub') = user_id);
