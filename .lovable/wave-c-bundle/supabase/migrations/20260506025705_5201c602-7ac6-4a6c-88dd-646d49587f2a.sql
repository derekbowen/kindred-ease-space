
-- Keyword opportunities (GSC query-level data)
CREATE TABLE public.gsc_query_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url_path text NOT NULL,
  query text NOT NULL,
  clicks integer NOT NULL DEFAULT 0,
  impressions integer NOT NULL DEFAULT 0,
  ctr numeric,
  position numeric,
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (url_path, query)
);
CREATE INDEX idx_gsc_query_data_position ON public.gsc_query_data (position);
CREATE INDEX idx_gsc_query_data_url ON public.gsc_query_data (url_path);
CREATE INDEX idx_gsc_query_data_impr ON public.gsc_query_data (impressions DESC);

ALTER TABLE public.gsc_query_data ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins manage gsc query data" ON public.gsc_query_data
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
REVOKE ALL ON public.gsc_query_data FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gsc_query_data TO authenticated;

-- Competitor pages
CREATE TABLE public.competitor_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL UNIQUE,
  domain text,
  title text,
  meta_description text,
  h1 text,
  word_count integer DEFAULT 0,
  headings jsonb,
  markdown text,
  notes text,
  last_scraped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_competitor_pages_domain ON public.competitor_pages (domain);

ALTER TABLE public.competitor_pages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins manage competitor pages" ON public.competitor_pages
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
REVOKE ALL ON public.competitor_pages FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.competitor_pages TO authenticated;

CREATE TRIGGER update_competitor_pages_updated_at
  BEFORE UPDATE ON public.competitor_pages
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Internal link suggestions
CREATE TABLE public.internal_link_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_url text NOT NULL,
  to_url text NOT NULL,
  anchor_text text,
  score numeric NOT NULL DEFAULT 0,
  reason text,
  status text NOT NULL DEFAULT 'pending',  -- pending | applied | dismissed
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_url, to_url)
);
CREATE INDEX idx_link_suggestions_status ON public.internal_link_suggestions (status);
CREATE INDEX idx_link_suggestions_score ON public.internal_link_suggestions (score DESC);

ALTER TABLE public.internal_link_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins manage link suggestions" ON public.internal_link_suggestions
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
REVOKE ALL ON public.internal_link_suggestions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.internal_link_suggestions TO authenticated;

CREATE TRIGGER update_internal_link_suggestions_updated_at
  BEFORE UPDATE ON public.internal_link_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
