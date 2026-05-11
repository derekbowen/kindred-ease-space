
-- Persist host leads
CREATE TABLE public.host_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  phone_e164 text NOT NULL,
  phone_raw text NOT NULL,
  city text,
  region text,
  page text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.host_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.host_leads FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.host_leads FROM anon, authenticated;
CREATE POLICY "Admins manage host_leads" ON public.host_leads FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));
CREATE INDEX idx_host_leads_created ON public.host_leads(created_at DESC);
CREATE INDEX idx_host_leads_phone ON public.host_leads(phone_e164);

-- SMS opt-outs (by phone E.164)
CREATE TABLE public.sms_opt_outs (
  phone_e164 text PRIMARY KEY,
  source text NOT NULL DEFAULT 'inbound_stop',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sms_opt_outs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_opt_outs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.sms_opt_outs FROM anon, authenticated;
CREATE POLICY "Admins manage sms_opt_outs" ON public.sms_opt_outs FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

-- Outbound SMS queue
CREATE TABLE public.sms_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES public.host_leads(id) ON DELETE CASCADE,
  phone_e164 text NOT NULL,
  body text NOT NULL,
  step int NOT NULL,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  sent_at timestamptz,
  twilio_sid text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sms_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_messages FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.sms_messages FROM anon, authenticated;
CREATE POLICY "Admins manage sms_messages" ON public.sms_messages FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));
CREATE INDEX idx_sms_messages_due ON public.sms_messages(scheduled_at) WHERE status = 'pending';
CREATE INDEX idx_sms_messages_lead ON public.sms_messages(lead_id);

-- Inbound SMS log (STOP/HELP/replies) for compliance + visibility
CREATE TABLE public.sms_inbound_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_phone text NOT NULL,
  to_phone text,
  body text,
  twilio_sid text,
  action text,
  received_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sms_inbound_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_inbound_log FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.sms_inbound_log FROM anon, authenticated;
CREATE POLICY "Admins read sms_inbound_log" ON public.sms_inbound_log FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));
