-- =====================================================================
-- Post-it Board — Supabase schema (free plan friendly: tables + RLS only)
--
-- Data model:  days  ->  pins (one per topic)  ->  pages (the notes)
-- Deleting a day deletes its pins; deleting a pin deletes its pages
-- (ON DELETE CASCADE). Deletes are permanent; there is no recycle bin.
--
-- !!!  BEFORE RUNNING  !!!
--   1. In Supabase: Authentication > Users > "Add user" (email + password)
--      to create YOUR owner account. Copy its "User UID".
--   2. Replace EVERY occurrence of  <OWNER_USER_UUID>  below with that UID
--      (Find & Replace in the SQL editor; 9 occurrences). If you forget,
--      the script fails on the invalid uuid and nothing is changed.
--   3. Paste this whole file into SQL Editor and click Run.
--
-- Access rules (enforced by Row Level Security):
--   * anon (public site visitors, anon key)  -> SELECT only
--   * authenticated owner (auth.uid() = owner id) -> INSERT / UPDATE / DELETE
--   * any other signed-in user               -> SELECT only
-- Tip: also disable public sign-ups (Authentication > Sign In / Providers >
-- "Allow new users to sign up" = off) so nobody else can create accounts.
-- =====================================================================

begin;

-- gen_random_uuid() is built into Postgres 13+ (Supabase); pgcrypto kept for safety.
create extension if not exists pgcrypto;

-- ---------- tables ----------
create table if not exists public.days (
  id          uuid primary key default gen_random_uuid(),
  board_date  date unique not null,
  title       text,
  created_at  timestamptz not null default now()
);

create table if not exists public.pins (
  id          uuid primary key default gen_random_uuid(),
  day_id      uuid not null references public.days (id) on delete cascade,
  title       text not null,
  color       text default 'yellow',   -- yellow | pink | blue | green
  position    int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.pages (
  id          uuid primary key default gen_random_uuid(),
  pin_id      uuid not null references public.pins (id) on delete cascade,
  title       text,
  body        text not null default '',
  position    int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists pins_day_position_idx  on public.pins  (day_id, position);
create index if not exists pages_pin_position_idx on public.pages (pin_id, position);

-- ---------- keep updated_at fresh ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists pins_set_updated_at on public.pins;
create trigger pins_set_updated_at before update on public.pins
  for each row execute function public.set_updated_at();

drop trigger if exists pages_set_updated_at on public.pages;
create trigger pages_set_updated_at before update on public.pages
  for each row execute function public.set_updated_at();

-- ---------- privileges (RLS below narrows these further) ----------
grant usage on schema public to anon, authenticated;
grant select on public.days, public.pins, public.pages to anon, authenticated;
grant insert, update, delete on public.days, public.pins, public.pages to authenticated;
revoke insert, update, delete on public.days, public.pins, public.pages from anon;

-- ---------- Row Level Security ----------
alter table public.days  enable row level security;
alter table public.pins  enable row level security;
alter table public.pages enable row level security;

-- Public read access for everyone (the board is public, read-only).
drop policy if exists "days are publicly readable"  on public.days;
drop policy if exists "pins are publicly readable"  on public.pins;
drop policy if exists "pages are publicly readable" on public.pages;
create policy "days are publicly readable"  on public.days  for select to anon, authenticated using (true);
create policy "pins are publicly readable"  on public.pins  for select to anon, authenticated using (true);
create policy "pages are publicly readable" on public.pages for select to anon, authenticated using (true);

-- Owner-only writes. REPLACE <OWNER_USER_UUID> with your Supabase Auth user id.
-- days
drop policy if exists "owner can insert days" on public.days;
drop policy if exists "owner can update days" on public.days;
drop policy if exists "owner can delete days" on public.days;
create policy "owner can insert days" on public.days for insert to authenticated
  with check ((select auth.uid()) = '<OWNER_USER_UUID>'::uuid);
create policy "owner can update days" on public.days for update to authenticated
  using      ((select auth.uid()) = '<OWNER_USER_UUID>'::uuid);
create policy "owner can delete days" on public.days for delete to authenticated
  using      ((select auth.uid()) = '<OWNER_USER_UUID>'::uuid);

-- pins
drop policy if exists "owner can insert pins" on public.pins;
drop policy if exists "owner can update pins" on public.pins;
drop policy if exists "owner can delete pins" on public.pins;
create policy "owner can insert pins" on public.pins for insert to authenticated
  with check ((select auth.uid()) = '<OWNER_USER_UUID>'::uuid);
create policy "owner can update pins" on public.pins for update to authenticated
  using      ((select auth.uid()) = '<OWNER_USER_UUID>'::uuid);
create policy "owner can delete pins" on public.pins for delete to authenticated
  using      ((select auth.uid()) = '<OWNER_USER_UUID>'::uuid);

-- pages
drop policy if exists "owner can insert pages" on public.pages;
drop policy if exists "owner can update pages" on public.pages;
drop policy if exists "owner can delete pages" on public.pages;
create policy "owner can insert pages" on public.pages for insert to authenticated
  with check ((select auth.uid()) = '<OWNER_USER_UUID>'::uuid);
create policy "owner can update pages" on public.pages for update to authenticated
  using      ((select auth.uid()) = '<OWNER_USER_UUID>'::uuid);
create policy "owner can delete pages" on public.pages for delete to authenticated
  using      ((select auth.uid()) = '<OWNER_USER_UUID>'::uuid);

commit;
