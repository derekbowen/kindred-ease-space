-- Host resolution must prefer proof of ownership.
--
-- current_workspace_id_by_host (20260825120000) unions two matches for a
-- hostname — workspaces.marketplace_domain gated by domain_verified_at, and a
-- verified workspace_domains row — and takes LIMIT 1 with no ORDER BY. The two
-- branches can name DIFFERENT workspaces: addWorkspaceDomain seeds
-- marketplace_domain the moment a hostname is claimed, domain_verified_at is a
-- workspace-level flag, and since 2026-09-22 an unverified claim expires after
-- seven days and the hostname can be claimed, and verified, by another
-- workspace. Which of the two won was whatever the planner emitted first, so
-- a verified custom domain could serve a different tenant's pages.
--
-- Only a verified workspace_domains row proves ownership of THIS hostname, so
-- it ranks first. The legacy marketplace_domain branch stays for workspaces
-- verified before workspace_domains existed. Within a branch the most recent
-- verification wins, then the lowest id, so the answer is deterministic. The
-- matching itself is unchanged: same normalisation, same two branches, same
-- trust boundary (verified rows only). The application mirrors the same rule
-- (preferredHostMatch in src/lib/sitemap.server.ts), addWorkspaceDomain now
-- clears the prior workspace's marketplace_domain on reclaim, and
-- updateWorkspaceProfile resets domain_verified_at when marketplace_domain
-- changes, so the legacy branch shrinks to genuinely verified rows over time.
--
-- Grants: 20260923000400 made both resolvers service_role-only. CREATE OR
-- REPLACE keeps existing grants, but they are restated so this file is
-- correct on its own. workspace_for_host delegates to this function and is
-- untouched.

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
      -- priority 0: a verified custom domain — ownership of this exact
      -- hostname was proven by a DNS/file challenge.
      SELECT wd.workspace_id AS id,
             0 AS priority,
             wd.verified_at::timestamptz AS verified_at
        FROM public.workspace_domains wd, normalized n
       WHERE wd.verified = true
         AND lower(wd.hostname) = n.h
      UNION ALL
      -- priority 1: legacy — the workspace-level marketplace_domain, gated on
      -- the workspace-level verified flag.
      SELECT w.id,
             1 AS priority,
             w.domain_verified_at::timestamptz AS verified_at
        FROM public.workspaces w, normalized n
       WHERE w.marketplace_domain = n.h
         AND w.domain_verified_at IS NOT NULL
    ) matches
   ORDER BY priority ASC, verified_at DESC NULLS LAST, id ASC
   LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.current_workspace_id_by_host(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_workspace_id_by_host(text) TO service_role;

-- Verification: every row should say true.
SELECT 'resolver orders verified workspace_domains first' AS check,
       (SELECT prosrc LIKE '%ORDER BY priority ASC, verified_at DESC NULLS LAST, id ASC%'
          FROM pg_proc WHERE oid = 'public.current_workspace_id_by_host(text)'::regprocedure) AS ok
UNION ALL SELECT 'resolver still gates both branches on verification',
       (SELECT prosrc LIKE '%wd.verified = true%' AND prosrc LIKE '%w.domain_verified_at IS NOT NULL%'
          FROM pg_proc WHERE oid = 'public.current_workspace_id_by_host(text)'::regprocedure)
UNION ALL SELECT 'resolver: anon cannot execute',
       NOT has_function_privilege('anon', 'public.current_workspace_id_by_host(text)', 'EXECUTE')
UNION ALL SELECT 'resolver: authenticated cannot execute',
       NOT has_function_privilege('authenticated', 'public.current_workspace_id_by_host(text)', 'EXECUTE')
UNION ALL SELECT 'resolver: service_role can execute',
       has_function_privilege('service_role', 'public.current_workspace_id_by_host(text)', 'EXECUTE');
