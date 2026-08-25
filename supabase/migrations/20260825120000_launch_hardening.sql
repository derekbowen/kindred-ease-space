-- Launch hardening: close two cross-tenant holes found in the pre-launch audit.
--
-- 1) workspace_members self-insert takeover (CRITICAL)
--    The prior policy only checked `user_id = auth.uid()`, so any authenticated
--    user could POST directly to /rest/v1/workspace_members and insert themselves
--    into ANY workspace_id — even with role='owner' — gaining full cross-tenant
--    read/write and owner takeover. All legitimate membership creation goes
--    through the SECURITY DEFINER provision_workspace_for_user RPC (which bypasses
--    RLS), so client inserts only need to support a future owner-driven invite:
--    an owner may add a NON-owner member to a workspace they already own.
--
-- 2) Unverified marketplace_domain host resolution (HIGH)
--    current_workspace_id_by_host matched workspaces.marketplace_domain with no
--    ownership proof. addWorkspaceDomain seeds marketplace_domain BEFORE
--    verification, so a tenant could claim any hostname (including a competitor's)
--    and have public tenant pages resolve to them. Gate that branch on
--    domain_verified_at, which is only set by verifyWorkspaceDomain after a real
--    DNS/file challenge. Verified custom domains keep resolving (both here and via
--    the already-verified workspace_domains branch).

-- 1) --------------------------------------------------------------------------
DROP POLICY IF EXISTS "authenticated insert own membership" ON public.workspace_members;

CREATE POLICY "owners add non-owner members"
  ON public.workspace_members FOR INSERT TO authenticated
  WITH CHECK (
    role <> 'owner'
    AND public.is_workspace_owner(workspace_id, auth.uid())
  );

-- 2) --------------------------------------------------------------------------
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
