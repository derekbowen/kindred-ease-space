
-- Tighten anonymous INSERT policies on provider_* tables
DROP POLICY IF EXISTS "Anyone can submit a lead" ON public.provider_leads;
CREATE POLICY "Anyone can submit a lead" ON public.provider_leads
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    workspace_id IN (SELECT id FROM public.workspaces)
    AND status = 'new'
  );

DROP POLICY IF EXISTS "Anyone can submit a claim" ON public.provider_claims;
CREATE POLICY "Anyone can submit a claim" ON public.provider_claims
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    workspace_id IN (SELECT id FROM public.workspaces)
    AND status = 'pending'
  );

DROP POLICY IF EXISTS "Anyone can submit a plan request" ON public.provider_plan_requests;
CREATE POLICY "Anyone can submit a plan request" ON public.provider_plan_requests
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    workspace_id IN (SELECT id FROM public.workspaces)
    AND status = 'pending'
  );

-- mb_likes: restrict SELECT so user_id UUIDs aren't enumerable
DROP POLICY IF EXISTS "Authenticated can read likes" ON public.mb_likes;
CREATE POLICY "Users read own likes" ON public.mb_likes
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- mb_threads / mb_replies: keep reading possible but block user_id enumeration
-- by routing through SECURITY DEFINER functions in the app. Restrict raw SELECT
-- to authors + workspace members; aggregate/public reads must go through supabaseAdmin.
DROP POLICY IF EXISTS "Authenticated can read threads" ON public.mb_threads;
CREATE POLICY "Members read threads" ON public.mb_threads
  FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id
    OR is_workspace_member(workspace_id, auth.uid())
    OR has_role(auth.uid(), 'admin'::app_role)
  );

DROP POLICY IF EXISTS "Authenticated can read replies" ON public.mb_replies;
CREATE POLICY "Members read replies" ON public.mb_replies
  FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id
    OR is_workspace_member(workspace_id, auth.uid())
    OR has_role(auth.uid(), 'admin'::app_role)
  );

-- Storage: drop broad SELECT on workspace-logos so the bucket can't be listed via API.
-- Direct public URLs continue to work because the bucket itself is marked public.
DROP POLICY IF EXISTS "workspace_logos_authenticated_list" ON storage.objects;
