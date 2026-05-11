
CREATE TABLE public.competitor_host_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor_url_id uuid NOT NULL REFERENCES public.competitor_urls(id) ON DELETE CASCADE,
  competitor_url text NOT NULL,
  domain text,
  host_first_name text,
  host_city text,
  host_state text,
  -- candidate match fields
  candidate_name text,
  candidate_business_name text,
  candidate_email text,
  candidate_phone text,
  candidate_website text,
  candidate_social_url text,
  candidate_source text, -- 'google_business', 'yelp', 'facebook_page', 'listing_description', 'website_contact'
  candidate_evidence text, -- short LLM justification
  match_confidence integer NOT NULL DEFAULT 0, -- 0-100
  -- triage
  status text NOT NULL DEFAULT 'new', -- 'new', 'contacted', 'converted', 'dismissed'
  admin_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_chm_url_id ON public.competitor_host_matches(competitor_url_id);
CREATE INDEX idx_chm_status_conf ON public.competitor_host_matches(status, match_confidence DESC);
CREATE INDEX idx_chm_created ON public.competitor_host_matches(created_at DESC);

ALTER TABLE public.competitor_host_matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage host matches"
  ON public.competitor_host_matches
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER trg_chm_updated_at
  BEFORE UPDATE ON public.competitor_host_matches
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
