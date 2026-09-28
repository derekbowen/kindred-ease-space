-- ROLLBACK for 20260929000200_domain_write_lock_and_exact_host.sql
--
-- WARNING: this restores two security holes (owners writing their own domain
-- rows, verified flag included; "www." resolving to the bare domain's owner).
-- Only for an incident this migration itself caused.
BEGIN;

GRANT INSERT, UPDATE, DELETE ON public.workspace_domains TO authenticated;
DROP POLICY IF EXISTS "owners write domains" ON public.workspace_domains;
CREATE POLICY "owners write domains" ON public.workspace_domains
  FOR ALL TO authenticated
  USING (public.is_workspace_owner(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_owner(workspace_id, auth.uid()));

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
      SELECT wd.workspace_id AS id, 0 AS priority, wd.verified_at::timestamptz AS verified_at
        FROM public.workspace_domains wd, normalized n
       WHERE wd.verified = true AND lower(wd.hostname) = n.h
      UNION ALL
      SELECT w.id, 1 AS priority, w.domain_verified_at::timestamptz AS verified_at
        FROM public.workspaces w, normalized n
       WHERE w.marketplace_domain = n.h AND w.domain_verified_at IS NOT NULL
    ) matches
   ORDER BY priority ASC, verified_at DESC NULLS LAST, id ASC
   LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION public.current_workspace_id_by_host(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_workspace_id_by_host(text) TO service_role;

COMMIT;

SELECT 'write policy restored' AS check,
       EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.workspace_domains'::regclass
                AND polname = 'owners write domains') AS ok;
