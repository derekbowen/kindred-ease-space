# Rollback and verification for the 2026-09-23 launch migrations

Apply order: 000100 → 000200 → 000300 → 000400 → 000500 → 000600 → 000700 → 20260925000800 →
20260925000900 → 20260925000910 → 20260925000930. 000900 and 000910 change help-center rows only;
000930 writes one entitlement grant (see their sections below). 000800 requires 000700 (ai_reserve reads
its workspace_is_internal_unlimited predicate); 000930 requires 000700 (the 'internal' grant type).
Roll back in reverse order. Each rollback file ends with a VERIFY query and states what it will not
restore.

## Post-migration verification (the eight schema migrations, 000100 … 20260925000800; 000900 and 000910 have their own checks below)

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

-- 000600: settlement index, the six generation functions service-role only,
-- reservations table (with provider_called_at), billing-mode column, pin trigger
SELECT indexname FROM pg_indexes
 WHERE schemaname='public' AND indexname='credit_ledger_generation_settlement_uidx';
-- expect one row
SELECT f, has_function_privilege('anon', to_regprocedure(f), 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE') AS auth_exec,
       has_function_privilege('service_role', to_regprocedure(f), 'EXECUTE') AS service_exec
FROM unnest(ARRAY[
 'public.settle_generation_free_quota(uuid,text,text,text)',
 'public.reserve_generation_slot(uuid,uuid,int)',
 'public.mark_generation_provider_called(uuid,uuid)',
 'public.release_generation_slot(uuid,uuid)',
 'public.generation_consumed_last_24h(uuid)',
 'public.tenant_pages_pin_generation_columns()']) AS f;
-- expect anon_exec = false, auth_exec = false, service_exec = true for every row
SELECT prorettype::regtype AS returns FROM pg_proc
 WHERE oid = 'public.reserve_generation_slot(uuid,uuid,int)'::regprocedure;
-- expect text ('reserved' / 'cap_reached' / 'in_progress' / 'consumed')
SELECT to_regprocedure('public.generation_consumed_last_24h(uuid,uuid)') AS old_overload;
-- expect NULL (the count takes the workspace only; items are not counted)
SELECT count(*) FROM public.generation_reservations;   -- 0 before first use
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='generation_reservations' AND column_name='provider_called_at';
-- expect one row
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='tenant_pages' AND column_name='generation_billing_mode';
-- expect one row
SELECT tgname, tgenabled FROM pg_trigger
 WHERE tgrelid = 'public.tenant_pages'::regclass AND tgname = 'tenant_pages_pin_generation_columns';
-- expect one row, tgenabled = 'O' (BEFORE UPDATE; keeps created_at, generation_request_id
-- and generation_billing_mode unless the service role writes them)

-- 20260924000700: a grant supersedes a trial; the granted state zeroes paid capacity;
-- the founder / internal unlimited entitlement (grant_type 'internal') answers first
SELECT prosrc LIKE '%IF v_granted > 0 AND (NOT v_stripe_pub OR v_state = ''trialing'') THEN%' AS supersedes_trial,
       prosrc LIKE '%v_paid := 0;%' AS zeroes_paid,
       prosrc LIKE '%IF public.workspace_is_internal_unlimited(_workspace_id) THEN%' AS internal_first,
       NOT has_function_privilege('anon', oid, 'EXECUTE')
         AND has_function_privilege('service_role', oid, 'EXECUTE') AS service_role_only
  FROM pg_proc WHERE oid = 'public.workspace_capacity(uuid)'::regprocedure;
-- expect true, true, true, true (the rollback's VERIFY expects supersedes_trial, zeroes_paid,
-- internal_branch and internal_type false and service_role_only true)
SELECT has_function_privilege('anon', 'public.workspace_is_internal_unlimited(uuid)', 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', 'public.workspace_is_internal_unlimited(uuid)', 'EXECUTE') AS auth_exec,
       has_function_privilege('service_role', 'public.workspace_is_internal_unlimited(uuid)', 'EXECUTE') AS service_exec;
-- expect false, false, true
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid = 'public.workspace_entitlement_grants'::regclass
   AND conname IN ('workspace_entitlement_grants_grant_type_check','workspace_entitlement_grants_internal_page_limit');
-- expect two rows: grant_type IN ('trial','beta','promotional','manual','internal'), and
-- grant_type <> 'internal' OR page_limit = 1000000

-- 20260925000800: one AI spend architecture (reservations, kill switch, ceiling, per-workspace
-- daily cost cap, reaper, briefing claim and refresh throttle)
SELECT platform_ai_enabled, daily_budget_micros, workspace_reservations_per_minute, workspace_daily_budget_micros
  FROM public.ai_platform_settings;
-- expect one row: true, 10000000 ($10.00/day), 30, 1000000 ($1.00/day per workspace)
SELECT f, has_function_privilege('anon', to_regprocedure(f), 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE') AS auth_exec,
       has_function_privilege('service_role', to_regprocedure(f), 'EXECUTE') AS service_exec
FROM unnest(ARRAY[
 'public._ai_generation_paused()',
 'public._ai_ledger_ref(uuid,uuid,int)',
 'public.ai_workspace_spent_micros(uuid,date)',
 'public._ai_release_row(uuid,uuid,text)',
 'public._ai_settle_row(uuid,uuid,int,int,int,int,bigint,int,text,text,text)',
 'public._ai_expire_workspace(uuid)',
 'public.ai_reserve(uuid,uuid,uuid,text,text,text,int,int,bigint,int,text)',
 'public.ai_mark_called(uuid,uuid)',
 'public.ai_settle(uuid,uuid,int,int,int,int,bigint,int,text,text)',
 'public.ai_release(uuid,uuid)',
 'public.ai_reap_stale_reservations()',
 'public.coach_briefing_claim(uuid,date,uuid)',
 'public.coach_briefing_store(uuid,date,uuid,jsonb)',
 'public.coach_briefing_refresh_allowed(uuid,int)']) AS f;
-- expect anon_exec = false, auth_exec = false, service_exec = true for every row (14 rows)
SELECT public._ai_ledger_ref('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 1) AS ledger_ref;
-- expect '00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002#1': every ai_hold /
-- ai_refund ledger row is keyed by the TENANT's request, so production's GLOBAL
-- credit_ledger_grant_ref_unique never sees two workspaces' refunds under one key (round-4 H1)
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'ai-reap-stale-reservations';
-- expect one row: */5 * * * *, active
SELECT to_regprocedure('public.settle_generation_free_quota(uuid,text,text,text)') AS superseded;
-- expect NULL (000800 settles generation itself; the rollback restores this function)
SELECT count(*) FROM public.ai_spend_reservations;   -- 0 before first use
```

The kill switch (service role / SQL editor only):
```sql
UPDATE public.ai_platform_settings SET platform_ai_enabled = false, updated_at = now();  -- stop
UPDATE public.ai_platform_settings SET platform_ai_enabled = true,  updated_at = now();  -- resume
UPDATE public.ai_platform_settings SET daily_budget_micros = 10000000, updated_at = now(); -- ceiling
UPDATE public.ai_platform_settings SET workspace_daily_budget_micros = 1000000, updated_at = now(); -- per workspace
```
The per-workspace cap counts everything a workspace's platform-key calls held or cost that UTC day,
failed and refunded calls included; it does not apply to a workspace's own key (BYOK) or to a
workspace holding an active 'internal' grant. The kill switch, the platform ceiling and the per-minute
rate limit apply to every workspace, internal ones included.

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
call goes through the service role or the signed-in user's own client. Its
rollback file therefore reverts only consume_platform_ai_credit's body and
never re-opens an anonymous path: no anon/PUBLIC EXECUTE, no anonymous
ticket-insert policy (round-4 security review M2). 000500 changes only which of two matching
workspaces the resolver returns for one hostname; a previous build calls the
same function and is unaffected.
20260924000700 replaces one function body that is evaluated at read time and stores nothing, so no data changes either way. It also admits grant_type 'internal' (CHECK) and adds the predicate workspace_is_internal_unlimited(uuid); its rollback refuses to run while any active 'internal' grant exists (revoke those first — the 000930 rollback revokes the founder's), restores the 4-type CHECK, and drops the predicate only when ai_reserve (000800) no longer needs it. A code-only rollback (previous Worker) leaves the two halves disagreeing for a trialing workspace with an active grant — the DB says 'granted' / grant-only limit, the old app says 'trialing' / trial base + grant — so roll the SQL back with the app if the app is rolled back. Harmless today: 0 such workspaces (verified 2026-09-24).
20260925000800 is additive except for one function it supersedes (settle_generation_free_quota, 000600, never applied in production before it) and the settlement index that went with it. It must be rolled back WITH the code: the build shipped with it reserves every AI call through ai_reserve, and the previous build settles generation through settle_generation_free_quota, which only the rollback restores. The rollback first closes every open hold (held → refunded, called → the customer refunded and the platform budget kept at the full hold) so no customer money stays locked, then drops the tables; the ai_hold / ai_refund ledger rows and ai_usage_log stay as history. Each hold is closed in its own subtransaction: one that cannot be closed raises a WARNING and is listed by the rollback's VERIFY as `UNCLOSED hold: workspace … request … (status, billing, credits): error` — the rest are closed and the rollback completes (the same per-row isolation the lazy expiry and the reaper use).

## 20260925000900 — help center platform fix (data only)

`supabase/migrations/20260925000900_help_center_platform_fix.sql` changes rows,
not schema, and only rows with `workspace_id IS NULL` (the public
founders.click help center). Pool Rental Near Me's categories
`getting-started` and `billing` are read, never written.

**Apply 000900, then 000910, BEFORE the Worker deploy** that un-nests the
article route (`src/routes/help.$category_.$article.tsx`) — never after it
(round-4 release review M3; step order in `docs/RELEASE_CHECKLIST.md`).
Against pre-000900 rows the new route rendered the retired BYOK article
(provider names, "unlimited", the `ai-proxy` function) at
`/help/billing/bring-your-own-ai-key-byok`, plus the retired page-builder and
old pricing articles, and listed them in `/help/sitemap.xml`. The app now also
refuses any article whose category is not a published platform category
(`src/lib/help.server.ts`), but that is defence in depth, not a reason to
reorder. Applied first, against the live (nested-route) build, these rows
render no worse than today.

What it changes, row by row:

| table | slug | change |
| --- | --- | --- |
| help_categories | `start-here` | **new** platform category "Getting started", published, `sort_order` 0 (or one below the lowest platform category) |
| help_articles | `welcome-to-founders-click` | `category_slug` getting-started → start-here |
| help_articles | `connecting-your-sharetribe-marketplace` | category → start-here; `content` rewritten; `excerpt` (only from its seeded text); `reading_time_minutes` 4 → 2 (only from 4) |
| help_articles | `running-your-first-listing-sync` | category → start-here; `content` rewritten; `reading_time_minutes` 2 → 1 (only from 2) |
| help_articles | `creating-your-first-seo-page` | `category_slug` getting-started → start-here |
| help_articles | `publishing-pages-and-getting-indexed` | `category_slug` getting-started → start-here |
| help_articles | `bring-your-own-ai-key-byok` | `status` published → draft, `is_published` true → false (stays in `billing`) |
| help_articles | `troubleshooting-failed-syncs` | `content` rewritten; `reading_time_minutes` 4 → 1 (only from 4) |
| help_articles | `where-to-find-integration-api-credentials` | `title` → "Where to find your Client ID"; `content` rewritten; `excerpt` (only from its seeded text); `reading_time_minutes` 2 → 1 (only from 2). Slug kept, URL unchanged |

`updated_at` moves on the four rewritten articles (content changed). The
search index (`search_vector`) is recomputed by its trigger. A workspace-owned
`start-here` category aborts the run before any change. Re-running changes
nothing.

```sql
-- 20260925000900: the file ends with this check; expect six rows of true
-- (start-here first and published; five articles moved; no published platform
-- article left in a PRNM category; BYOK a draft; the four articles on the
-- launch flow; PRNM's two categories still PRNM's).
SELECT slug, category_slug, status, is_published, title, reading_time_minutes
  FROM public.help_articles
 WHERE workspace_id IS NULL
   AND slug IN ('welcome-to-founders-click','connecting-your-sharetribe-marketplace',
                'running-your-first-listing-sync','creating-your-first-seo-page',
                'publishing-pages-and-getting-indexed','bring-your-own-ai-key-byok',
                'troubleshooting-failed-syncs','where-to-find-integration-api-credentials')
 ORDER BY slug;
```

Rollback: `supabase/rollback/20260925000900_help_center_platform_fix_rollback.sql`
restores the previous category, title, content and publish state verbatim
(production text as of 2026-09-25), puts excerpts and reading times back only
where the migration's own values are still in place, and deletes
`start-here` only if nothing else has been filed under it. It does not
restore `updated_at` and restores the audited defect (six public articles 404),
so use it only to unblock something else. Verified locally against a
PostgreSQL 16 copy of the help tables seeded by the repo's own seed
migrations: first run changes exactly the rows above, a second run changes
nothing, no PRNM row changes, and the rollback returns every row to its prior
values except `updated_at`.

## 20260925000910 — help center claims fix (data only)

`supabase/migrations/20260925000910_help_center_claims_fix.sql` changes rows, not schema, and only rows with
`workspace_id IS NULL` (the public founders.click help center). Apply it after 000900 (it rewrites
`creating-your-first-seo-page`, which 000900 moved into `start-here`). No Pool Rental Near Me row is written.

| Table | Row | Change |
|---|---|---|
| help_articles | `understanding-page-limits` | `content` → the real plans (Starter 100 … Agency 5,000; 1,000-page add-ons on paid plans) — only from its exact seeded text |
| help_articles | `submitting-your-sitemap` | `content` → sitemap at `https://<domain>/a/sitemap.xml` — only from its exact seeded text |
| help_articles | `handling-multiple-marketplaces` | `title`, `excerpt`, `content` → one marketplace per workspace — only from its exact seeded text |
| help_articles | `creating-your-first-seo-page` | `content` → Quick Page Builder → Generate & publish — only from its exact seeded text |
| help_articles | `mapping-custom-fields-to-page-variables`, `using-the-matrix-builder`, `writing-seo-content-with-ai`, `understanding-page-templates` | `status` published → draft, `is_published` true → false |
| help_categories | `page-builder` | `is_published` true → false, only when it has no published platform article left |

The file ends with a SELECT of the eight articles; expect the four rewrites to start with their new first lines and the
four others to read `is_published = false, status = draft`.

Rollback: `supabase/rollback/20260925000910_help_center_claims_fix_rollback.sql` (restores the 2026-09-25 values verbatim;
each content restore only while the row still holds the migration's text).

## 20260925000930 — founder / internal unlimited grant (data only)

`supabase/migrations/20260925000930_founder_internal_unlimited.sql` writes at most ONE row and changes no
schema. Apply it after 000700 (the 'internal' grant type) and, like every migration above, before the
Worker deploy.

| table | row | value |
| --- | --- | --- |
| workspace_entitlement_grants | workspace_id | `509e5a42-7eb9-4bdb-8b6c-981a15b69dce` ("My Marketplace", test.poolrentalnearme.com) |
| | grant_type | `internal` ("Founder / Internal Unlimited") |
| | page_limit | `1000000` (the CHECK requires the maximum for an internal grant) |
| | starts_at | `now()` at apply time |
| | expires_at | `NULL` (permanent) |
| | revoked_at | `NULL` |
| | granted_by | `26c3147d-89eb-4491-9882-f7da344657fc` (the platform admin account) |
| | reason | `Founder internal unlimited account for end-to-end product testing (owner request 2026-09-25)` |
| | metadata | `{"source": "migration 20260925000930_founder_internal_unlimited", "label": "Founder / Internal Unlimited"}` |

Guarded: the row is written only when the workspace exists, its ONLY owner in workspace_members is auth
user `7b3618d3-4d54-4974-8daf-2845777ccc28`, the granting account exists and has_role(…, 'admin'), and
the workspace holds no active internal grant yet. Otherwise a NOTICE names the guard and nothing is
written; a second run writes nothing. No other workspace — including any other workspace an admin owns —
is touched: the grant names this workspace, nothing is derived from who owns it.

```sql
-- 20260925000930: the file ends with this check; expect four rows of true
-- (exactly one active permanent internal grant on the founder workspace; the predicate says so;
-- no other workspace holds an active internal grant; workspace_capacity reads 'internal', serves,
-- publishes, page limit 2147483647).
SELECT workspace_id, grant_type, page_limit, starts_at, expires_at, revoked_at, granted_by, reason, metadata
  FROM public.workspace_entitlement_grants
 WHERE grant_type = 'internal' ORDER BY created_at;
```

Rollback: `supabase/rollback/20260925000930_founder_internal_unlimited_rollback.sql` sets `revoked_at` on
that grant only (matched by workspace, type, active and the migration's metadata source) — the row stays as
history, nothing is deleted, no page is unpublished. The workspace falls back to its own billing facts and
any other grants on the next read (capacity, publishing, the generation cap, AI billing and the
per-workspace AI cap all read the grant fresh). Its VERIFY expects `migration_grant_active = 0`; a second
run changes nothing. Verified on PGlite with the full AI chain (tests/founder-internal-unlimited.test.ts):
wrong owner, a second owner, a non-admin or missing granter, and a missing workspace each write nothing;
the happy path writes exactly the row above; a re-run writes nothing; the rollback revokes only that row.
