-- Resellable add-on marketplace inside founders.click (white-glove fulfilment).
-- A purchase records intent; the operator sets the customer up manually.
CREATE TABLE IF NOT EXISTS public.addon_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  addon_key text NOT NULL,                 -- e.g. 'dmchamp'
  addon_name text NOT NULL,
  price_cents integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','contacted','active','canceled')),
  contact_email text,
  notes text,
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS addon_requests_ws_idx ON public.addon_requests(workspace_id, created_at DESC);

CREATE TRIGGER trg_addon_requests_updated BEFORE UPDATE ON public.addon_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.addon_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read addon_requests" ON public.addon_requests
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "service writes addon_requests" ON public.addon_requests
  FOR ALL TO public USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "admin escape addon_requests" ON public.addon_requests
  FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
