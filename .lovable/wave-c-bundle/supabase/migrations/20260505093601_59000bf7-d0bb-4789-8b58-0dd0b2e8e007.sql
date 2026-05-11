CREATE OR REPLACE FUNCTION public.count_providers_by_category()
RETURNS TABLE(primary_category text, n bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT primary_category, count(*)::bigint AS n
  FROM public.providers
  WHERE is_published = true AND primary_category IS NOT NULL
  GROUP BY primary_category;
$$;

REVOKE ALL ON FUNCTION public.count_providers_by_category() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_providers_by_category() TO anon, authenticated, service_role;

CREATE INDEX IF NOT EXISTS providers_primary_category_pub_idx
  ON public.providers (primary_category)
  WHERE is_published = true;

CREATE INDEX IF NOT EXISTS providers_secondary_categories_gin
  ON public.providers USING GIN (secondary_categories);
