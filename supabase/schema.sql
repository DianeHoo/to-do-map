-- ─────────────────────────────────────────────────────────────────────────────
-- To-Do Map · shared maps backend
--
-- Run this whole file once in the Supabase SQL editor (Dashboard → SQL Editor
-- → New query → paste → Run). Safe to re-run: statements are idempotent and
-- functions are replaced in place.
--
-- Design notes:
--   · RLS is enabled with NO table policies, so the auto-generated REST API
--     cannot read or list rows directly. The four SECURITY DEFINER functions
--     below are the only doorway.
--   · Reads require the exact map ID; writes require the owner key, of which
--     only a SHA-256 hash is stored.
--   · publish_map enforces a 200 KB size cap and a minimal shape check.
-- ─────────────────────────────────────────────────────────────────────────────

-- Supabase installs extensions into the "extensions" schema, so every
-- function below includes it in search_path to reach gen_random_bytes/digest.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.shared_maps (
  id             text primary key,
  map_kind       text not null check (map_kind in ('urgency-importance', 'impact-effort')),
  data           jsonb not null,
  owner_key_hash text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.shared_maps enable row level security;

-- Short unguessable slug, e.g. "k7Qx2wRfB4"
create or replace function public.todomap_random_slug(len int)
returns text
language sql
volatile
set search_path = public, extensions
as $$
  select string_agg(
    substr('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
           (get_byte(gen_random_bytes(1), 0) % 62) + 1, 1),
    ''
  )
  from generate_series(1, len);
$$;

-- Publish a new shared map. Returns { "id": ..., "owner_key": ... }.
-- The owner_key is shown exactly once — only its hash is stored.
create or replace function public.publish_map(map_data jsonb, map_kind text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  new_id  text;
  new_key text;
  tries   int := 0;
begin
  if map_data is null or map_data->'tasks' is null
     or jsonb_typeof(map_data->'tasks') <> 'array' then
    raise exception 'invalid map data';
  end if;
  if pg_column_size(map_data) > 204800 then
    raise exception 'map too large (200 KB limit)';
  end if;

  new_key := encode(gen_random_bytes(24), 'hex');

  loop
    new_id := todomap_random_slug(10);
    begin
      insert into shared_maps (id, map_kind, data, owner_key_hash)
      values (new_id, map_kind, map_data, encode(digest(new_key, 'sha256'), 'hex'));
      exit;
    exception when unique_violation then
      tries := tries + 1;
      if tries > 5 then raise; end if;
    end;
  end loop;

  return json_build_object('id', new_id, 'owner_key', new_key);
end;
$$;

-- Fetch a shared map by its exact ID. Returns null when it doesn't exist
-- (deleted or never published) — the app shows "no longer shared".
create or replace function public.get_shared_map(map_id text)
returns json
language sql
security definer
set search_path = public, extensions
stable
as $$
  select json_build_object(
    'data', data,
    'map_kind', map_kind,
    'updated_at', updated_at
  )
  from shared_maps
  where id = map_id;
$$;

-- Replace a shared map's contents. Owner only. Returns true on success.
create or replace function public.update_shared_map(map_id text, owner_key text, map_data jsonb)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  updated int;
begin
  if map_data is null or map_data->'tasks' is null
     or jsonb_typeof(map_data->'tasks') <> 'array' then
    raise exception 'invalid map data';
  end if;
  if pg_column_size(map_data) > 204800 then
    raise exception 'map too large (200 KB limit)';
  end if;

  update shared_maps
     set data = map_data, updated_at = now()
   where id = map_id
     and owner_key_hash = encode(digest(owner_key, 'sha256'), 'hex');

  get diagnostics updated = row_count;
  return updated = 1;
end;
$$;

-- Stop sharing. Owner only. Returns true when a row was deleted.
create or replace function public.delete_shared_map(map_id text, owner_key text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  deleted int;
begin
  delete from shared_maps
   where id = map_id
     and owner_key_hash = encode(digest(owner_key, 'sha256'), 'hex');

  get diagnostics deleted = row_count;
  return deleted = 1;
end;
$$;

-- The slug helper is internal — only the four RPC functions need to be
-- callable by the public (anon) role.
revoke execute on function public.todomap_random_slug(int) from public, anon;
