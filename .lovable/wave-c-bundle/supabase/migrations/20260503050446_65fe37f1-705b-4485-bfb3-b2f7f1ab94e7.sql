-- Migration tracking + content store for the /p/ URL inventory
CREATE TABLE public.content_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source identity
  source_url text NOT NULL UNIQUE,           -- Full original URL from Sharetribe
  url_path text NOT NULL,                    -- Path portion, e.g. /p/become-a-pool-host-austin-tx
  slug text,                                 -- Last path segment

  -- Classification (from CSV)
  category text NOT NULL,                    -- e.g. "Host Acquisition (City pSEO)"
  template_type text,                        -- normalized template key: host_acq_city, event_guide, resource, elearning, host_advocacy_hub, host_advocacy_state, spanish_host_acq, spanish_resource, public_pool_city, public_pool_state, amenity, hub, homepage, listing, other
  locale text NOT NULL DEFAULT 'en',         -- 'en' | 'es'
  hreflang_group text,                       -- shared key linking en/es siblings

  -- Sitemap source tracking
  in_sitemap boolean NOT NULL DEFAULT false,
  sitemap_source text,

  -- Migration workflow
  status text NOT NULL DEFAULT 'pending',    -- pending | scraped | drafted | published | skipped | redirect
  priority integer NOT NULL DEFAULT 0,       -- higher = migrate first (top SEO pages)
  redirect_to text,                          -- if status = redirect

  -- Content
  title text,
  seo_title text,
  seo_description text,
  hero_image_url text,
  body_markdown text,                        -- migrated content
  raw_html text,                             -- scraped HTML (before transform)

  -- Timestamps
  scraped_at timestamptz,
  migrated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_content_pages_category ON public.content_pages(category);
CREATE INDEX idx_content_pages_template_type ON public.content_pages(template_type);
CREATE INDEX idx_content_pages_status ON public.content_pages(status);
CREATE INDEX idx_content_pages_locale ON public.content_pages(locale);
CREATE INDEX idx_content_pages_slug ON public.content_pages(slug);
CREATE INDEX idx_content_pages_url_path ON public.content_pages(url_path);
CREATE INDEX idx_content_pages_hreflang_group ON public.content_pages(hreflang_group);

ALTER TABLE public.content_pages ENABLE ROW LEVEL SECURITY;

-- Admin-only — this is internal migration tooling, not public content
CREATE POLICY "Admins manage content pages"
  ON public.content_pages
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER trg_content_pages_updated_at
  BEFORE UPDATE ON public.content_pages
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();