-- Rollback of 20260929000500_mvp_tenant_pages_server_writes.sql.
-- SECURITY-REGRESSIVE: restores direct member writes to tenant_pages through
-- PostgREST (draft/archived rows only), which bypass the app's content checks
-- and version handling. Use only to restore a client that writes pages
-- directly; the app itself writes on the service role and does not need it.
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON public.tenant_pages TO anon, authenticated;

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

DROP POLICY IF EXISTS "members delete tenant_pages" ON public.tenant_pages;
CREATE POLICY "members delete tenant_pages"
  ON public.tenant_pages FOR DELETE
  USING (public.is_workspace_member(workspace_id, auth.uid()));

SELECT 'member write policies restored' AS check_name,
       (SELECT count(*) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'tenant_pages'
           AND policyname IN ('members insert tenant_pages', 'members update tenant_pages',
                              'members delete tenant_pages')) = 3 AS ok;
