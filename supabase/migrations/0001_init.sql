-- OneTake backend. Applied to project arkzlehcpbzohmxwpntl via MCP.
-- Clerk is the auth provider (Supabase third-party auth). The Clerk user id
-- is auth.jwt()->>'sub'. Every row is owner-scoped by RLS. Only saved
-- Memories sync here; ephemeral takes never leave the device.

create table public.projects (
  id text primary key,
  user_id text not null default (auth.jwt()->>'sub'),
  type text not null,
  title text not null,
  status text not null,
  prompt text,
  created_at bigint not null,
  updated_at bigint not null default 0,
  deleted boolean not null default false
);

create table public.collections (
  id text primary key,
  user_id text not null default (auth.jwt()->>'sub'),
  name text not null,
  created_at bigint not null,
  updated_at bigint not null default 0,
  deleted boolean not null default false
);

create table public.inspiration (
  id text primary key,
  user_id text not null default (auth.jwt()->>'sub'),
  collection_id text not null,
  source_url text not null,
  thumb_color text not null,
  note text,
  added_at bigint not null,
  updated_at bigint not null default 0,
  deleted boolean not null default false
);

create table public.clips (
  id text primary key,
  user_id text not null default (auth.jwt()->>'sub'),
  project_id text not null,
  order_index int not null,
  storage_path text,
  duration_ms int not null,
  verdict text not null,
  verdict_overridden int not null default 0,
  tag text not null,
  tag_overridden int not null default 0,
  excluded int not null default 0,
  created_at bigint not null,
  updated_at bigint not null default 0,
  deleted boolean not null default false
);

create index idx_projects_user on public.projects(user_id);
create index idx_collections_user on public.collections(user_id);
create index idx_inspiration_user on public.inspiration(user_id);
create index idx_clips_user on public.clips(user_id);
create index idx_clips_project on public.clips(project_id);
create index idx_clips_updated on public.clips(updated_at);

alter table public.projects enable row level security;
alter table public.collections enable row level security;
alter table public.inspiration enable row level security;
alter table public.clips enable row level security;

create policy "own rows" on public.projects for all
  using ((select auth.jwt()->>'sub') = user_id)
  with check ((select auth.jwt()->>'sub') = user_id);
create policy "own rows" on public.collections for all
  using ((select auth.jwt()->>'sub') = user_id)
  with check ((select auth.jwt()->>'sub') = user_id);
create policy "own rows" on public.inspiration for all
  using ((select auth.jwt()->>'sub') = user_id)
  with check ((select auth.jwt()->>'sub') = user_id);
create policy "own rows" on public.clips for all
  using ((select auth.jwt()->>'sub') = user_id)
  with check ((select auth.jwt()->>'sub') = user_id);

insert into storage.buckets (id, name, public)
values ('clips', 'clips', false)
on conflict (id) do nothing;

create policy "clips read own" on storage.objects for select
  using (bucket_id = 'clips' and (storage.foldername(name))[1] = (select auth.jwt()->>'sub'));
create policy "clips insert own" on storage.objects for insert
  with check (bucket_id = 'clips' and (storage.foldername(name))[1] = (select auth.jwt()->>'sub'));
create policy "clips update own" on storage.objects for update
  using (bucket_id = 'clips' and (storage.foldername(name))[1] = (select auth.jwt()->>'sub'));
create policy "clips delete own" on storage.objects for delete
  using (bucket_id = 'clips' and (storage.foldername(name))[1] = (select auth.jwt()->>'sub'));
