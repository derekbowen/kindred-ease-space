# Rollback and verification for the 2026-09-23 launch migrations

Apply order: 000100 → 000200 → 000300 → 000400. Roll back in reverse order.
Each rollback file ends with a VERIFY query and states what it will not restore.

## Post-migration verification (run after applying all four)

```sql
-- 000100: columns + constraint present, secret column nullable
SELECT column_name, is_nullable FROM information_schema.columns
 WHERE table_schema='public' AND table_name='tenant_integrations'
   AND column_name IN ('auth_mode','marketplace_name','client_secret_vault_id');
-- expect auth_mode NO, marketplace_name YES, client_secret_vault_id YES

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
```

## Forward repair instead of rollback
000100 and 000300 are additive; the previous application build ignores the new
columns and tables, so a code-only rollback (redeploy the previous Worker
version) needs no database change. 000200 replaces one cron job with an
equivalent that fans out per workspace; the previous build's hook accepts the
per-workspace body as well as an empty body. 000400 only removes privileges the
application never used from `authenticated`/`anon`; a previous build keeps
working because every affected call goes through the service role.
