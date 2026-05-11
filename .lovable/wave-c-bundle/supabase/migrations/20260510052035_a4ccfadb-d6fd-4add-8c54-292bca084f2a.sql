ALTER TABLE public.competitor_urls
  ADD COLUMN IF NOT EXISTS kind text,
  ADD COLUMN IF NOT EXISTS city_slug text,
  ADD COLUMN IF NOT EXISTS state_code text,
  ADD COLUMN IF NOT EXISTS summary text;

CREATE INDEX IF NOT EXISTS idx_competitor_urls_kind ON public.competitor_urls(kind);
CREATE INDEX IF NOT EXISTS idx_competitor_urls_city_slug ON public.competitor_urls(city_slug);