CREATE TABLE public.ig_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instagram_url text NOT NULL UNIQUE,
  profile_handle text,
  profile_name text,
  snippet text,
  query text,
  contacted boolean NOT NULL DEFAULT false,
  contacted_at timestamptz,
  notes text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ig_leads_created ON public.ig_leads (created_at DESC);
CREATE INDEX idx_ig_leads_contacted ON public.ig_leads (contacted, created_at DESC);
ALTER TABLE public.ig_leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage ig_leads" ON public.ig_leads FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));
CREATE TRIGGER trg_ig_leads_updated_at BEFORE UPDATE ON public.ig_leads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();