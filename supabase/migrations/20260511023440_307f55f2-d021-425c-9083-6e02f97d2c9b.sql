
-- 1. mb_likes: restrict like-reading to authenticated users so anon cannot scrape user_id UUIDs
DROP POLICY IF EXISTS "Anyone can read likes" ON public.mb_likes;
CREATE POLICY "Authenticated can read likes"
  ON public.mb_likes
  FOR SELECT
  TO authenticated
  USING (true);

-- 2. providers: tighten anon INSERT so submissions must target a real existing workspace
DROP POLICY IF EXISTS "Anyone can submit a provider" ON public.providers;
CREATE POLICY "Anyone can submit a provider"
  ON public.providers
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    is_published = false
    AND submission_status = 'pending'
    AND claim_status = ANY (ARRAY['unclaimed','pending'])
    AND workspace_id IN (SELECT id FROM public.workspaces)
  );

-- 3. feature_requests: anon submissions must target a real existing workspace
DROP POLICY IF EXISTS "Anyone can submit a feature request" ON public.feature_requests;
CREATE POLICY "Anyone can submit a feature request"
  ON public.feature_requests
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    workspace_id IN (SELECT id FROM public.workspaces)
  );

-- 4. storage: stop anonymous listing of the workspace-logos bucket while keeping
--    direct public file access (the bucket's public flag handles that).
--    Restrict the SELECT/list policy to authenticated users.
DROP POLICY IF EXISTS workspace_logos_public_read ON storage.objects;
CREATE POLICY workspace_logos_authenticated_list
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'workspace-logos');
