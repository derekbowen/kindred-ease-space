create table if not exists public.admin_section_presets (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  prompt text not null,
  sort_order int not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.admin_section_presets enable row level security;
revoke all on public.admin_section_presets from anon, authenticated;
grant select, insert, update, delete on public.admin_section_presets to authenticated;
drop policy if exists "admins manage section presets" on public.admin_section_presets;
create policy "admins manage section presets" on public.admin_section_presets
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));