CREATE TABLE IF NOT EXISTS public.content_404_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url_path text NOT NULL,
  slug text,
  referrer text,
  user_agent text,
  hit_count integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution_notes text
);

CREATE UNIQUE INDEX IF NOT EXISTS content_404_log_url_path_key ON public.content_404_log(url_path);
CREATE INDEX IF NOT EXISTS content_404_log_last_seen_idx ON public.content_404_log(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS content_404_log_unresolved_idx ON public.content_404_log(resolved_at) WHERE resolved_at IS NULL;

ALTER TABLE public.content_404_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage 404 log"
  ON public.content_404_log FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));