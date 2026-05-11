create table public.listing_audits (
  id uuid primary key default gen_random_uuid(),
  listing_url text not null,
  listing_title text,
  host_email text,
  host_name text,
  score int check (score >= 0 and score <= 100),
  summary text,
  strengths jsonb not null default '[]'::jsonb,
  weaknesses jsonb not null default '[]'::jsonb,
  recommendations jsonb not null default '[]'::jsonb,
  pricing_notes text,
  photo_notes text,
  raw_excerpt text,
  audited_at timestamptz not null default now(),
  emailed_at timestamptz,
  email_status text,
  created_by uuid
);

create index listing_audits_audited_at_idx on public.listing_audits (audited_at desc);
create index listing_audits_listing_url_idx on public.listing_audits (listing_url);

alter table public.listing_audits enable row level security;

create policy "Admins can view listing audits"
  on public.listing_audits for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

create policy "Admins can insert listing audits"
  on public.listing_audits for insert
  to authenticated
  with check (public.has_role(auth.uid(), 'admin'));

create policy "Admins can update listing audits"
  on public.listing_audits for update
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

create policy "Admins can delete listing audits"
  on public.listing_audits for delete
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));