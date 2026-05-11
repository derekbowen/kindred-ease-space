
-- Cache of enriched contacts (90-day dedupe)
CREATE TABLE public.enriched_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key text NOT NULL UNIQUE, -- normalized: lower(name)|lower(city)|state OR email OR phone
  source_tier text NOT NULL, -- 'osint' | 'batchdata' | 'pdl'
  full_name text,
  emails jsonb NOT NULL DEFAULT '[]'::jsonb,
  phones jsonb NOT NULL DEFAULT '[]'::jsonb,
  social_profiles jsonb NOT NULL DEFAULT '[]'::jsonb,
  property_address text,
  property_city text,
  property_state text,
  property_zip text,
  raw_response jsonb,
  cost_usd numeric NOT NULL DEFAULT 0,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days')
);
CREATE INDEX idx_enriched_contacts_expires ON public.enriched_contacts(expires_at);
ALTER TABLE public.enriched_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage enriched contacts" ON public.enriched_contacts
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Daily spend tracking
CREATE TABLE public.enrichment_spend_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spend_date date NOT NULL DEFAULT current_date,
  provider text NOT NULL, -- 'batchdata' | 'pdl'
  match_id uuid,
  cost_usd numeric NOT NULL DEFAULT 0,
  outcome text NOT NULL, -- 'hit' | 'miss' | 'error'
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_enrichment_spend_date ON public.enrichment_spend_log(spend_date);
ALTER TABLE public.enrichment_spend_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage enrichment spend" ON public.enrichment_spend_log
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Extend matches table
ALTER TABLE public.competitor_host_matches
  ADD COLUMN IF NOT EXISTS enriched_at timestamptz,
  ADD COLUMN IF NOT EXISTS enriched_tier text, -- 'osint' | 'batchdata' | 'pdl'
  ADD COLUMN IF NOT EXISTS enriched_emails jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS enriched_phones jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS enriched_socials jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS property_address text,
  ADD COLUMN IF NOT EXISTS revenue_signal_score integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revenue_signal_notes text,
  ADD COLUMN IF NOT EXISTS enrichment_cost_usd numeric DEFAULT 0;
