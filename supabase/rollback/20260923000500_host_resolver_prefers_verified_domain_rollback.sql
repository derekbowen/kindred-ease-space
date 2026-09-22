-- ROLLBACK for 20260923000500_host_resolver_prefers_verified_domain.sql
-- Restores the 20260825120000 body of current_workspace_id_by_host verbatim:
-- UNION ALL, LIMIT 1, no ORDER BY. NOTE: that body is the audited defect —
-- with two matches for one hostname the winner is whatever the planner
-- returns first — so roll back only to unblock a broken build, then re-apply.
-- The service_role-only grants from 20260923000400 are kept; roll that file
-- back separately (after this one) if the grants must go too. No data changes
-- are involved either way.
BEGIN;
CREATE OR REPLACE FUNCTION public.current_workspace_id_by_host(_host text)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH normalized AS (
    SELECT lower(regexp_replace(regexp_replace(_host, ':\d+$', ''), '^www\.', '')) AS h
  )
  SELECT id
    FROM (
      SELECT w.id
        FROM public.workspaces w, normalized n
       WHERE w.marketplace_domain = n.h
         AND w.domain_verified_at IS NOT NULL
      UNION ALL
      SELECT wd.workspace_id AS id
        FROM public.workspace_domains wd, normalized n
       WHERE wd.verified = true
         AND lower(wd.hostname) = n.h
    ) matches
   LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION public.current_workspace_id_by_host(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_workspace_id_by_host(text) TO service_role;
COMMIT;
-- VERIFY (rolled back): expect ordered = false, service_role_only = true
SELECT prosrc LIKE '%ORDER BY priority%' AS ordered,
       NOT has_function_privilege('anon', oid, 'EXECUTE')
         AND has_function_privilege('service_role', oid, 'EXECUTE') AS service_role_only
  FROM pg_proc WHERE oid = 'public.current_workspace_id_by_host(text)'::regprocedure;
