
-- Add fields to support richer SEO provider pages, scraping, AI content, and GSC metrics
ALTER TABLE public.providers
  ADD COLUMN IF NOT EXISTS long_description text,
  ADD COLUMN IF NOT EXISTS faq jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS gallery_urls text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS source_type text,
  ADD COLUMN IF NOT EXISTS scraped_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_content_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS gsc_impressions integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gsc_clicks integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gsc_position numeric,
  ADD COLUMN IF NOT EXISTS gsc_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS providers_gsc_impressions_idx
  ON public.providers (gsc_impressions DESC) WHERE is_published = true;

-- Track scrape jobs from competitor directories (Yelp, Google Maps, etc.)
CREATE TABLE IF NOT EXISTS public.provider_scrape_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_url text NOT NULL,
  source_type text,
  status text NOT NULL DEFAULT 'pending', -- pending | running | success | failed
  provider_id uuid REFERENCES public.providers(id) ON DELETE SET NULL,
  error text,
  raw jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_scrape_jobs_created_idx ON public.provider_scrape_jobs (created_at DESC);

ALTER TABLE public.provider_scrape_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage scrape jobs"
  ON public.provider_scrape_jobs
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER trg_provider_scrape_jobs_updated
  BEFORE UPDATE ON public.provider_scrape_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
