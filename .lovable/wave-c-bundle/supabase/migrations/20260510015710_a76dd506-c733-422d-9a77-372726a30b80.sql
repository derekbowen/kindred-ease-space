
-- 1) Harden ig_leads: force RLS + revoke API grants. Server-only via supabaseAdmin.
ALTER TABLE public.ig_leads FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.ig_leads FROM anon, authenticated;

-- 2) Lock down count_providers_by_category (unused in code; was anon-callable)
ALTER FUNCTION public.count_providers_by_category() SECURITY INVOKER;
REVOKE EXECUTE ON FUNCTION public.count_providers_by_category() FROM PUBLIC, anon, authenticated;

-- 3) Storage: drop broad public listing on city-heroes bucket. Bucket remains
--    public so files are still served via getPublicUrl, but listing is denied.
DROP POLICY IF EXISTS "Public read city-heroes" ON storage.objects;

-- 4) Tighten the four "WITH CHECK (true)" public INSERT policies with
--    minimum-viable validation so they no longer trip the always-true linter.

-- city_link_clicks
DROP POLICY IF EXISTS "Anyone can insert click events" ON public.city_link_clicks;
CREATE POLICY "Anyone can insert click events"
  ON public.city_link_clicks
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    to_city_slug IS NOT NULL
    AND length(to_city_slug) BETWEEN 1 AND 120
    AND (from_city_slug IS NULL OR length(from_city_slug) <= 120)
    AND (referrer_path IS NULL OR length(referrer_path) <= 2048)
    AND (user_agent IS NULL OR length(user_agent) <= 1024)
    AND (visitor_hash IS NULL OR length(visitor_hash) <= 128)
  );

-- feature_requests
DROP POLICY IF EXISTS "Anyone can submit a feature request" ON public.feature_requests;
CREATE POLICY "Anyone can submit a feature request"
  ON public.feature_requests
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    AND length(email) <= 254
    AND length(request_text) BETWEEN 1 AND 5000
    AND (name IS NULL OR length(name) <= 200)
    AND status = 'new'
  );

-- privacy_requests
DROP POLICY IF EXISTS "Anyone can submit a privacy request" ON public.privacy_requests;
CREATE POLICY "Anyone can submit a privacy request"
  ON public.privacy_requests
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    AND length(email) <= 254
    AND request_type IN ('access','delete','opt_out','correction','portability')
    AND (full_name IS NULL OR length(full_name) <= 200)
    AND (details IS NULL OR length(details) <= 5000)
    AND status = 'new'
  );

-- provider_leads
DROP POLICY IF EXISTS "Anyone can submit a lead" ON public.provider_leads;
CREATE POLICY "Anyone can submit a lead"
  ON public.provider_leads
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    AND length(email) <= 254
    AND length(name) BETWEEN 1 AND 200
    AND (message IS NULL OR length(message) <= 5000)
    AND (phone IS NULL OR length(phone) <= 40)
    AND status = 'new'
  );
