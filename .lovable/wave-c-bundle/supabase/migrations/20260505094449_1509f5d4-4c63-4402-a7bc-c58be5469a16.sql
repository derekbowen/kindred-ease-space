CREATE TABLE public.provider_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
  provider_slug TEXT NOT NULL,
  claimer_name TEXT NOT NULL,
  claimer_email TEXT NOT NULL,
  claimer_phone TEXT,
  claimer_role TEXT,
  business_email TEXT,
  business_phone TEXT,
  business_website TEXT,
  verification_notes TEXT,
  proposed_updates JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  admin_notes TEXT,
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID,
  user_agent TEXT,
  source_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX provider_claims_provider_idx ON public.provider_claims (provider_id);
CREATE INDEX provider_claims_status_idx ON public.provider_claims (status, created_at DESC);

ALTER TABLE public.provider_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can submit a claim"
  ON public.provider_claims FOR INSERT
  TO anon, authenticated
  WITH CHECK (status = 'pending');

CREATE POLICY "Admins manage claims"
  ON public.provider_claims FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER update_provider_claims_updated_at
  BEFORE UPDATE ON public.provider_claims
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();