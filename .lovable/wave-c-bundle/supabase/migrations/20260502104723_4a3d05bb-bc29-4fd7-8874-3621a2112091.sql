DROP FUNCTION IF EXISTS public.nearby_cities_by_distance(text, int);

CREATE OR REPLACE FUNCTION public.nearby_cities_by_distance(_slug text, _limit int DEFAULT 12)
RETURNS TABLE (
  out_slug text,
  out_name text,
  out_state text,
  out_state_code text,
  out_distance_km double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH src AS (
    SELECT c.slug AS s_slug, c.state_code AS s_state_code,
           c.latitude AS s_lat, c.longitude AS s_lng
    FROM public.cities c
    WHERE c.slug = _slug
    LIMIT 1
  ),
  candidates AS (
    SELECT
      c.slug AS out_slug,
      c.name AS out_name,
      c.state AS out_state,
      c.state_code AS out_state_code,
      CASE
        WHEN src.s_lat IS NOT NULL
         AND src.s_lng IS NOT NULL
         AND c.latitude IS NOT NULL
         AND c.longitude IS NOT NULL
        THEN
          2 * 6371 * asin(
            sqrt(
              power(sin(radians((c.latitude::double precision - src.s_lat::double precision) / 2)), 2)
              + cos(radians(src.s_lat::double precision))
                * cos(radians(c.latitude::double precision))
                * power(sin(radians((c.longitude::double precision - src.s_lng::double precision) / 2)), 2)
            )
          )
        ELSE NULL
      END AS out_distance_km,
      (c.state_code = src.s_state_code) AS same_state
    FROM public.cities c
    CROSS JOIN src
    WHERE c.is_published = true
      AND c.slug <> src.s_slug
      AND (
        (c.latitude IS NOT NULL AND c.longitude IS NOT NULL
         AND src.s_lat IS NOT NULL AND src.s_lng IS NOT NULL)
        OR c.state_code = src.s_state_code
      )
  )
  SELECT out_slug, out_name, out_state, out_state_code, out_distance_km
  FROM candidates
  ORDER BY
    out_distance_km IS NULL,
    out_distance_km ASC,
    same_state DESC,
    out_name ASC
  LIMIT GREATEST(_limit, 1);
$$;

GRANT EXECUTE ON FUNCTION public.nearby_cities_by_distance(text, int) TO anon, authenticated;