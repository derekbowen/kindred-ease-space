CREATE TABLE public.city_sources (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_slug    TEXT NOT NULL,
  bucket       TEXT NOT NULL CHECK (bucket IN ('ordinance','hoa_str','noaa','demand','insurance')),
  title        TEXT NOT NULL,
  url          TEXT NOT NULL,
  publisher    TEXT NOT NULL,
  key_fact     TEXT NOT NULL,
  retrieved_at DATE NOT NULL DEFAULT CURRENT_DATE,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_city_sources_city_slug ON public.city_sources(city_slug);
CREATE UNIQUE INDEX uq_city_sources_city_url ON public.city_sources(city_slug, url);

ALTER TABLE public.city_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.city_sources FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.city_sources FROM anon, authenticated;

CREATE POLICY "Admins manage city_sources"
  ON public.city_sources
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER trg_city_sources_updated_at
  BEFORE UPDATE ON public.city_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();