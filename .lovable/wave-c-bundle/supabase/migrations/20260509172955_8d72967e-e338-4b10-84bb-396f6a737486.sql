CREATE TABLE public.redirect_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  from_slug TEXT NOT NULL,
  to_slug TEXT NOT NULL,
  redirected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent TEXT,
  referrer TEXT
);

CREATE INDEX idx_redirect_log_redirected_at ON public.redirect_log (redirected_at DESC);

ALTER TABLE public.redirect_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage redirect log"
ON public.redirect_log
FOR ALL
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));