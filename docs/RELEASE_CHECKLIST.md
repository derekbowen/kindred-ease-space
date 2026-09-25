# Release checklist — launch branch → `main`

One window, in this order. **Stop at the first check that fails** and fix or roll
back before going on. Every step names its own check.

- Supabase project: `xbxhzinnfhosoztqaaao` · Worker: `founders-click` · app deploys
  from `main` through `.github/workflows/deploy-app.yml` (never from Lovable).
- Secrets are never printed, pasted into a chat, a ticket, this file or a saved
  SQL snippet. Commands below read them from files you delete afterwards, from
  stdin, or from Vault inside the database.
- Pool Rental Near Me (PRNM) shares the Supabase project. Nothing here touches
  its functions (`generate-content-batch`, `drive-content-generation`,
  `seed-blog-posts`), its help categories (`getting-started`, `billing`) or the
  Supabase `OPENROUTER_API_KEY` it runs on.

Record as you go:

| | value |
| --- | --- |
| Release SHA (launch branch head, after the R5 merges) | |
| `main` before the release (rollback target) | `123534f…` unless it moved |
| Worker version serving before the release (`bunx wrangler versions list --name founders-click`) | |
| Window start / end (UTC) | |

## 0. Before the window

1. **The release SHA is what CI tested.** `git merge-base --is-ancestor origin/main <SHA>`
   exits 0 (the release is a fast-forward), and that commit's full test chain,
   typecheck and build are green.
2. **OpenAI side** (the backstop that does not depend on this code): the platform
   key was rotated after the plaintext exposure in Worker version `ffbde903`; its
   OpenAI project has a monthly budget limit and, if available, a model
   allowlist of `gpt-5-nano` and `gpt-5-mini`.
3. **Stripe test allowlist.** `STRIPE_TEST_WORKSPACE_IDS` (stripe-webhook
   function secret) is unset, or lists throwaway workspaces only.
4. **One workspace per marketplace.** 000100 adds a UNIQUE (provider,
   marketplace_id); it fails if two workspaces hold the same marketplace:
   ```sql
   SELECT provider, marketplace_id, count(*) FROM public.tenant_integrations
    GROUP BY 1, 2 HAVING count(*) > 1;            -- expect 0 rows
   ```

## 1. Secrets (names only — values are never read back)

1. **Worker `OPENAI_API_KEY` is set.**
   `cd .output/server && bunx wrangler secret list --name founders-click` (after a
   local `bun run build`) lists `OPENAI_API_KEY` (it did on 2026-09-25). The deploy
   preflight refuses to ship without it.
2. **Supabase function secret `OPENAI_API_KEY`** (the daily briefing is its only
   reader): `supabase secrets list --project-ref xbxhzinnfhosoztqaaao` lists it. If
   not: write `OPENAI_API_KEY=<key>` to a file (`umask 077`), then
   `supabase secrets set --env-file <file> --project-ref xbxhzinnfhosoztqaaao`,
   then delete the file.
3. **`CRON_SECRET` is identical in the Worker, in Vault and in the
   `coach-briefing-cron` function secret.** pg_cron sends Vault's copy to the
   Worker's hooks and to the briefing function; the dashboard's "Generate now"
   sends the *Worker's* copy to the *function*. Any mismatch and every on-demand
   briefing reads "Couldn't prepare today's briefing." No copy can be read back
   from the Worker, so compare by behaviour, from the SQL editor — the value stays
   inside the database and only an HTTP status comes out:
   ```sql
   SELECT count(*) FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET';  -- expect 1 (do not select the value)

   -- A: Vault → the Worker. The hook authenticates first; a nil workspace has no
   --    connection, so it then stops with integration_not_found and syncs nothing.
   SELECT net.http_post(
     url := 'https://www.founders.click/api/public/hooks/sync-sharetribe',
     headers := jsonb_build_object('Content-Type', 'application/json',
                                   'Authorization', 'Bearer ' || public._cron_secret()),
     body := '{"workspace_id":"00000000-0000-0000-0000-000000000000"}'::jsonb,
     timeout_milliseconds := 30000) AS worker_probe;

   -- B: Vault → coach-briefing-cron. A nil workspace matches no row, so it
   --    processes nothing and makes no AI call. No JWT is sent, exactly like
   --    pg_cron, so a 200 also proves verify_jwt = false.
   SELECT net.http_post(
     url := 'https://xbxhzinnfhosoztqaaao.supabase.co/functions/v1/coach-briefing-cron',
     headers := jsonb_build_object('Content-Type', 'application/json',
                                   'x-cron-secret', public._cron_secret()),
     body := '{"workspace_id":"00000000-0000-0000-0000-000000000000"}'::jsonb,
     timeout_milliseconds := 30000) AS function_probe;

   -- a few seconds later, with the two ids:
   SELECT id, status_code, left(content, 120) FROM net._http_response
    WHERE id IN (<worker_probe>, <function_probe>);
   ```
   Expect **A: 500 `{"ok":false,"error":"integration_not_found"}`** (authenticated)
   and **B: 200 `{"processed":0,…}`**. A 401 means that copy differs from Vault;
   B 503 means the function has no `CRON_SECRET` at all. Fix a mismatch by setting
   the odd copy from the same source value (Worker: `bunx wrangler secret put
   CRON_SECRET --name founders-click` reads stdin; function: `supabase secrets set
   --env-file`). Without the source value, rotate all three in one sitting from one
   new value: the two commands above, and Vault through psql so the value is in
   neither a saved snippet nor the history:
   `psql "$DB_URL" -v s="$(cat cron_secret.txt)" -c "SELECT vault.update_secret((SELECT id FROM vault.secrets WHERE name = 'CRON_SECRET'), :'s')"`.
   Re-run A and B.
4. **Keep** the Worker's `OPENROUTER_API_KEY` until step 10 (the previous build
   needs it if you roll back) and the Supabase `OPENROUTER_API_KEY` forever (PRNM).

## 2. Migrations — every one of them BEFORE the Worker deploy

Apply one file at a time, in this order, the way earlier releases were applied
(Supabase MCP `apply_migration`, or the SQL editor). After each, run the
verification block at the end of that file and read every row; **stop on any
`false`** and run that file's rollback from `supabase/rollback/`.

- [ ] `20260923000100_marketplace_api_connection.sql`
- [ ] `20260923000200_sync_fanout_cron.sql`
- [ ] `20260923000300_generation_jobs.sql`
- [ ] `20260923000400_launch_hardening.sql`
- [ ] `20260923000500_host_resolver_prefers_verified_domain.sql`
- [ ] `20260924000600_generation_settlement_and_reservations.sql`
- [ ] `20260924000700_grant_supersedes_trial.sql`
- [ ] `20260925000800_ai_spend_reservations.sql`
- [ ] `20260925000900_help_center_platform_fix.sql` (help rows; six rows of `true`)
- [ ] `20260925000910_help_center_claims_fix.sql` (help rows; read the eight rows it prints)
- [ ] `20260925000930_founder_internal_unlimited.sql` (data: at most one grant for the founder workspace; four rows of `true`)

Then run the combined post-migration verification in `supabase/rollback/README.md`.

Why all of them first:
- The new build calls functions these files create (`reserve_generation_slot`,
  `ai_reserve`, …) and fails closed without them; each file is written to be
  harmless to the build that is live now.
- **000900 and 000910 must precede the deploy** (round-4 release review M3). The
  new build un-nests the help article route. Against pre-000900 rows it would
  publish the retired BYOK article (provider names, "unlimited", the `ai-proxy`
  function) at `/help/billing/bring-your-own-ai-key-byok`, the retired
  page-builder and pricing articles, and list them all in `/help/sitemap.xml`.
  (The route now also 404s any article outside a published platform category —
  defence in depth, not a reason to reorder.)

Then the spend controls and cron:
```sql
SELECT * FROM public.ai_platform_settings;
-- platform_ai_enabled = true, daily_budget_micros = 10000000 ($10.00 per UTC day),
-- workspace_reservations_per_minute = 30, and the R5 per-workspace daily cost cap
-- (see 000800's own verification block). Change the ceiling now if you want another.
SELECT jobname, schedule, active FROM cron.job
 WHERE jobname IN ('ai-reap-stale-reservations', 'coach-briefing-nightly', 'sharetribe-sync-30min');
-- ai-reap-stale-reservations */5 * * * * active (new); the other two present and active
```

## 3. Edge functions — after the migrations, before the Worker

Deploy from the repo root of the release SHA. The CLI bundles every `../_shared/`
import. `stripe-webhook` and `coach-briefing-cron` MUST run with `verify_jwt =
false` (`supabase/config.toml` says so; the flag makes it explicit): Stripe and
pg_cron send no JWT, and the Worker sends only `apikey`, so with JWT verification
on the gateway answers every call 401.

```bash
supabase functions deploy stripe-webhook      --no-verify-jwt --project-ref xbxhzinnfhosoztqaaao
supabase functions deploy coach-briefing-cron --no-verify-jwt --project-ref xbxhzinnfhosoztqaaao
supabase functions deploy create-checkout                     --project-ref xbxhzinnfhosoztqaaao
```

`create-checkout` keeps JWT verification **on**; it now refuses the Affiliate
add-on unless the workspace's Sharetribe connection uses the Integration API
(round-4 release review M1).

Deploying through the Supabase MCP `deploy_edge_function` instead? Pass
`verify_jwt: false` for the first two, and every file each one imports, at the same
relative paths:
- `stripe-webhook`: `index.ts`, `../_shared/stripe-catalog.ts`
- `coach-briefing-cron`: `index.ts`, `../_shared/openai.ts`, `../_shared/ai-pricing.ts`
- `create-checkout`: `index.ts`, `../_shared/stripe-catalog.ts`, `../_shared/affiliate-requirement.ts`

Check (no customer data involved):
```bash
# 400 {"error":"Invalid webhook signature"} from the function itself. A 401 means
# the gateway wants a JWT: redeploy with --no-verify-jwt.
curl -sS -o /dev/null -w "stripe-webhook %{http_code}\n" -X POST \
  https://xbxhzinnfhosoztqaaao.supabase.co/functions/v1/stripe-webhook \
  -H "stripe-signature: t=1,v1=bogus" -H "content-type: application/json" -d '{}'
```
and re-run probe **B** from step 1.3 against the new `coach-briefing-cron`: 200.

## 4. Deploy the app

```bash
git push origin <SHA>:main      # fast-forward
```
`deploy-app.yml` runs: the dependency-source guard (registry.npmjs.org only), the
frozen install, typecheck, the full test chain, build, the Worker-secrets
preflight, `wrangler deploy`, eight consecutive identity reads, the smoke.

Check: `curl -s https://www.founders.click/api/public/version` and
`/api/public/edge-health` both name `<SHA>`.

## 5. Smoke

1. The workflow's smoke step is green (job summary). By hand:
   `bun scripts/smoke-production.ts https://www.founders.click --sha <SHA>`.
   Its "auth email can authenticate" check reads founders.click's SPF/DKIM; if only
   that check fails, run `bun run check:email-dns` before thinking about a rollback.
2. Help after M3:
   - `/help/billing/bring-your-own-ai-key-byok` → **404**;
   - `/help/getting-started/welcome-to-founders-click` → **301** to
     `/help/start-here/welcome-to-founders-click`;
   - `/help/sitemap.xml` lists no `bring-your-own-ai-key-byok` and no
     `page-builder` URL.
3. `/robots.txt` disallows `/app$` and `/app/`; `/beta`, `/terms`, `/privacy` render
   with headings, spacing and list bullets.
4. On a connected tenant host, `https://<host>/a/sitemap.xml` answers 200 with a
   `<urlset>`.
5. Sync health: the ops probe needs `OPS_PROBE_SECRET`, which is not a Worker secret
   (it answers 401), so read it from the database instead:
   ```sql
   SELECT workspace_id, auth_mode, last_sync_at, last_sync_status FROM public.tenant_integrations
    ORDER BY last_sync_at DESC NULLS LAST LIMIT 10;
   SELECT status, return_message, start_time FROM cron.job_run_details
    ORDER BY start_time DESC LIMIT 10;
   ```
6. AI on a throwaway workspace: one Quick Page, then
   ```sql
   SELECT status, billing, credits_charged, actual_cost_micros FROM public.ai_spend_reservations
    ORDER BY created_at DESC LIMIT 5;                     -- settled
   ```

## 6. Dashboard "Generate now"

On that workspace's dashboard, Daily Briefing → **Generate now** (or **Refresh**). A
briefing appears. "Couldn't prepare today's briefing" means step 1.3 or the
`verify_jwt` of step 3 is wrong. This is the end-to-end CRON_SECRET check (Worker →
function).

## 7. Kill-switch drill

```sql
UPDATE public.ai_platform_settings SET platform_ai_enabled = false, updated_at = now();
```
An AI action on the throwaway workspace answers "AI features are paused
platform-wide right now. Try again later." and no new reservation reaches `called`.
```sql
UPDATE public.ai_platform_settings SET platform_ai_enabled = true, updated_at = now();
```
The same action works again.

## 8. Delete the four legacy functions

Nothing in the new build calls them, the kill switch and the ceiling do not cover
them, and `help-assistant-chat` is public. `ai-proxy`, `help-assistant-chat` and
`help-assistant-embed` may be deleted earlier (only the old build's help widget
and admin re-index button use the last two); delete `coach-chat` only after step 4.

```bash
supabase functions delete ai-proxy             --project-ref xbxhzinnfhosoztqaaao
supabase functions delete coach-chat           --project-ref xbxhzinnfhosoztqaaao
supabase functions delete help-assistant-chat  --project-ref xbxhzinnfhosoztqaaao
supabase functions delete help-assistant-embed --project-ref xbxhzinnfhosoztqaaao
```

Verify each answers **404**, with a throwaway customer account's access token
(never an admin's):
```bash
for f in ai-proxy coach-chat help-assistant-chat help-assistant-embed; do
  code=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
    "https://xbxhzinnfhosoztqaaao.supabase.co/functions/v1/$f" \
    -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H "Authorization: Bearer $CUSTOMER_JWT" \
    -H "Content-Type: application/json" -d '{}')
  echo "$f $code"; [ "$code" = 404 ] || echo "  ^ still deployed: stop and delete it"
done
supabase functions list --project-ref xbxhzinnfhosoztqaaao   # none of the four listed
```

Then the PRNM isolation probe, with the same customer token — every line PASS,
exit 0:
`CUSTOMER_JWT=… SUPABASE_URL=https://xbxhzinnfhosoztqaaao.supabase.co SUPABASE_PUBLISHABLE_KEY=… bun scripts/probe-prnm-isolation.ts`

## 9. Watch (15–30 minutes)

Edge and function logs free of 5xx; `cron.job_run_details` shows the sync fan-out
and the reaper succeeding; `SELECT count(*) FROM public.ai_spend_reservations WHERE
status = 'held' AND created_at < now() - interval '20 minutes'` stays 0.

## 10. After the burn-in (e.g. 7 days, once rolling back to the old build is no longer wanted)

```bash
bunx wrangler secret delete OPENROUTER_API_KEY --name founders-click
bunx wrangler secret list --name founders-click   # no OPENROUTER_API_KEY, LOVABLE_API_KEY or PLATFORM_AI_MODEL
```
**Never** `supabase secrets unset OPENROUTER_API_KEY`: PRNM's functions run on it.

## Rollback

- **Instant brake, no deploy:** the kill switch (step 7). Lowering
  `daily_budget_micros` throttles instead.
- **Worker:** `bunx wrangler rollback --name founders-click --version-id <recorded
  version>`; `/api/public/version` must then name the old commit. Re-deploying
  `main` undoes this, so also restore `main`:
- **`main`:** the release is a fast-forward, so there is no merge commit to revert.
  Restore the old tree in one new commit and push it (it deploys through CI like
  any release):
  ```bash
  git checkout -B rollback origin/main
  git rm -r -q . && git checkout 123534f -- . && git commit -m "Roll back to 123534f"
  git diff --stat 123534f HEAD        # must be empty
  git push origin rollback:main
  ```
- **Database:** only with the code rollback, back to back, in reverse order, per
  `supabase/rollback/README.md` — 000800 (and 000600/000700) must go with the old
  build. The help rows (000900/000910) can stay: the old build renders them no worse.
- **Edge functions:** redeploy the previous source from git history
  (`git checkout 123534f -- supabase/functions && supabase functions deploy <name> …`,
  `--no-verify-jwt` for `stripe-webhook` and `coach-briefing-cron`). Deleted legacy
  functions stay deleted unless the old build is kept for long.
