CREATE TABLE IF NOT EXISTS public.availability_cache (
  listing_id uuid PRIMARY KEY,
  slots jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.availability_cache ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.availability_cache FROM anon, authenticated;

CREATE POLICY "Admins manage availability cache"
ON public.availability_cache
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));