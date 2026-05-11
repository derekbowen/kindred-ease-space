CREATE TABLE IF NOT EXISTS public.host_match_false_positives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid,
  competitor_url text,
  domain text,
  candidate_name text,
  candidate_business_name text,
  candidate_email text,
  candidate_phone text,
  candidate_website text,
  candidate_source text,
  host_first_name text,
  host_city text,
  host_state text,
  match_confidence integer,
  reason text,
  reported_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.host_match_false_positives ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage false positives"
  ON public.host_match_false_positives
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE INDEX IF NOT EXISTS idx_host_match_fp_created_at
  ON public.host_match_false_positives (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_host_match_fp_domain
  ON public.host_match_false_positives (domain);