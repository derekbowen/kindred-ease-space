# MVP release checkpoint

The single resume point for the Founders.click MVP release. After a restart,
read this first and continue from **Next exact action** — do not repeat the
investigation recorded here.

Scope (owner, 2026-09-28): connect Sharetribe → sync real published listings →
inventory-backed coverage gaps → one of three real templates → draft → edit and
preview the actual page → publish on the verified connected domain → canonical
URL in the correct sitemap. Everything else is deferred (hidden AND gated
server-side), not finished.

## Where things run

| What | Where | Verified |
|---|---|---|
| App repo | `derekbowen/kindred-ease-space` (not `derekbowen/founders`) | 2026-09-28 |
| App deploy | `.github/workflows/deploy-app.yml` on push to `main` → Worker `founders-click` | CI run 36483699751 |
| Edge Worker | `edge/founders-edge`, `.github/workflows/deploy-edge-worker.yml` | — |
| Database | Supabase `xbxhzinnfhosoztqaaao` (shared with PRNM — never touch PRNM functions, data or the shared `OPENROUTER_API_KEY`) | — |

## Current state

| Item | Value |
|---|---|
| Production app | Release `9bffaf8` pushed to `main` 2026-09-29 13:16Z (deploy-app.yml run 36573906960) — see Work log for the verified runtime SHA. Previous: `8ff1c41`, Worker version `42e50f5a-43bc-4ae2-ac87-f3f41111179d` |
| Previous app (rollback) | `8ff1c41`, Worker version `42e50f5a-43bc-4ae2-ac87-f3f41111179d` (before it: `123534f` / `dbb4b72c-…`) |
| Launch branch | `claude/repost-assembly-j3l3qg` = the release SHA + later doc-only commits |
| Migrations in prod | 000100–000930 (2026-09-28) + the MVP set applied 2026-09-29 in order, every verification row true: 20260929000100 (mvp_targets_sync_templates), 000200 (domain_write_lock_and_exact_host), 000300 (mvp_deferred_jobs: coach-briefing-nightly inactive, all other jobs unchanged), 000310 (mvp_help_copy), 000400 (mvp_publish_checked), 000500 (mvp_tenant_pages_server_writes) |
| Edge functions | stripe-webhook v40 (price-first plan, capacity-gated reactivation, stale-subscription guard), create-checkout v42 (add-ons 410), coach-briefing-cron v25 = the 410 retired stub (the briefing is deferred); ai-proxy v23, coach-chat v26, help-assistant-chat v27, help-assistant-embed v27 = 410 stubs. PRNM's functions untouched. |
| AI settings | platform_ai_enabled true, daily ceiling $10, $1/workspace/day, 30 reservations/min (unchanged; no raise without approval) |
| Founder | auth user `7b3618d3-4d54-4974-8daf-2845777ccc28` (Google), sole owner of workspace `509e5a42-7eb9-4bdb-8b6c-981a15b69dce` (test.poolrentalnearme.com); one active permanent `internal` grant (migration 000930); capacity internal/serve/publish/2147483647; ai_reserve bills `internal` |
| Founder domain | `test.poolrentalnearme.com`: workspace_domains status `ssl_pending`, verified, connection_type subdomain, edge_hostname `proxy.founders.click`; public DNS is an A record 13.56.89.89 (DNS-only, the Sharetribe server) — not routed to founders-edge |
| Normal test account | `derekbowencorp+fc-launch-auth-09221653@gmail.com` (27a336e0…), workspace `f02d1aa9-4e72-40fc-859f-dfecbba34a87` (trialing, 25 pages) |

## Approvals on record

- 2026-09-28 "Yes, deploy when clean": merge the launch branch into `main`
  when a fresh review finds no HIGH/CRITICAL; run release migrations in order;
  deploy updated Supabase functions; stop + roll back on failure; then verify.
  NOT covered: deleting legacy functions, Supabase function secrets, Stripe
  test-mode setup, deleting user accounts.
- 2026-09-28 MVP brief: close Founders-only AI paths that bypass spend controls
  with a safe, reversible change after confirming callers (never delete shared
  functions/secrets).

## Work log

| Date | Done | Evidence |
|---|---|---|
| 2026-09-28 | Release 8ff1c41 deployed + verified (migrations, 3 functions, app); kill-switch drill; normal-user journey; founder entitlement (DB) | CI 36483699751; this session |
| 2026-09-28 | Data-import cross-workspace takeover (HIGH) fixed on branch: server-chosen workspace-scoped conflict target, file ids ignored, tenant_pages not importable; bulk editor refuses tenant status | a76eed0, 51e9541; tests/data-import-scope.test.ts 48/48; re-review: closes the hole |
| 2026-09-28 | MVP spine: one target/filter (target.ts), one inventory query, template contracts, migrations 000100 (keys, sync lease, one live page per target, templates, coverage groups) + 000200 (domain rows server-write-only, exact host) | a48c668; coverage-target 39, templates-contract 18, mvp-migrations.pg on PG16 |
| 2026-09-29 | Coverage service (defects A–F: no caps, exact totals, six states, country, legacy pages, dismissals, evidence); groups RPC + dismissals read in ordered ranges (PostgREST caps RPCs at 1,000) | eeb3c74, b6a1d74; coverage-report 26 |
| 2026-09-29 | Draft pipeline: grounding through the page's filter (exact count, prices per currency+unit, fenced untrusted sample, per-template prompts, no availability claims); claim-first drafts keyed by target; failures keep the draft; regenerate into the same row | b6a1d74; page-grounding 33, page-draft-flow 60 |
| 2026-09-29 | Publishing = reachable page: template/filter/inventory/text checks, ACTIVE domain or the exact next step, `publish_tenant_page_checked` (migration 000400: only the validated draft version), live URL probe; live edits validated before any write; slug locked when live | 758cc60; page-publish-flow 45, mvp-migrations.pg 39/39 (PG16: 20 drafts racing for 5 slots → 5) |
| 2026-09-29 | Screens: Opportunities, New page (builder), editor (real preview via the W4 registry), My Pages; QPB / Generate Content / bulk create redirect; batch + quick-page endpoints refuse; unvalidated tenant-pages write endpoints removed | a412232 (local until W4 merges: the editor imports its registry and data builder) |
| 2026-09-29 | Billing: generation included for active/granted (as every plan promises; grace dropped in the review round — publishing is paused there); allowance honours it; webhook price-first plan (Billing Portal changes honoured); capacity-gated reactivation; cancelled customers can check out again | 6c6abbc; mvp-billing 19, stripe-webhook 111, ai-allowance 66 |
| 2026-09-29 | Workstreams merged: W2 sync + connect flow, W4 three templates + one public data path, W1 MVP surface + server-side deferral (W3 sitemap earlier); copy (no add-ons, no AI-settings link, no demo poster); scale proof past PostgREST's 1,000-row cap | 900fd75, d749621, 9c1f97e, 3a7b23d, 4a23f47; mvp-scale 12 |
| 2026-09-29 | Final review (security / money / journey): no CRITICAL; one HIGH (an interrupted draft run locked the editor and its target for good) + MEDIUMs, fixed: abandoned claims shown as interrupted with Try again; a late event for an OLD subscription no longer suspends a resubscribed workspace; last X-Forwarded-Host entry + `private` cache headers + a per-host sitemap memo; honest Resource Article copy; non-Latin place/category keys (ASCII slug stand-ins); slugs never end in a dash or pass 80 with a suffix; legacy-page guidance; 000500 revokes member writes to tenant_pages; regenerate bumps content_version at claim; kill switch honoured at publish; category title/noun; honest sync wording; int4 price clamp; owner-facing price text | this round's commit; page-draft-flow 65, page-publish-flow 49, stripe-webhook 118, sitemap-host 105, coverage-target 46, mvp-migrations.pg 46 (PG16) |

## Design decisions (the spine — every workstream builds on these)

- **One target/filter** — `src/lib/coverage/target.ts`. Keys per field
  (country ISO-2, region with US postal codes only for US/unknown, city and
  category exact slug keys); `scope` says which fields constrain; null = "has no
  value" (explicit); legacy v1 filters keep their old meaning. `applyFilter` is
  the only filter→SQL translation; `targetKey` is the page's coverage identity.
- **One inventory query** — `src/lib/coverage/inventory.server.ts`
  (matchingListingsQuery/countMatchingListings/fetchPageListings/priceSummary/
  readAll/formatMoney). Errors throw; never "zero".
- **Template contracts** — `src/lib/templates/contracts.ts` = the JSON in
  `page_templates.config_schema` (tests/templates-contract.test.ts).
- **Migrations** — `20260929000100` (listing keys + price_unit, sync lease
  functions claim/touch/reconcile/finish, tenant_pages seo_title/target_key
  [unique live]/noindex/content_version/generation + status CHECK, templates
  active, coverage_dismissals, inventory_coverage_groups, sitemap_check) and
  `20260929000200` (domain rows server-write-only; exact-host resolver).
  Both: rollbacks in supabase/rollback; tests/mvp-migrations.pg.ts 26/26 on PG16.
- Background jobs: `competitor-radar-daily` and `daily-seo-digest` belong to
  **PRNM** (its app defines both hooks) — never touch. `coach-briefing-nightly`
  is Founders + deferred → disable (reversible). An inactive `process-auth-emails`
  job embeds a plaintext Supabase secret key in its command → owner decision.
- Add-ons: nobody holds one (0 affiliate, 0 requests, 0 billing events).

## Known limitations (documented, not fixed in this release)

- **past_due grace anchor**: the retry window is `current_period_end + 7 days`
  in both decideCapacity (TS) and workspace_capacity (SQL). Stripe advances
  the period at renewal even when the invoice fails, so a failing card keeps
  pages up ~5 weeks, not 7 days. Errs toward the customer; the fix needs a
  `past_due_since` (or period start) column set by the webhook and both
  capacity functions changed together.
- **Webhook event claim is not a lease**: a redelivery that arrives while the
  first attempt is still running reprocesses concurrently. Every handler is
  idempotent (upserts keyed by Stripe ids, grant_credits keyed by invoice,
  reactivation through the capacity gate), so the effect is duplicated work,
  not duplicated money.
- **Stripe test mode**: not runnable end to end from the app's checkout
  without owner-provided test credentials (see approval request).
- **Marketplace connection is first come, first served**: connecting needs
  only the marketplace's public Client ID, and a marketplace connects to one
  workspace. Someone else could connect a marketplace before its owner; the
  owner is told to contact support (MARKETPLACE_ALREADY_CONNECTED_ERROR).
  Pages still publish only on a DNS-verified domain, so a squatter can't
  publish on the owner's domain.
- **Legacy (v1-filter) pages** stay live as they are but can't be edited or
  republished; the editor says to archive and recreate from Opportunities.
  Production holds none for real customers (3 synthetic launch-check pages).
- **Resource Articles show no listing strip** (the builder sends a
  whole-marketplace filter); the copy says so.
- **Non-Latin names** key by their own letters; their slugs use a stable
  ASCII stand-in (`x…`) the owner can edit before publishing.
- **Legacy Quick Page / Opportunity Engine pipeline** (`runQuickPage`) has no
  plan-state check of its own; it is refused/deferred-gated today — add
  `assertMayGenerate` before re-enabling coach or the opportunity engine.
- **`/api/public/page-lookup`** (used by the smoke script) serves published
  page text without the billing check the /a/ route applies.

## Remaining blockers / owner actions

- Founder domain routing: DNS for test.poolrentalnearme.com must point at
  `proxy.founders.click` (owner's Cloudflare zone) — see MVP-6.
- Second smoke-signup runner (~4/day, `smoke*@example.com`) is outside the
  four repos in this session; emails are suppressed.

## Next exact action

1. Commit + push this round (review fixes, 000500, checklist, this doc).
2. Deploy, in order (approval of 2026-09-28 covers it): migrations 000100,
   000200, 000300, 000310, 000400, 000500 with their verification rows;
   stripe-webhook + create-checkout from source; the 410 stub under
   `coach-briefing-cron`; push `main` (deploy-app.yml); verify
   `/api/public/version` = tested SHA; sync every connected workspace
   (listing keys) and check 0 unkeyed rows.
3. Journeys A–H with evidence (Playwright screenshots of the builder, the
   three template previews, the editor); record generation time and spend.
4. One consolidated approval request (founder DNS, Stripe test mode, legacy
   function deletion, process-auth-emails secret, test accounts); handoff with
   the PASS/FAIL/BLOCKED/NOT RUN matrix and rollback.
