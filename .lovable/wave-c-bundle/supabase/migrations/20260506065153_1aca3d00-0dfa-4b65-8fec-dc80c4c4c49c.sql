ALTER TABLE public.content_pages
  ADD COLUMN IF NOT EXISTS gsc_impressions integer,
  ADD COLUMN IF NOT EXISTS gsc_clicks integer,
  ADD COLUMN IF NOT EXISTS gsc_position numeric,
  ADD COLUMN IF NOT EXISTS gsc_updated_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_content_pages_gsc_impressions ON public.content_pages (gsc_impressions DESC NULLS LAST);