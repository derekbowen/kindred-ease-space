-- Fixed-window rate limiting for public/unauthenticated endpoints (help-assistant
-- chat spends the platform AI key with no auth). Service-role only.

CREATE TABLE IF NOT EXISTS public.rate_limit_hits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  count int NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

ALTER TABLE public.rate_limit_hits ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (which bypasses RLS) may touch this table,
-- exclusively through check_rate_limit below.

-- Atomically increment the counter for (bucket, current window) and report
-- whether the caller is still under the limit. Returns TRUE when allowed.
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  _bucket text,
  _max int,
  _window_seconds int
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window timestamptz;
  v_count int;
BEGIN
  v_window := to_timestamp(
    floor(extract(epoch FROM now()) / _window_seconds) * _window_seconds
  );

  INSERT INTO public.rate_limit_hits (bucket, window_start, count)
  VALUES (_bucket, v_window, 1)
  ON CONFLICT (bucket, window_start)
  DO UPDATE SET count = public.rate_limit_hits.count + 1
  RETURNING count INTO v_count;

  -- Opportunistic cleanup so the table never grows unbounded.
  IF v_count = 1 THEN
    DELETE FROM public.rate_limit_hits
     WHERE window_start < now() - interval '1 day';
  END IF;

  RETURN v_count <= _max;
END;
$$;

REVOKE ALL ON FUNCTION public.check_rate_limit(text, int, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, int, int) TO service_role;
