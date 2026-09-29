-- ============================================================================
-- Page rows are written by the server only.
--
-- Every page write in the app goes through a server function on the service
-- role, which validates it and moves content_version (src/lib/page-drafts.
-- server.ts, src/lib/page-publish.server.ts). The member write policies from
-- the first schema (narrowed to draft/archived by 20260827050000) still let a
-- signed-in member write rows directly through PostgREST with the public key:
--   - a direct PATCH between the publish check and publish_tenant_page_checked
--     keeps content_version, so text that was never checked could go live;
--   - generation.started_at set in the future locks a draft "being written";
--   - a page moved out of billing_suspended mid-reactivation is published by
--     the webhook without the content or domain checks.
-- No client code writes tenant_pages (every writer is a server module on the
-- service role, which bypasses RLS and these grants), so the member write
-- path goes. Members keep reading their own workspace's rows.
-- Rollback: supabase/rollback/20260929000500_mvp_tenant_pages_server_writes_rollback.sql
-- ============================================================================

DROP POLICY IF EXISTS "members insert tenant_pages" ON public.tenant_pages;
DROP POLICY IF EXISTS "members update tenant_pages" ON public.tenant_pages;
DROP POLICY IF EXISTS "members delete tenant_pages" ON public.tenant_pages;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.tenant_pages FROM anon, authenticated;

-- Verification: no client write policy and no client write privilege remain;
-- the members' read policy is untouched.
SELECT 'no member write policies' AS check_name,
       NOT EXISTS (
         SELECT 1 FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'tenant_pages'
            AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
       ) AS ok
UNION ALL
SELECT 'no client write privileges',
       NOT EXISTS (
         SELECT 1 FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND table_name = 'tenant_pages'
            AND grantee IN ('anon', 'authenticated')
            AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
       )
UNION ALL
SELECT 'members still read their pages',
       EXISTS (
         SELECT 1 FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'tenant_pages'
            AND policyname = 'members read tenant_pages' AND cmd = 'SELECT'
       );
