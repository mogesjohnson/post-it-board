-- =====================================================================
-- Post-it Board — Supabase schema (free plan friendly: tables + RLS only)
--
-- Data model:  days  ->  pins (one per topic)  ->  pages (the notes)
-- Deleting a day deletes its pins; deleting a pin deletes its pages
-- (ON DELETE CASCADE). Deletes are permanent; there is no recycle bin.
--
-- Access rules (Row Level Security):
--   * anyone (anon key) and any signed-in user -> SELECT days / pins / pages
--   * signed-in users listed in public.board_owners -> INSERT / UPDATE / DELETE
--   * public.board_owners itself is never readable/writable with the anon key;
--     manage it from the SQL editor (postgres) — see the example at the bottom.
--
-- Safe to re-run: everything is "if not exists" / "create or replace" /
-- "drop ... if exists" before create. Run it in Supabase SQL Editor.
-- Tip: turn off public sign-ups (Authentication > Sign In / Providers >
-- "Allow new users to sign up" = off) so nobody else can create accounts.
-- =====================================================================

begin;

-- ---------- board tables ----------
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

-- ---------- who may write: board owners ----------
-- One row per Supabase Auth user allowed to add/edit/delete notes
-- (e.g. the human owner and the posting bot account).
create table if not exists public.board_owners (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  label       text,                       -- e.g. 'owner', 'bot' (informational)
  created_at  timestamptz not null default now()
);

-- true when the current request's user is a board owner.
-- SECURITY DEFINER so policies can consult board_owners without exposing it
-- (and without RLS recursion); empty search_path to prevent hijacking.
create or replace function public.is_board_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.board_owners o where o.user_id = auth.uid()
  );
$$;
revoke all     on function public.is_board_owner() from public, anon;
grant  execute on function public.is_board_owner() to authenticated, service_role;

-- ---------- keep updated_at fresh ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
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

-- ---------- table privileges (RLS below narrows these further) ----------
-- Supabase grants ALL on new public tables to anon/authenticated by default;
-- reset to exactly what the app needs.
revoke all on public.days, public.pins, public.pages, public.board_owners from anon, authenticated;
grant usage  on schema public to anon, authenticated;
grant select on public.days, public.pins, public.pages to anon, authenticated;
grant insert, update, delete on public.days, public.pins, public.pages to authenticated;
grant select on public.board_owners to authenticated;   -- only their own row, via RLS

-- ---------- Row Level Security ----------
alter table public.days         enable row level security;
alter table public.pins         enable row level security;
alter table public.pages        enable row level security;
alter table public.board_owners enable row level security;

-- board_owners: a signed-in user can see only their own row (lets the site ask
-- "am I an owner?"). No insert/update/delete policies: manage it as postgres.
drop policy if exists "owners can see their own row" on public.board_owners;
create policy "owners can see their own row" on public.board_owners
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Public read access for everyone (the board is public, read-only).
drop policy if exists "days are publicly readable"  on public.days;
drop policy if exists "pins are publicly readable"  on public.pins;
drop policy if exists "pages are publicly readable" on public.pages;
create policy "days are publicly readable"  on public.days  for select to anon, authenticated using (true);
create policy "pins are publicly readable"  on public.pins  for select to anon, authenticated using (true);
create policy "pages are publicly readable" on public.pages for select to anon, authenticated using (true);

-- Writes only for board owners. `(select ...)` lets Postgres evaluate the
-- check once per statement instead of once per row.
-- days
drop policy if exists "owner can insert days" on public.days;
drop policy if exists "owner can update days" on public.days;
drop policy if exists "owner can delete days" on public.days;
create policy "owner can insert days" on public.days for insert to authenticated
  with check ((select public.is_board_owner()));
create policy "owner can update days" on public.days for update to authenticated
  using ((select public.is_board_owner())) with check ((select public.is_board_owner()));
create policy "owner can delete days" on public.days for delete to authenticated
  using ((select public.is_board_owner()));

-- pins
drop policy if exists "owner can insert pins" on public.pins;
drop policy if exists "owner can update pins" on public.pins;
drop policy if exists "owner can delete pins" on public.pins;
create policy "owner can insert pins" on public.pins for insert to authenticated
  with check ((select public.is_board_owner()));
create policy "owner can update pins" on public.pins for update to authenticated
  using ((select public.is_board_owner())) with check ((select public.is_board_owner()));
create policy "owner can delete pins" on public.pins for delete to authenticated
  using ((select public.is_board_owner()));

-- pages
drop policy if exists "owner can insert pages" on public.pages;
drop policy if exists "owner can update pages" on public.pages;
drop policy if exists "owner can delete pages" on public.pages;
create policy "owner can insert pages" on public.pages for insert to authenticated
  with check ((select public.is_board_owner()));
create policy "owner can update pages" on public.pages for update to authenticated
  using ((select public.is_board_owner())) with check ((select public.is_board_owner()));
create policy "owner can delete pages" on public.pages for delete to authenticated
  using ((select public.is_board_owner()));

commit;

-- =====================================================================
-- Adding owners (run separately, after creating the users under
-- Authentication > Users). Look up ids with:
--   select id, email from auth.users order by created_at;
--
-- insert into public.board_owners(user_id) values ('<uuid>') on conflict do nothing;
--
-- Or by email (human owner + posting bot; adjust the emails to your accounts):
-- insert into public.board_owners (user_id, label)
--   select id, case when email like '%+postit-bot@%' then 'bot' else 'owner' end
--   from auth.users
--   where email in ('johnsonmoges@gmail.com', 'johnsonmoges+postit-bot@gmail.com')
-- on conflict do nothing;
--
-- Remove an owner:
--   delete from public.board_owners where user_id = '<uuid>';
-- =====================================================================
