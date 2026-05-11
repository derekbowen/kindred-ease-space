-- Cached Sharetribe listings for fast rendering
CREATE TABLE public.synced_listings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  sharetribe_id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  price_amount INTEGER,
  price_currency TEXT,
  latitude NUMERIC,
  longitude NUMERIC,
  address TEXT,
  city TEXT,
  state_code TEXT,
  city_slug TEXT,
  category TEXT,
  amenities TEXT[] NOT NULL DEFAULT '{}',
  capacity INTEGER,
  image_urls TEXT[] NOT NULL DEFAULT '{}',
  primary_image_url TEXT,
  author_id TEXT,
  state TEXT NOT NULL DEFAULT 'published',
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  public_data JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  st_created_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_synced_listings_city_slug ON public.synced_listings(city_slug) WHERE state = 'published' AND is_deleted = false;
CREATE INDEX idx_synced_listings_state_code ON public.synced_listings(state_code) WHERE state = 'published' AND is_deleted = false;
CREATE INDEX idx_synced_listings_category ON public.synced_listings(category) WHERE state = 'published' AND is_deleted = false;
CREATE INDEX idx_synced_listings_geo ON public.synced_listings(latitude, longitude) WHERE state = 'published' AND is_deleted = false;
CREATE INDEX idx_synced_listings_state ON public.synced_listings(state);
CREATE INDEX idx_synced_listings_slug ON public.synced_listings(slug);

ALTER TABLE public.synced_listings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read published synced listings"
  ON public.synced_listings FOR SELECT
  TO anon, authenticated
  USING (state = 'published' AND is_deleted = false);

CREATE POLICY "Admins manage synced listings"
  ON public.synced_listings FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER update_synced_listings_updated_at
  BEFORE UPDATE ON public.synced_listings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Sync run log
CREATE TABLE public.listing_sync_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  total_processed INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_listing_sync_log_started_at ON public.listing_sync_log(started_at DESC);

ALTER TABLE public.listing_sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage listing sync log"
  ON public.listing_sync_log FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));