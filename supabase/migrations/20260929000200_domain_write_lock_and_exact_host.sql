-- ============================================================================
-- DOMAINS: ONLY THE SERVER WRITES DOMAIN ROWS; A HOST RESOLVES EXACTLY
-- (MVP release review, 2026-09-28)
--
-- 1. "owners write domains" (20260511021704) let any workspace owner INSERT or
--    UPDATE workspace_domains directly through PostgREST — every column,
--    verified and status included. verifyWorkspaceDomain trusts a row that is
--    already verified and provisions the Cloudflare custom hostname and Worker
--    route for it, and the host resolver prefers verified rows: an owner could
--    mark someone else's hostname verified and squat it (and serve on it once
--    its DNS reached the edge). Every legitimate write already goes through the
--    service role (src/lib/admin-domains.functions.ts, workspace.functions.ts),
--    so client writes are withdrawn entirely. Owners keep reading their rows.
--
-- 2. current_workspace_id_by_host stripped "www." from the REQUEST host and
--    compared it with the stored hostname exactly. A row stored as
--    "www.example.com" therefore never matched, and a request for
--    "www.example.com" resolved to whichever workspace had verified the bare
--    "example.com" — another tenant's pages and sitemap on a host nobody
--    proved. A host now resolves only to the exact hostname that was verified
--    (case-insensitive, port removed). src/lib/sitemap.server.ts mirrors this.
--
-- Rollback: supabase/rollback/20260929000200_domain_write_lock_and_exact_host_rollback.sql
-- ============================================================================

-- 1) writes through the server only -----------------------------------------------
DROP POLICY IF EXISTS "owners write domains" ON public.workspace_domains;
REVOKE INSERT, UPDATE, DELETE ON public.workspace_domains FROM anon, authenticated;

-- 2) exact host --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_workspace_id_by_host(_host text)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH normalized AS (
    SELECT lower(btrim(regexp_replace(COALESCE(_host, ''), ':\d+$', ''))) AS h
  )
  SELECT id
    FROM (
      -- priority 0: a verified custom domain — ownership of this exact
      -- hostname was proven by a DNS/file challenge.
      SELECT wd.workspace_id AS id,
             0 AS priority,
             wd.verified_at::timestamptz AS verified_at
        FROM public.workspace_domains wd, normalized n
       WHERE wd.verified = true
         AND n.h <> ''
         AND lower(wd.hostname) = n.h
      UNION ALL
      -- priority 1: legacy — the workspace-level marketplace_domain, gated on
      -- the workspace-level verified flag, exact hostname only.
      SELECT w.id,
             1 AS priority,
             w.domain_verified_at::timestamptz AS verified_at
        FROM public.workspaces w, normalized n
       WHERE n.h <> ''
         AND lower(w.marketplace_domain) = n.h
         AND w.domain_verified_at IS NOT NULL
    ) matches
   ORDER BY priority ASC, verified_at DESC NULLS LAST, id ASC
   LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.current_workspace_id_by_host(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_workspace_id_by_host(text) TO service_role;

-- Verification: every row should read true.
SELECT 'clients cannot insert, update or delete domain rows' AS check,
       NOT has_table_privilege('authenticated', 'public.workspace_domains', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.workspace_domains', 'UPDATE')
       AND NOT has_table_privilege('authenticated', 'public.workspace_domains', 'DELETE')
       AND NOT has_table_privilege('anon', 'public.workspace_domains', 'UPDATE') AS ok
UNION ALL SELECT 'owners still read their own domain rows',
       EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.workspace_domains'::regclass
                AND polname = 'owners read domains' AND polcmd = 'r')
UNION ALL SELECT 'the write policy is gone',
       NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.workspace_domains'::regclass
                    AND polname = 'owners write domains')
UNION ALL SELECT 'the resolver no longer strips www.',
       (SELECT prosrc NOT LIKE '%^www%' FROM pg_proc WHERE oid = 'public.current_workspace_id_by_host(text)'::regprocedure)
UNION ALL SELECT 'the resolver is service-role only',
       NOT has_function_privilege('anon', 'public.current_workspace_id_by_host(text)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.current_workspace_id_by_host(text)', 'EXECUTE')
       AND has_function_privilege('service_role', 'public.current_workspace_id_by_host(text)', 'EXECUTE');
