-- Quality view: per-page word count, quality bucket, issue flags
CREATE OR REPLACE VIEW public.page_quality AS
SELECT
  p.id,
  p.slug,
  p.url_path,
  p.template_type,
  p.status,
  p.title,
  p.seo_title,
  p.seo_description,
  p.body_markdown,
  p.created_at,
  p.updated_at,
  COALESCE(
    array_length(
      regexp_split_to_array(trim(COALESCE(p.body_markdown, '')), '\s+'),
      1
    ),
    0
  ) AS word_count,
  CASE
    WHEN p.body_markdown IS NULL OR length(trim(p.body_markdown)) = 0 THEN 'empty'
    WHEN COALESCE(array_length(regexp_split_to_array(trim(p.body_markdown), '\s+'), 1), 0) < 500 THEN 'thin'
    WHEN COALESCE(array_length(regexp_split_to_array(trim(p.body_markdown), '\s+'), 1), 0) < 1000 THEN 'medium'
    ELSE 'healthy'
  END AS quality,
  (p.seo_description IS NULL OR length(trim(p.seo_description)) = 0) AS missing_meta,
  -- "schema" proxy: does body contain a JSON-LD script block?
  (p.body_markdown IS NULL OR p.body_markdown !~* 'application/ld\+json') AS missing_schema,
  (p.title IS NULL OR p.title = p.slug OR length(trim(COALESCE(p.title,''))) = 0) AS title_is_slug,
  -- no internal markdown links and no relative href to /
  (
    p.body_markdown IS NOT NULL
    AND p.body_markdown !~ '\]\(/'
    AND p.body_markdown !~ 'href="/'
  ) AS no_internal_links
FROM public.content_pages p
WHERE p.url_path LIKE '/p/%';

-- Per-template rollup
CREATE OR REPLACE VIEW public.template_quality_breakdown AS
SELECT
  template_type,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE status = 'published') AS published,
  COUNT(*) FILTER (WHERE status = 'published' AND quality = 'empty')   AS published_empty,
  COUNT(*) FILTER (WHERE status = 'published' AND quality = 'thin')    AS published_thin,
  COUNT(*) FILTER (WHERE status = 'published' AND quality = 'medium')  AS published_medium,
  COUNT(*) FILTER (WHERE status = 'published' AND quality = 'healthy') AS published_healthy,
  COUNT(*) FILTER (WHERE status <> 'published') AS pending,
  AVG(word_count) FILTER (WHERE status = 'published')::int AS avg_words_published,
  MIN(updated_at) FILTER (WHERE status <> 'published') AS oldest_pending,
  COUNT(*) FILTER (WHERE status = 'published' AND updated_at >= now() - interval '7 days') AS published_last_7d
FROM public.page_quality
GROUP BY template_type;

-- Site-wide issue counters
CREATE OR REPLACE VIEW public.site_issues AS
SELECT
  COUNT(*) FILTER (WHERE status = 'published' AND missing_meta)        AS missing_meta_published,
  COUNT(*) FILTER (WHERE status = 'published' AND missing_schema)      AS missing_schema_published,
  COUNT(*) FILTER (WHERE status = 'published' AND no_internal_links)   AS no_links_published,
  COUNT(*) FILTER (WHERE status = 'published' AND title_is_slug)       AS title_is_slug_published,
  COUNT(*) FILTER (WHERE status = 'published' AND quality = 'thin')    AS thin_published_total,
  COUNT(*) FILTER (WHERE status = 'published' AND quality = 'empty')   AS empty_published_total
FROM public.page_quality;