-- =============================================================================
-- Migration: PRNM URL parity rebuild
-- =============================================================================
-- Adds the unified content_pages table that powers /p/$slug, public pools tree
-- (/public-pools/{state}/{city}/{pool}), host_profiles cache for /u/{uuid},
-- and renames categories -> amenities to match Sharetribe's /amenity/$slug URLs.
-- See migration-plan/02-supabase-schema.md for the full design rationale.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. content_pages: master table for all /p/$slug pages
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.content_pages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  template_type   text NOT NULL,
  title           text NOT NULL,
  description     text,
  content         text,
  seo_title       text,
  seo_description text,
  cover_image_url text,
  city_id         uuid REFERENCES public.cities(id),
  state_code      text,
  amenity_id      uuid,
  language        text NOT NULL DEFAULT 'en',
  hreflang_alt    uuid REFERENCES public.content_pages(id),
  author          text,
  published_at    timestamp with time zone,
  updated_at      timestamp with time zone NOT NULL DEFAULT now(),
  created_at      timestamp with time zone NOT NULL DEFAULT now(),
  is_published    boolean NOT NULL DEFAULT false,
  legacy_slugs    text[] NOT NULL DEFAULT '{}',
  CONSTRAINT content_pages_template_type_check CHECK (template_type IN (
    'city_main',
    'host_acquisition_city',
    'event_city_guide',
    'spanish_host_acquisition',
    'spanish_resource',
    'host_advocacy',
    'state_advocacy_guide',
    'academy_article',
    'money_page',
    'resource_article'
  )),
  CONSTRAINT content_pages_language_check CHECK (language IN ('en', 'es'))
);

CREATE INDEX IF NOT EXISTS idx_content_pages_slug_published
  ON public.content_pages (slug) WHERE is_published;

CREATE INDEX IF NOT EXISTS idx_content_pages_template_type
  ON public.content_pages (template_type) WHERE is_published;

CREATE INDEX IF NOT EXISTS idx_content_pages_legacy_slugs
  ON public.content_pages USING gin (legacy_slugs);

CREATE INDEX IF NOT EXISTS idx_content_pages_city
  ON public.content_pages (city_id) WHERE city_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_content_pages_updated_at
  ON public.content_pages (updated_at DESC) WHERE is_published;

ALTER TABLE public.content_pages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read published content_pages" ON public.content_pages;
CREATE POLICY "Public can read published content_pages"
  ON public.content_pages
  FOR SELECT
  TO anon, authenticated
  USING (is_published = true);

DROP POLICY IF EXISTS "Admins manage content_pages" ON public.content_pages;
CREATE POLICY "Admins manage content_pages"
  ON public.content_pages
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

DROP TRIGGER IF EXISTS trg_content_pages_updated_at ON public.content_pages;
CREATE TRIGGER trg_content_pages_updated_at
  BEFORE UPDATE ON public.content_pages
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- -----------------------------------------------------------------------------
-- 2. amenities: renamed from categories to match Sharetribe /amenity/$slug
-- -----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'categories')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'amenities') THEN
    ALTER TABLE public.categories RENAME TO amenities;
  END IF;
END $$;

-- If the rename didn't happen (no source table), create amenities from scratch
CREATE TABLE IF NOT EXISTS public.amenities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  name            text NOT NULL,
  description     text,
  icon            text,
  cover_image_url text,
  is_published    boolean NOT NULL DEFAULT true,
  created_at      timestamp with time zone NOT NULL DEFAULT now(),
  updated_at      timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.amenities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read published amenities" ON public.amenities;
CREATE POLICY "Public can read published amenities"
  ON public.amenities
  FOR SELECT
  TO anon, authenticated
  USING (is_published = true);

DROP POLICY IF EXISTS "Admins manage amenities" ON public.amenities;
CREATE POLICY "Admins manage amenities"
  ON public.amenities
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Add the FK now that amenities exists (deferred from content_pages CREATE)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'content_pages_amenity_id_fkey'
  ) THEN
    ALTER TABLE public.content_pages
      ADD CONSTRAINT content_pages_amenity_id_fkey
      FOREIGN KEY (amenity_id) REFERENCES public.amenities(id);
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. public_pool_states / public_pool_cities / public_pools
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.public_pool_states (
  state_code     text PRIMARY KEY,
  state_slug     text NOT NULL UNIQUE,
  state_name     text NOT NULL,
  hero_image_url text,
  intro          text,
  is_published   boolean NOT NULL DEFAULT true,
  created_at     timestamp with time zone NOT NULL DEFAULT now(),
  updated_at     timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.public_pool_cities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_slug     text NOT NULL REFERENCES public.public_pool_states(state_slug),
  city_slug      text NOT NULL,
  city_name      text NOT NULL,
  hero_image_url text,
  intro          text,
  is_published   boolean NOT NULL DEFAULT true,
  created_at     timestamp with time zone NOT NULL DEFAULT now(),
  updated_at     timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (state_slug, city_slug)
);

CREATE TABLE IF NOT EXISTS public.public_pools (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_slug     text NOT NULL,
  city_slug      text NOT NULL,
  pool_slug      text NOT NULL,
  pool_name      text NOT NULL,
  description    text,
  address        text,
  latitude       numeric,
  longitude      numeric,
  amenities      text[],
  hours          jsonb,
  contact        jsonb,
  hero_image_url text,
  is_published   boolean NOT NULL DEFAULT true,
  created_at     timestamp with time zone NOT NULL DEFAULT now(),
  updated_at     timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (state_slug, city_slug, pool_slug),
  FOREIGN KEY (state_slug, city_slug) REFERENCES public.public_pool_cities(state_slug, city_slug)
);

CREATE INDEX IF NOT EXISTS idx_public_pools_loc
  ON public.public_pools (state_slug, city_slug) WHERE is_published;

CREATE INDEX IF NOT EXISTS idx_public_pools_updated_at
  ON public.public_pools (updated_at DESC) WHERE is_published;

ALTER TABLE public.public_pool_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_pool_cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.public_pools         ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public_pool_states', 'public_pool_cities', 'public_pools'] LOOP
    EXECUTE format($f$
      DROP POLICY IF EXISTS "Public can read published %1$s" ON public.%1$I;
      CREATE POLICY "Public can read published %1$s"
        ON public.%1$I
        FOR SELECT
        TO anon, authenticated
        USING (is_published = true);

      DROP POLICY IF EXISTS "Admins manage %1$s" ON public.%1$I;
      CREATE POLICY "Admins manage %1$s"
        ON public.%1$I
        FOR ALL
        TO authenticated
        USING (has_role(auth.uid(), 'admin'::app_role))
        WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
    $f$, t);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS trg_public_pool_states_updated_at ON public.public_pool_states;
CREATE TRIGGER trg_public_pool_states_updated_at
  BEFORE UPDATE ON public.public_pool_states
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_public_pool_cities_updated_at ON public.public_pool_cities;
CREATE TRIGGER trg_public_pool_cities_updated_at
  BEFORE UPDATE ON public.public_pool_cities
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_public_pools_updated_at ON public.public_pools;
CREATE TRIGGER trg_public_pools_updated_at
  BEFORE UPDATE ON public.public_pools
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- -----------------------------------------------------------------------------
-- 4. host_profiles: cache table for /u/{uuid} pages
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.host_profiles (
  uuid           uuid PRIMARY KEY,
  display_name   text NOT NULL,
  bio            text,
  city_id        uuid REFERENCES public.cities(id),
  avatar_url     text,
  joined_at      timestamp with time zone,
  listing_count  integer NOT NULL DEFAULT 0,
  is_published   boolean NOT NULL DEFAULT true,
  cached_at      timestamp with time zone NOT NULL DEFAULT now(),
  updated_at     timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_host_profiles_city
  ON public.host_profiles (city_id) WHERE is_published;

CREATE INDEX IF NOT EXISTS idx_host_profiles_updated_at
  ON public.host_profiles (updated_at DESC) WHERE is_published;

ALTER TABLE public.host_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read published host_profiles" ON public.host_profiles;
CREATE POLICY "Public can read published host_profiles"
  ON public.host_profiles
  FOR SELECT
  TO anon, authenticated
  USING (is_published = true);

DROP POLICY IF EXISTS "Admins manage host_profiles" ON public.host_profiles;
CREATE POLICY "Admins manage host_profiles"
  ON public.host_profiles
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

DROP TRIGGER IF EXISTS trg_host_profiles_updated_at ON public.host_profiles;
CREATE TRIGGER trg_host_profiles_updated_at
  BEFORE UPDATE ON public.host_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
