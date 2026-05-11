CREATE TABLE public.state_pool_regulations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_code text NOT NULL UNIQUE,
  state_name text NOT NULL,
  legality_status text NOT NULL DEFAULT 'unknown',
  summary text,
  zoning_summary text,
  permit_name text,
  permit_fee_min_usd integer,
  permit_fee_max_usd integer,
  authority_name text,
  authority_url text,
  enforcement_notes text,
  compliance_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  faqs jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_urls text[] NOT NULL DEFAULT '{}',
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT state_pool_regulations_status_check
    CHECK (legality_status IN ('legal','conditional','prohibited','unknown'))
);

CREATE INDEX idx_state_pool_regulations_code ON public.state_pool_regulations (state_code);

ALTER TABLE public.state_pool_regulations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read state pool regulations"
  ON public.state_pool_regulations FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "Admins manage state pool regulations"
  ON public.state_pool_regulations FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER trg_state_pool_regulations_updated_at
  BEFORE UPDATE ON public.state_pool_regulations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
