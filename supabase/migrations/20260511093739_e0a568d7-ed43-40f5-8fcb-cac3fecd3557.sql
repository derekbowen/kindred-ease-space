CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_help_articles_title_trgm
  ON public.help_articles USING gin (title gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.help_search_v2(q text, max_results int DEFAULT 25)
RETURNS TABLE (
  id uuid,
  slug text,
  title text,
  excerpt text,
  category_slug text,
  reading_time_minutes int,
  view_count int,
  published_at timestamptz,
  updated_at timestamptz,
  rank real,
  headline text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH parsed AS (
    SELECT
      websearch_to_tsquery('english', q) AS tsq,
      q AS raw
  )
  SELECT
    a.id,
    a.slug,
    a.title,
    a.excerpt,
    a.category_slug,
    a.reading_time_minutes,
    a.view_count,
    a.published_at,
    a.updated_at,
    (
      ts_rank_cd(a.search_vector, parsed.tsq)
      + CASE WHEN lower(a.title) = lower(parsed.raw) THEN 1.5
             WHEN a.title ILIKE '%' || parsed.raw || '%' THEN 0.6
             ELSE 0 END
      + CASE WHEN a.is_popular THEN 0.25 ELSE 0 END
      + LEAST(0.4, COALESCE(a.view_count, 0)::real / 1000.0)
    )::real AS rank,
    ts_headline(
      'english',
      COALESCE(a.excerpt, left(a.content, 600)),
      parsed.tsq,
      'StartSel=<mark>,StopSel=</mark>,MaxFragments=2,MaxWords=18,MinWords=6,ShortWord=3,FragmentDelimiter=" ... "'
    ) AS headline
  FROM public.help_articles a, parsed
  WHERE a.workspace_id IS NULL
    AND a.status = 'published'
    AND a.search_vector @@ parsed.tsq
  ORDER BY rank DESC, a.view_count DESC NULLS LAST
  LIMIT GREATEST(1, LEAST(100, max_results));
$$;

CREATE OR REPLACE FUNCTION public.help_suggest_titles(q text, max_results int DEFAULT 5)
RETURNS TABLE (title text, slug text, category_slug text, similarity real)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.title, a.slug, a.category_slug, similarity(a.title, q) AS similarity
  FROM public.help_articles a
  WHERE a.workspace_id IS NULL
    AND a.status = 'published'
    AND similarity(a.title, q) > 0.18
  ORDER BY similarity DESC
  LIMIT GREATEST(1, LEAST(20, max_results));
$$;

GRANT EXECUTE ON FUNCTION public.help_search_v2(text, int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.help_suggest_titles(text, int) TO anon, authenticated;
