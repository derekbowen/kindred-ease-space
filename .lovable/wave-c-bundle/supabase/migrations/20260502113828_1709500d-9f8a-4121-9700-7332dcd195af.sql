CREATE TABLE public.cities_hero_backfill_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  city_slug TEXT NOT NULL,
  source_url TEXT,
  status TEXT NOT NULL,
  image_url TEXT,
  error TEXT,
  ran_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_cities_hero_backfill_log_city_slug ON public.cities_hero_backfill_log(city_slug);
CREATE INDEX idx_cities_hero_backfill_log_ran_at ON public.cities_hero_backfill_log(ran_at DESC);

ALTER TABLE public.cities_hero_backfill_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage hero backfill log"
ON public.cities_hero_backfill_log
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));