CREATE TABLE public.feature_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  email text NOT NULL,
  name text,
  request_text text NOT NULL,
  city text,
  region text,
  latitude double precision,
  longitude double precision,
  user_agent text,
  referrer_path text,
  status text NOT NULL DEFAULT 'new',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.feature_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage feature requests"
ON public.feature_requests
FOR ALL
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Anyone can submit a feature request"
ON public.feature_requests
FOR INSERT
TO anon, authenticated
WITH CHECK (true);

CREATE TRIGGER update_feature_requests_updated_at
BEFORE UPDATE ON public.feature_requests
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_feature_requests_created_at ON public.feature_requests (created_at DESC);