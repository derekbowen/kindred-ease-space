
-- Competitor Radar
CREATE TABLE public.competitor_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL UNIQUE,
  sitemap_url TEXT NOT NULL,
  label TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_checked_at TIMESTAMPTZ,
  last_url_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.competitor_urls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.competitor_sites(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  scraped_at TIMESTAMPTZ,
  title TEXT,
  word_count INTEGER,
  acknowledged BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (site_id, url)
);

CREATE INDEX idx_competitor_urls_first_seen ON public.competitor_urls (first_seen_at DESC);
CREATE INDEX idx_competitor_urls_ack ON public.competitor_urls (acknowledged, first_seen_at DESC);

ALTER TABLE public.competitor_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competitor_urls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage competitor_sites" ON public.competitor_sites
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins manage competitor_urls" ON public.competitor_urls
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- SERP Rank Tracker
CREATE TABLE public.tracked_keywords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword TEXT NOT NULL,
  target_url_path TEXT,
  market TEXT NOT NULL DEFAULT 'us',
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_position INTEGER,
  previous_position INTEGER,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (keyword, market)
);

CREATE TABLE public.serp_rankings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword_id UUID NOT NULL REFERENCES public.tracked_keywords(id) ON DELETE CASCADE,
  position INTEGER,
  url_found TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_serp_rankings_kw_time ON public.serp_rankings (keyword_id, checked_at DESC);

ALTER TABLE public.tracked_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.serp_rankings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage tracked_keywords" ON public.tracked_keywords
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins manage serp_rankings" ON public.serp_rankings
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- AI Page Auditor
CREATE TABLE public.page_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url_path TEXT NOT NULL,
  score INTEGER,
  summary TEXT,
  strengths JSONB NOT NULL DEFAULT '[]'::jsonb,
  weaknesses JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  audited_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_page_audits_url_time ON public.page_audits (url_path, audited_at DESC);

ALTER TABLE public.page_audits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage page_audits" ON public.page_audits
  FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
