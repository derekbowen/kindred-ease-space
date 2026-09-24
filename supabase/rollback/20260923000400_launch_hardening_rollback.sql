-- ROLLBACK for 20260923000400_launch_hardening.sql
-- Restores the grants and the ticket policy to their measured 2026-09-22
-- production state. NOTE: that state is the audited vulnerability (anon could
-- execute every function below and insert support tickets); roll back only to
-- unblock a broken application build, then re-apply the hardening.
-- Re-runnable: the ticket policy is dropped before it is recreated.
BEGIN;
-- consume_platform_ai_credit: previous body had no membership guard
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
GRANT EXECUTE ON FUNCTION public.consume_platform_ai_credit(uuid) TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.provision_workspace_for_user(text,text,text,boolean) TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tenant_set_ai_credential(uuid,text,text,text,jsonb) TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tenant_delete_ai_credential(uuid,text) TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tenant_set_integration_secret(uuid,text) TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tenant_set_workspace_secret(uuid,text,text) TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tenant_delete_workspace_secret(uuid,uuid) TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_workspace_id_by_host(text) TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.workspace_for_host(text) TO PUBLIC, anon, authenticated, service_role;
DROP POLICY IF EXISTS "Anyone can create tickets" ON public.support_tickets;
CREATE POLICY "Anyone can create tickets" ON public.support_tickets FOR INSERT TO public WITH CHECK (true);
COMMIT;
-- VERIFY (rolled back): all true
SELECT has_function_privilege('anon','public.consume_platform_ai_credit(uuid)','EXECUTE') AS anon_credit,
       EXISTS (SELECT 1 FROM pg_policies WHERE tablename='support_tickets' AND policyname='Anyone can create tickets') AS ticket_policy;
