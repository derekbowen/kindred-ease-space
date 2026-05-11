create table public.workspace_domains (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  hostname text not null unique,
  verified boolean not null default false,
  verification_token text not null,
  verification_method text,
  verified_at timestamptz,
  cloudflare_hostname_id text,
  ssl_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index workspace_domains_verified_hostname_idx on public.workspace_domains (hostname) where verified = true;
create index workspace_domains_workspace_idx on public.workspace_domains (workspace_id);

alter table public.workspace_domains enable row level security;

create policy "owners read domains" on public.workspace_domains
  for select to authenticated
  using (public.is_workspace_owner(workspace_id, auth.uid()));

create policy "owners write domains" on public.workspace_domains
  for all to authenticated
  using (public.is_workspace_owner(workspace_id, auth.uid()))
  with check (public.is_workspace_owner(workspace_id, auth.uid()));

create trigger workspace_domains_updated_at
  before update on public.workspace_domains
  for each row execute function public.update_updated_at_column();