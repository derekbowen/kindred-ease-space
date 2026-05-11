-- Recreate template_quality_breakdown to include published_missing_body
DROP VIEW IF EXISTS public.template_quality_breakdown CASCADE;

CREATE VIEW public.template_quality_breakdown
WITH (security_invoker = true) AS
SELECT
  template_type,
  count(*) AS total,
  count(*) FILTER (WHERE status = 'published') AS published,
  count(*) FILTER (WHERE status <> 'published') AS pending,
  count(*) FILTER (WHERE status = 'published' AND quality = 'empty') AS published_empty,
  count(*) FILTER (WHERE status = 'published' AND quality = 'thin') AS published_thin,
  count(*) FILTER (WHERE status = 'published' AND quality = 'medium') AS published_medium,
  count(*) FILTER (WHERE status = 'published' AND quality = 'healthy') AS published_healthy,
  count(*) FILTER (
    WHERE status = 'published'
      AND (body_markdown IS NULL OR length(trim(body_markdown)) = 0)
  ) AS published_missing_body,
  (avg(word_count) FILTER (WHERE status = 'published'))::int AS avg_words_published,
  min(updated_at) FILTER (WHERE status <> 'published') AS oldest_pending,
  count(*) FILTER (
    WHERE status = 'published' AND updated_at >= now() - interval '7 days'
  ) AS published_last_7d
FROM public.page_quality
GROUP BY template_type;

-- Make sure the underlying view + aggregates are readable by the backend (service_role)
-- and also by authenticated admins through PostgREST. RLS on content_pages still gates
-- raw row access for non-admins via the security_invoker setting above.
GRANT SELECT ON public.page_quality              TO authenticated, service_role;
GRANT SELECT ON public.site_issues               TO authenticated, service_role;
GRANT SELECT ON public.template_quality_breakdown TO authenticated, service_role;