
ALTER TABLE public.host_leads
  ADD COLUMN IF NOT EXISTS email_status text,
  ADD COLUMN IF NOT EXISTS email_sub_status text,
  ADD COLUMN IF NOT EXISTS email_verified_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS email_sendable boolean;

CREATE INDEX IF NOT EXISTS idx_host_leads_email_status ON public.host_leads(email_status);
CREATE INDEX IF NOT EXISTS idx_host_leads_email_sendable ON public.host_leads(email_sendable);
