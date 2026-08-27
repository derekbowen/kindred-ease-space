-- RLS helper functions must be EXECUTEable by the roles whose queries invoke
-- them. Policies across the schema call has_role() (admin-escape policies) and
-- is_workspace_member/is_workspace_owner; without EXECUTE for authenticated,
-- ANY SELECT touching a table with such a policy fails outright with
-- "permission denied for function has_role" — which took down reads of
-- workspaces, workspace_members, profiles, credit_balances, credit_ledger,
-- subscriptions, content_404_log, workspace_affiliate_settings and
-- addon_requests for every logged-in user (the app shell's own membership
-- query included).
--
-- Granting EXECUTE is safe: these are boolean membership predicates; row
-- access is still decided by the policies that call them.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('has_role','is_workspace_member','is_workspace_owner')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, anon', r.sig);
  END LOOP;
END $$;
