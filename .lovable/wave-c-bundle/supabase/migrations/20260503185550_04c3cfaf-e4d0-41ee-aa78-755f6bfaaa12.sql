-- Waitlist table for visitors with no pool within 500 miles
create table if not exists public.pool_waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  city text,
  region text,
  latitude double precision,
  longitude double precision,
  nearest_miles double precision,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists pool_waitlist_email_idx on public.pool_waitlist (email);
create index if not exists pool_waitlist_created_at_idx on public.pool_waitlist (created_at desc);

alter table public.pool_waitlist enable row level security;

-- Public visitors (anon) may insert their own email; nobody can read.
-- Admins can read/manage via has_role().
drop policy if exists "Anyone can join waitlist" on public.pool_waitlist;
create policy "Anyone can join waitlist"
on public.pool_waitlist
for insert
to anon, authenticated
with check (true);

drop policy if exists "Admins manage waitlist" on public.pool_waitlist;
create policy "Admins manage waitlist"
on public.pool_waitlist
for all
to authenticated
using (public.has_role(auth.uid(), 'admin'))
with check (public.has_role(auth.uid(), 'admin'));
