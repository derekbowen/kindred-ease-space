ALTER TABLE public.ig_leads ADD COLUMN IF NOT EXISTS source_url text;
CREATE INDEX IF NOT EXISTS ig_leads_source_url_idx ON public.ig_leads(source_url);