
CREATE TABLE IF NOT EXISTS public.social_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('ig','fb','tiktok','nextdoor','craigslist','youtube')),
  source_url text NOT NULL,
  profile_url text,
  handle text,
  display_name text,
  title text,
  snippet text,
  query text,
  location_hint text,
  contacted boolean NOT NULL DEFAULT false,
  contacted_at timestamptz,
  notes text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_url)
);

CREATE INDEX IF NOT EXISTS idx_social_leads_source_created ON public.social_leads (source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_leads_contacted ON public.social_leads (contacted, created_at DESC);

ALTER TABLE public.social_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_leads FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.social_leads FROM anon, authenticated;

CREATE POLICY "Admins manage social_leads"
  ON public.social_leads
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER trg_social_leads_updated_at
  BEFORE UPDATE ON public.social_leads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Migrate existing IG leads
INSERT INTO public.social_leads
  (source, source_url, profile_url, handle, display_name, snippet, query, contacted, contacted_at, notes, first_seen_at, last_seen_at, created_at)
SELECT
  'ig',
  COALESCE(source_url, instagram_url),
  instagram_url,
  profile_handle,
  profile_name,
  snippet,
  query,
  contacted,
  contacted_at,
  notes,
  first_seen_at,
  last_seen_at,
  created_at
FROM public.ig_leads
ON CONFLICT (source, source_url) DO NOTHING;
