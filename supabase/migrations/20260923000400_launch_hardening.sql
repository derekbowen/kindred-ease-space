-- Launch hardening: close the RPC-grant and RLS gaps a production audit found
-- on the launch path. Every step is idempotent (CREATE OR REPLACE, REVOKE and
-- GRANT inside existence-guarded DO blocks, DROP POLICY IF EXISTS) so the file
-- can be re-run without harm.
--
-- What it fixes, in order:
--  a. consume_platform_ai_credit is SECURITY DEFINER with no auth or
--     membership check and was executable by anon and authenticated through
--     PostgREST — one RPC call per credit drained any workspace's free AI
--     quota. The app only calls it with the service role
--     (src/lib/ai-metering.server.ts, src/lib/admin-quick-page.functions.ts,
--     supabase/functions/ai-proxy, supabase/functions/coach-chat), so the
--     function becomes service_role-only AND gets a membership guard as
--     defence in depth should a grant ever creep back.
--  b. The tenant secret/credential writers and workspace provisioning were
--     executable by anon. Each is called from a server function behind
--     requireSupabaseAuth using the user's own JWT (src/lib/ai-byok.functions.ts,
--     src/lib/admin-workspace-secrets.functions.ts, src/lib/workspace.functions.ts),
--     so authenticated keeps EXECUTE and anon loses it.
--  c. The host resolvers are only ever called with the service role
--     (src/lib/public-tenant-page.functions.ts via supabaseAdmin;
--     workspace_for_host has no caller at all), and neither is referenced by
--     an RLS policy, so they become service_role-only too.
--  d. support_tickets accepted unlimited anonymous inserts by policy. Its only
--     writers are submitTicket in src/lib/help.server.ts and the admin ticket
--     functions in src/lib/help-tickets.functions.ts, both via supabaseAdmin,
--     which bypasses RLS — the policy served nobody but spammers.
--
-- Deliberately NOT touched: has_role, is_workspace_member and
-- is_workspace_owner are invoked inside RLS policies, some on tables anon can
-- read; revoking their EXECUTE breaks every read (that outage is why
-- 20260827000000_grant_rls_helper_execute.sql exists). help_search_v2,
-- help_suggest_titles and count_providers_by_category are read-only public
-- search helpers and stay as they are.
--
-- On the mechanics: Postgres grants EXECUTE on new functions to PUBLIC by
-- default, so "REVOKE ... FROM anon" alone changes nothing — anon still
-- inherits through PUBLIC. Each revoke below therefore also strips PUBLIC and
-- re-grants the roles that should keep access explicitly.

-- a) --------------------------------------------------------------------------
-- Same body as 20260511084828, plus the guard. Service-role calls carry no JWT
-- (auth.uid() IS NULL) and pass straight through; a user JWT must belong to
-- the workspace it is spending for. The guard sits ahead of the INSERT as
-- well as the UPDATE so a stranger cannot even create a quota row.
CREATE OR REPLACE FUNCTION public.consume_platform_ai_credit(_workspace_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_remaining int;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

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
$$;

REVOKE EXECUTE ON FUNCTION public.consume_platform_ai_credit(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_platform_ai_credit(uuid) TO service_role;

-- b) --------------------------------------------------------------------------
-- Signatures verified against the migrations that define them:
--   provision_workspace_for_user   20260629140000_provision_workspace_rpc.sql
--   tenant_set_ai_credential       20260511084828 (…, _default_models jsonb DEFAULT '{}')
--   tenant_delete_ai_credential    20260511084828
--   tenant_set_integration_secret  20260629120000 (uuid, text)
--   tenant_set_workspace_secret    20260625215247
--   tenant_delete_workspace_secret 20260625215247
-- A signature that has drifted is skipped here with a NOTICE so the loop
-- reports every drifted name rather than stopping at the first; the drift
-- guard ahead of the verification block then fails the migration if any
-- signature did not resolve, so a skip can never pass silently.
DO $$
DECLARE sig text;
BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'public.provision_workspace_for_user(text,text,text,boolean)',
    'public.tenant_set_ai_credential(uuid,text,text,text,jsonb)',
    'public.tenant_delete_ai_credential(uuid,text)',
    'public.tenant_set_integration_secret(uuid,text)',
    'public.tenant_set_workspace_secret(uuid,text,text)',
    'public.tenant_delete_workspace_secret(uuid,uuid)'
  ] LOOP
    IF to_regprocedure(sig) IS NULL THEN
      RAISE NOTICE 'launch_hardening: % not found, skipping anon revoke', sig;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', sig);
  END LOOP;
END $$;

-- c) --------------------------------------------------------------------------
-- Host resolution is a server concern: the tenant page loader resolves the
-- request host with supabaseAdmin, and no policy or client code calls these.
DO $$
DECLARE sig text;
BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'public.current_workspace_id_by_host(text)',
    'public.workspace_for_host(text)'
  ] LOOP
    IF to_regprocedure(sig) IS NULL THEN
      RAISE NOTICE 'launch_hardening: % not found, skipping service-role lockdown', sig;
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
  END LOOP;
END $$;

-- d) --------------------------------------------------------------------------
-- No replacement policy: every application write to support_tickets goes
-- through the service role, which is not subject to RLS. Dropping the policy
-- removes the anonymous PostgREST insert path and changes nothing for the app.
DROP POLICY IF EXISTS "Anyone can create tickets" ON public.support_tickets;

-- Drift guard ------------------------------------------------------------------
-- Every signature the grant loops above target must resolve. The first
-- version wrapped each verification row in coalesce(…, true), so a function
-- whose signature had drifted was skipped by the loops AND reported OK below
-- — the one outcome a verification block exists to prevent. Any name that
-- does not resolve now fails the migration, loudly, with the full list; the
-- migration runs in one transaction, so nothing above is left half-applied.
DO $$
DECLARE
  sig text;
  missing text[] := ARRAY[]::text[];
BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'public.consume_platform_ai_credit(uuid)',
    'public.provision_workspace_for_user(text,text,text,boolean)',
    'public.tenant_set_ai_credential(uuid,text,text,text,jsonb)',
    'public.tenant_delete_ai_credential(uuid,text)',
    'public.tenant_set_integration_secret(uuid,text)',
    'public.tenant_set_workspace_secret(uuid,text,text)',
    'public.tenant_delete_workspace_secret(uuid,uuid)',
    'public.current_workspace_id_by_host(text)',
    'public.workspace_for_host(text)'
  ] LOOP
    IF to_regprocedure(sig) IS NULL THEN
      missing := missing || sig;
    END IF;
  END LOOP;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'launch_hardening: signature drift — % does not resolve, so its grants were skipped. Fix the signature list, then re-run.',
      array_to_string(missing, ', ');
  END IF;
END $$;

-- Verification: every row should say true. Nothing here is wrapped in
-- coalesce(…, true): the drift guard guarantees every signature resolves,
-- so a NULL from has_function_privilege would be a real failure, not a skip.
SELECT 'consume_platform_ai_credit: anon cannot execute' AS check,
       NOT has_function_privilege('anon', 'public.consume_platform_ai_credit(uuid)', 'EXECUTE') AS ok
UNION ALL SELECT 'consume_platform_ai_credit: authenticated cannot execute',
       NOT has_function_privilege('authenticated', 'public.consume_platform_ai_credit(uuid)', 'EXECUTE')
UNION ALL SELECT 'consume_platform_ai_credit: service_role can execute',
       has_function_privilege('service_role', 'public.consume_platform_ai_credit(uuid)', 'EXECUTE')
UNION ALL SELECT 'consume_platform_ai_credit: membership guard present',
       (SELECT prosrc LIKE '%is_workspace_member(_workspace_id, auth.uid())%'
          FROM pg_proc WHERE oid = 'public.consume_platform_ai_credit(uuid)'::regprocedure)
UNION ALL SELECT 'anon revoked: provision_workspace_for_user',
       NOT has_function_privilege('anon', to_regprocedure('public.provision_workspace_for_user(text,text,text,boolean)'), 'EXECUTE')
UNION ALL SELECT 'anon revoked: tenant_set_ai_credential',
       NOT has_function_privilege('anon', to_regprocedure('public.tenant_set_ai_credential(uuid,text,text,text,jsonb)'), 'EXECUTE')
UNION ALL SELECT 'anon revoked: tenant_delete_ai_credential',
       NOT has_function_privilege('anon', to_regprocedure('public.tenant_delete_ai_credential(uuid,text)'), 'EXECUTE')
UNION ALL SELECT 'anon revoked: tenant_set_integration_secret',
       NOT has_function_privilege('anon', to_regprocedure('public.tenant_set_integration_secret(uuid,text)'), 'EXECUTE')
UNION ALL SELECT 'anon revoked: tenant_set_workspace_secret',
       NOT has_function_privilege('anon', to_regprocedure('public.tenant_set_workspace_secret(uuid,text,text)'), 'EXECUTE')
UNION ALL SELECT 'anon revoked: tenant_delete_workspace_secret',
       NOT has_function_privilege('anon', to_regprocedure('public.tenant_delete_workspace_secret(uuid,uuid)'), 'EXECUTE')
UNION ALL SELECT 'authenticated kept: tenant + provision RPCs',
       has_function_privilege('authenticated', to_regprocedure('public.provision_workspace_for_user(text,text,text,boolean)'), 'EXECUTE')
       AND has_function_privilege('authenticated', to_regprocedure('public.tenant_set_ai_credential(uuid,text,text,text,jsonb)'), 'EXECUTE')
       AND has_function_privilege('authenticated', to_regprocedure('public.tenant_delete_ai_credential(uuid,text)'), 'EXECUTE')
       AND has_function_privilege('authenticated', to_regprocedure('public.tenant_set_integration_secret(uuid,text)'), 'EXECUTE')
       AND has_function_privilege('authenticated', to_regprocedure('public.tenant_set_workspace_secret(uuid,text,text)'), 'EXECUTE')
       AND has_function_privilege('authenticated', to_regprocedure('public.tenant_delete_workspace_secret(uuid,uuid)'), 'EXECUTE')
UNION ALL SELECT 'host resolvers: anon and authenticated revoked',
       NOT has_function_privilege('anon', to_regprocedure('public.current_workspace_id_by_host(text)'), 'EXECUTE')
       AND NOT has_function_privilege('authenticated', to_regprocedure('public.current_workspace_id_by_host(text)'), 'EXECUTE')
       AND NOT has_function_privilege('anon', to_regprocedure('public.workspace_for_host(text)'), 'EXECUTE')
       AND NOT has_function_privilege('authenticated', to_regprocedure('public.workspace_for_host(text)'), 'EXECUTE')
UNION ALL SELECT 'support_tickets: anon insert policy gone',
       NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = 'support_tickets'
                      AND policyname = 'Anyone can create tickets')
UNION ALL SELECT 'rls helpers still executable by anon and authenticated',
       (SELECT bool_and(has_function_privilege('anon', p.oid, 'EXECUTE')
                    AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('has_role', 'is_workspace_member', 'is_workspace_owner'));
