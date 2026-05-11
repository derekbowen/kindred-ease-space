
-- Track scheduled internal-link-health runs
CREATE TABLE IF NOT EXISTS public.link_health_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at timestamptz NOT NULL DEFAULT now(),
  origin text,
  checked int NOT NULL DEFAULT 0,
  broken_count int NOT NULL DEFAULT 0,
  ok boolean NOT NULL DEFAULT true,
  broken jsonb NOT NULL DEFAULT '[]'::jsonb,
  duration_ms int,
  source text NOT NULL DEFAULT 'cron'
);

CREATE INDEX IF NOT EXISTS link_health_runs_ran_at_idx
  ON public.link_health_runs (ran_at DESC);

ALTER TABLE public.link_health_runs ENABLE ROW LEVEL SECURITY;

-- Admin-only read; writes happen via service role (cron endpoint)
CREATE POLICY "Admins can read link_health_runs"
ON public.link_health_runs FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));
