-- ============================================================================
-- CRITICAL: close the direct-PostgREST publish bypass.
--
-- The entire page-entitlement model assumes 'published' is only reachable
-- through publish_tenant_pages() (the atomic, limit-enforcing gate). But the
-- member INSERT/UPDATE policies had WITH CHECK = membership only, so an
-- authenticated customer could POST directly to /rest/v1/tenant_pages with
-- status='published' (public anon key + their own JWT) and mint unlimited live
-- pages, bypassing the plan limit entirely.
--
-- Fix: customers may only write DRAFT/ARCHIVED rows. The published and
-- billing_suspended states are set exclusively by the service-role server path
-- (server functions + the SECURITY DEFINER publish gate), which bypasses RLS.
-- All app writes already go through that path, so the UI is unaffected.
-- ============================================================================

DROP POLICY IF EXISTS "members insert tenant_pages" ON public.tenant_pages;
CREATE POLICY "members insert tenant_pages"
  ON public.tenant_pages FOR INSERT
  WITH CHECK (
    public.is_workspace_member(workspace_id, auth.uid())
    AND status IN ('draft', 'archived')
  );

DROP POLICY IF EXISTS "members update tenant_pages" ON public.tenant_pages;
CREATE POLICY "members update tenant_pages"
  ON public.tenant_pages FOR UPDATE
  USING (public.is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (
    public.is_workspace_member(workspace_id, auth.uid())
    AND status IN ('draft', 'archived')
  );

-- Verification: the two write policies must carry the status guard.
SELECT 'insert policy guarded' AS check,
       EXISTS (
         SELECT 1 FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'tenant_pages'
            AND policyname = 'members insert tenant_pages'
            AND with_check ILIKE '%status%'
       ) AS ok
UNION ALL
SELECT 'update policy guarded',
       EXISTS (
         SELECT 1 FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'tenant_pages'
            AND policyname = 'members update tenant_pages'
            AND with_check ILIKE '%status%'
       );
