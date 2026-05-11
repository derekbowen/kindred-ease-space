-- Add missing columns
ALTER TABLE public.content_pages
  ADD COLUMN IF NOT EXISTS content TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS legacy_slugs TEXT[] DEFAULT '{}'::text[];

-- Relax NOT NULLs and add a category default
ALTER TABLE public.content_pages
  ALTER COLUMN url_path DROP NOT NULL,
  ALTER COLUMN source_url DROP NOT NULL,
  ALTER COLUMN category SET DEFAULT 'general';

-- Deduplicate: keep most recently updated row per slug
DELETE FROM public.content_pages a
USING public.content_pages b
WHERE a.slug IS NOT NULL
  AND a.slug = b.slug
  AND (a.updated_at, a.id) < (b.updated_at, b.id);

-- Now safe to enforce uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS content_pages_slug_key
  ON public.content_pages (slug)
  WHERE slug IS NOT NULL;