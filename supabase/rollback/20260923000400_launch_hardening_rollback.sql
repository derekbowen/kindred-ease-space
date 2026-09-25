-- ROLLBACK for 20260923000400_launch_hardening.sql
--
-- What this undoes: the one behavioural change 000400 made to a function body —
-- consume_platform_ai_credit's membership guard — in case that guard is ever
-- what breaks an application build.
--
-- What this deliberately does NOT undo (round-4 security review, M2): the grant
-- tightening and the removal of the anonymous ticket-insert policy. Before
-- 000400, anon and PUBLIC could execute every function listed below and insert
-- unlimited support tickets — the audited vulnerability. No build needs that
-- access, checked against every caller in both the live build (123534f) and the
-- launch branch:
--   consume_platform_ai_credit           service role only (ai-metering, quick page;
--                                         after 000800 it also drains the free quota
--                                         ai_reserve spends, so anon EXECUTE would let
--                                         anyone empty any workspace's free AI)
--   provision_workspace_for_user,        the signed-in user's own client
--   tenant_set/delete_ai_credential,     (context.supabase / supabase.rpc as the user)
--   tenant_set_integration_secret,       → authenticated + service_role
--   tenant_set/delete_workspace_secret
--   current_workspace_id_by_host,        service role (public page loader uses
--   workspace_for_host                   supabaseAdmin; workspace_for_host has no caller)
--   support_tickets inserts              service role (help-tickets.functions.ts) — no
--                                         policy needed, so none is recreated
-- The grants below therefore restate 000400's least-privilege grants; re-running
-- this file never widens access. Re-runnable.
BEGIN;
-- consume_platform_ai_credit: the pre-000400 body (no membership guard). Only
-- the service role can call it, so the missing guard cannot be reached by a
-- tenant.
CREATE OR REPLACE FUNCTION public.consume_platform_ai_credit(_workspace_id uuid)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_remaining int;
BEGIN
  INSERT INTO public.workspace_ai_quota (workspace_id) VALUES (_workspace_id)
  ON CONFLICT (workspace_id) DO NOTHING;
  UPDATE public.workspace_ai_quota
    SET platform_credits_remaining = platform_credits_remaining - 1,
        lifetime_platform_used = lifetime_platform_used + 1
    WHERE workspace_id = _workspace_id
      AND platform_credits_remaining > 0
    RETURNING platform_credits_remaining INTO v_remaining;
  IF v_remaining IS NULL THEN
    RAISE EXCEPTION 'platform_ai_quota_exhausted' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_remaining;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.consume_platform_ai_credit(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_platform_ai_credit(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.provision_workspace_for_user(text,text,text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.provision_workspace_for_user(text,text,text,boolean) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.tenant_set_ai_credential(uuid,text,text,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_set_ai_credential(uuid,text,text,text,jsonb) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.tenant_delete_ai_credential(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_delete_ai_credential(uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.tenant_set_integration_secret(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_set_integration_secret(uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.tenant_set_workspace_secret(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_set_workspace_secret(uuid,text,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.tenant_delete_workspace_secret(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tenant_delete_workspace_secret(uuid,uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.current_workspace_id_by_host(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_workspace_id_by_host(text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.workspace_for_host(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_for_host(text) TO service_role;

-- The anonymous ticket-insert policy stays dropped (see header).
DROP POLICY IF EXISTS "Anyone can create tickets" ON public.support_tickets;
COMMIT;

-- VERIFY (after this rollback): every row false — no anonymous path re-opened.
SELECT 'anon can execute consume_platform_ai_credit' AS check,
       has_function_privilege('anon','public.consume_platform_ai_credit(uuid)','EXECUTE') AS open
UNION ALL SELECT 'authenticated can execute consume_platform_ai_credit',
       has_function_privilege('authenticated','public.consume_platform_ai_credit(uuid)','EXECUTE')
UNION ALL SELECT 'anon can execute provision_workspace_for_user',
       has_function_privilege('anon','public.provision_workspace_for_user(text,text,text,boolean)','EXECUTE')
UNION ALL SELECT 'anon can execute tenant_set_integration_secret',
       has_function_privilege('anon','public.tenant_set_integration_secret(uuid,text)','EXECUTE')
UNION ALL SELECT 'anon can execute tenant_set_workspace_secret',
       has_function_privilege('anon','public.tenant_set_workspace_secret(uuid,text,text)','EXECUTE')
UNION ALL SELECT 'anon can execute current_workspace_id_by_host',
       has_function_privilege('anon','public.current_workspace_id_by_host(text)','EXECUTE')
UNION ALL SELECT 'anonymous ticket-insert policy exists',
       EXISTS (SELECT 1 FROM pg_policies WHERE tablename='support_tickets' AND policyname='Anyone can create tickets');
