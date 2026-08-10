-- ─────────────────────────────────────────────────────────────────────────────
-- To-Do Map · maps backend (multi-map home screen)
--
-- Run this whole file once in the Supabase SQL editor (Dashboard → SQL Editor
-- → New query → paste → Run). Safe to re-run: statements are idempotent.
--
-- ALSO REQUIRED: enable anonymous sign-ins —
--   Dashboard → Authentication → Sign In / Up → "Allow anonymous sign-ins".
-- Each browser signs in anonymously and syncs its maps to its own account;
-- maps-cloud.js falls back to localStorage-only until both steps are done.
--
-- Design notes:
--   · Unlike shared_maps (RPC-only doorway), maps uses plain RLS: every row
--     belongs to one auth user and only that user can see or touch it.
--   · owner_id defaults to auth.uid(), so the client never sends it.
--   · updated_at is client-supplied (milliseconds truth lives in the app's
--     local index; sync compares the two sides by this value).
--   · The shared_maps table and RPCs in schema.sql are unrelated: sharing
--     stays public-by-link and keeps working as before.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.maps (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null default 'untitled map',
  map_kind   text not null check (map_kind in ('urgency-importance','impact-effort')),
  data       jsonb not null default '{"tasks":[]}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.maps enable row level security;

drop policy if exists "own maps" on public.maps;
create policy "own maps" on public.maps
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- Same 200 KB guard the sharing backend enforces, so one board can't bloat.
create or replace function public.todomap_maps_size_guard()
returns trigger
language plpgsql
as $$
begin
  if pg_column_size(new.data) > 204800 then
    raise exception 'map too large (200 KB limit)';
  end if;
  return new;
end;
$$;

drop trigger if exists maps_size_guard on public.maps;
create trigger maps_size_guard
  before insert or update on public.maps
  for each row execute function public.todomap_maps_size_guard();

create index if not exists maps_owner_updated_idx
  on public.maps (owner_id, updated_at desc);
