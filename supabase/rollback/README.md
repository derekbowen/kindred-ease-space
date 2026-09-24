# Rollback and verification for the 2026-09-23 launch migrations

Apply order: 000100 → 000200 → 000300 → 000400 → 000500 → 000600 → 000700. Roll back in reverse
order. Each rollback file ends with a VERIFY query and states what it will not
restore.

## Post-migration verification (run after applying all seven)

```sql
-- 000100: columns + constraints present, secret column nullable
SELECT column_name, is_nullable FROM information_schema.columns
 WHERE table_schema='public' AND table_name='tenant_integrations'
   AND column_name IN ('auth_mode','marketplace_name','client_secret_vault_id');
-- expect auth_mode NO, marketplace_name YES, client_secret_vault_id YES
SELECT conname, contype FROM pg_constraint
 WHERE conname IN ('tenant_integrations_auth_mode_check','tenant_integrations_provider_marketplace_id_key');
-- expect both rows: the check constraint (c) and the one-workspace-per-marketplace unique (u)

-- 000200: exactly one sharetribe job, fan-out function present
SELECT jobname, schedule, active FROM cron.job WHERE jobname ILIKE '%sharetribe%';
SELECT proname FROM pg_proc WHERE proname = 'enqueue_sharetribe_syncs';
-- expect one job 'sharetribe-sync-30min' (*/30 * * * *) and one function

-- 000300: tables + seeded knobs
SELECT key, value FROM public.platform_settings ORDER BY key;
-- expect generation_daily_cap=50, generation_paused=false
SELECT count(*) FROM public.generation_jobs;   -- 0 before first use

-- 000400: privileges withdrawn from anon, policy gone
SELECT f, has_function_privilege('anon', to_regprocedure(f), 'EXECUTE') AS anon_exec
FROM unnest(ARRAY[
 'public.consume_platform_ai_credit(uuid)','public.provision_workspace_for_user(text,text,text,boolean)',
 'public.tenant_set_ai_credential(uuid,text,text,text,jsonb)','public.tenant_delete_ai_credential(uuid,text)',
 'public.tenant_set_integration_secret(uuid,text)','public.tenant_set_workspace_secret(uuid,text,text)',
 'public.tenant_delete_workspace_secret(uuid,uuid)','public.current_workspace_id_by_host(text)',
 'public.workspace_for_host(text)']) AS f;
-- expect anon_exec = false for every row
SELECT count(*) FROM pg_policies WHERE tablename='support_tickets' AND policyname='Anyone can create tickets';
-- expect 0

-- 000500: host resolver ranks a verified custom domain above marketplace_domain
SELECT prosrc LIKE '%ORDER BY priority ASC, verified_at DESC NULLS LAST, id ASC%' AS ordered
  FROM pg_proc WHERE oid = 'public.current_workspace_id_by_host(text)'::regprocedure;
-- expect true

-- 000600: settlement index, the three generation functions service-role only,
-- reservations table, billing-mode column
SELECT indexname FROM pg_indexes
 WHERE schemaname='public' AND indexname='credit_ledger_generation_settlement_uidx';
-- expect one row
SELECT f, has_function_privilege('anon', to_regprocedure(f), 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE') AS auth_exec,
       has_function_privilege('service_role', to_regprocedure(f), 'EXECUTE') AS service_exec
FROM unnest(ARRAY[
 'public.settle_generation_free_quota(uuid,text,text,text)',
 'public.reserve_generation_slot(uuid,uuid,int)',
 'public.generation_consumed_last_24h(uuid,uuid)']) AS f;
-- expect anon_exec = false, auth_exec = false, service_exec = true for every row
SELECT count(*) FROM public.generation_reservations;   -- 0 before first use
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='tenant_pages' AND column_name='generation_billing_mode';
-- expect one row

-- 20260924000700: a grant supersedes a trial; the granted state zeroes paid capacity
SELECT prosrc LIKE '%IF v_granted > 0 AND (NOT v_stripe_pub OR v_state = ''trialing'') THEN%' AS supersedes_trial,
       prosrc LIKE '%v_paid := 0;%' AS zeroes_paid,
       NOT has_function_privilege('anon', oid, 'EXECUTE')
         AND has_function_privilege('service_role', oid, 'EXECUTE') AS service_role_only
  FROM pg_proc WHERE oid = 'public.workspace_capacity(uuid)'::regprocedure;
-- expect true, true, true (the rollback's VERIFY expects false, false, true)
```

## Forward repair instead of rollback
000100 and 000300 are additive; the previous application build ignores the new
columns and tables, so a code-only rollback (redeploy the previous Worker
version) needs no database change. 000100 also adds a UNIQUE
(provider, marketplace_id) on tenant_integrations, which the previous build
tolerates; dropping it re-opens the one-marketplace-many-workspaces hole.
000200 replaces one cron job with an equivalent that fans out per workspace;
the previous build's hook accepts the per-workspace body as well as an empty
body. 000400 only removes privileges the application never used from
`authenticated`/`anon`; a previous build keeps working because every affected
call goes through the service role. 000500 changes only which of two matching
workspaces the resolver returns for one hostname; a previous build calls the
same function and is unaffected.
20260924000700 replaces one function body that is evaluated at read time and stores nothing, so no data changes either way. A code-only rollback (previous Worker) leaves the two halves disagreeing for a trialing workspace with an active grant — the DB says 'granted' / grant-only limit, the old app says 'trialing' / trial base + grant — so roll the SQL back with the app if the app is rolled back. Harmless today: 0 such workspaces (verified 2026-09-24).
