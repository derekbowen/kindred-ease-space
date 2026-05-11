-- Extend providers with Google Maps fields
ALTER TABLE public.providers
  ADD COLUMN IF NOT EXISTS latitude numeric,
  ADD COLUMN IF NOT EXISTS longitude numeric,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS rating numeric,
  ADD COLUMN IF NOT EXISTS rating_count integer,
  ADD COLUMN IF NOT EXISTS google_cid text,
  ADD COLUMN IF NOT EXISTS google_category text,
  ADD COLUMN IF NOT EXISTS city_slug text,
  ADD COLUMN IF NOT EXISTS claimed_by uuid,
  ADD COLUMN IF NOT EXISTS claimed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS ai_enriched_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS idx_providers_state_city ON public.providers (state_code, city_slug);
CREATE INDEX IF NOT EXISTS idx_providers_claimed_by ON public.providers (claimed_by);
CREATE INDEX IF NOT EXISTS idx_providers_rating ON public.providers (rating DESC NULLS LAST);
CREATE UNIQUE INDEX IF NOT EXISTS uq_providers_slug ON public.providers (slug);
CREATE UNIQUE INDEX IF NOT EXISTS uq_providers_google_cid ON public.providers (google_cid) WHERE google_cid IS NOT NULL;

-- Provider leads: people interested in joining the network
CREATE TABLE IF NOT EXISTS public.provider_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  company text,
  website text,
  city text,
  state_code text,
  message text,
  source_provider_slug text,
  source_path text,
  user_id uuid,
  status text NOT NULL DEFAULT 'new',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.provider_leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can submit a lead" ON public.provider_leads;
CREATE POLICY "Anyone can submit a lead"
  ON public.provider_leads
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "Admins manage leads" ON public.provider_leads;
CREATE POLICY "Admins manage leads"
  ON public.provider_leads
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

DROP TRIGGER IF EXISTS trg_provider_leads_updated_at ON public.provider_leads;
CREATE TRIGGER trg_provider_leads_updated_at
  BEFORE UPDATE ON public.provider_leads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_provider_leads_email ON public.provider_leads (email);
CREATE INDEX IF NOT EXISTS idx_provider_leads_status ON public.provider_leads (status);