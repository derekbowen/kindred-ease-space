CREATE TABLE public.provider_plan_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL,
  provider_slug text NOT NULL,
  requester_name text NOT NULL,
  requester_email text NOT NULL,
  requester_phone text,
  requested_plan text NOT NULL CHECK (requested_plan IN ('paid','featured')),
  payment_reference text,
  payment_method text,
  amount_usd numeric,
  notes text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  admin_notes text,
  reviewed_at timestamptz,
  reviewed_by uuid,
  source_path text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ppr_provider ON public.provider_plan_requests(provider_id);
CREATE INDEX idx_ppr_status ON public.provider_plan_requests(status);

ALTER TABLE public.provider_plan_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can submit a plan request"
  ON public.provider_plan_requests FOR INSERT
  TO anon, authenticated
  WITH CHECK (status = 'pending');

CREATE POLICY "Admins manage plan requests"
  ON public.provider_plan_requests FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER trg_ppr_updated_at
  BEFORE UPDATE ON public.provider_plan_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();