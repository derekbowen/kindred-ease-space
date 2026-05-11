
-- 1. Lock down credit functions to service_role only
REVOKE EXECUTE ON FUNCTION public.grant_credits(uuid, integer, text, text, text, jsonb) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.deduct_credits(uuid, integer, text, text, text, text, jsonb) FROM anon, authenticated, public;

-- 2. Remove publicly-readable SELECT policies on tables that contain sensitive data.
-- All reads happen server-side via supabaseAdmin (service role bypasses RLS).
DROP POLICY IF EXISTS "Profiles are viewable by everyone" ON public.profiles;
CREATE POLICY "Users can view their own profile"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Public can read seo overrides" ON public.seo_overrides;

DROP POLICY IF EXISTS "Public can read published providers" ON public.providers;

DROP POLICY IF EXISTS "Public can read published content pages" ON public.content_pages;
