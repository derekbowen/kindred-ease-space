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
| Production app | **`55b5728`** (`/api/public/version`, built 2026-09-29T14:04:47Z), Worker version `c55a8631-b8b7-4dad-bc17-f63eaab2a08b`, deploy-app.yml run 36579746343 (typecheck, 78 test suites, build, deploy, smoke 10 pass / 0 fail / 1 SKIPPED = the public /a/ page, not run). Same SHA passed locally: full chain 78/78, tsc, build, test:pg 47 + 46 |
| Previous app (rollback) | `8ff1c41`, Worker version `42e50f5a-43bc-4ae2-ac87-f3f41111179d` — compatible with every MVP migration (they are additive; it writes pages on the service role only) |
| Launch branch | `claude/repost-assembly-j3l3qg` @ `4306712` = the release SHA + docs + the acceptance-round fixes, NOT deployed: `99d27af` + `6cd7ede` (edge reaches the app through a service binding, fails closed without it; app probes use the front door; HSTS follows the forwarded host) and `7ad7a5a` + `4306712` (create-checkout can run as allowlisted `create-checkout-test`; runbook). Full chain 79 suites / 5,916 passed, tsc + build clean |
| Edge Worker (live) | `founders-edge` hand-deployed 2026-08-30 (Cloudflare `modified_on`), OLDER than the repo: no FOUNDERS_APP binding, no kill switch, no stale-config fallback. `deploy-edge-worker.yml` has never run |
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
| 2026-09-29 | Gate review of the fix commit: CLEAN (no HIGH/CRITICAL; the HIGH verified closed); its cheap MEDIUMs fixed (one-click retry after a lost Rewrite, future-dated claims, memo size cap) | 9bffaf8 |
| 2026-09-29 | DEPLOYED: migrations 000100, 000200, 000300, 000310, 000400, 000500 (every verification row true); stripe-webhook v40, create-checkout v42, coach-briefing-cron v25 (410 stub); main → 9bffaf8 then 55b5728 (editor copy found in the live journey) | runs 36573906960, 36579746343 |
| 2026-09-29 | LIVE EVIDENCE on 55b5728 / 9bffaf8: normal account journey 22/22 (MVP nav, deferred screens redirect, three templates survive reload, phone width, a real draft in 11.2 s, publish refused with the exact domain step); edit + double click + refresh-mid-run 6/6 (one draft and one settled charge each); security probes 19/19 + checkout refusals; founder inventory synced by the new code (63/63, 0 removed, 0 unkeyed) | scratchpad launch/runs/mvp-9bffaf8, mvp-55b5728 |
| 2026-09-29 | Generation: gpt-5-nano (Standard), 7.8–10.0 s provider time, 332–397 µ$ each, 3 live generations = 1,061 µ$ (~$0.001), trial free quota 17 → 14 | ai_spend_reservations |
| 2026-09-29 | ACCEPTANCE ROUND (scope frozen). pages.poolrentalnearme.com checked unused: NXDOMAIN (A/AAAA/CNAME/TXT), no certificate in CT logs, no workspace_domains row, domain-config `domain_not_found`. poolrentalnearme.com and founders.click share the Cloudflare nameservers anna/max (likely one account) → the CNAME must be DNS-only | DoH (dns.google), crt.sh, SQL |
| 2026-09-29 | BLOCKER FOUND for public delivery: both Workers run on the founders.click zone and the app is on a route, so the edge's global fetch() to www.founders.click never reaches the app — Cloudflare sends same-zone Worker subrequests to the zone origin (the pre-cutover Lovable host, which still serves an old build against the production DB). Evidence: Cloudflare docs; the in-app canonical audit recorded identical link counts every day 09-25…09-29 across several releases, while the live Worker serves more links. Fixed on the branch: FOUNDERS_APP service binding (edge), global_fetch_strictly_public (app probes), fail-closed without the binding, post-deploy binding check, HSTS by forwarded host | 99d27af, 6cd7ede; gate review of 99d27af CLEAN (its MEDIUMs fixed in 6cd7ede) |
| 2026-09-29 | Stripe test-mode checkout prepared: the same source deploys as `create-checkout-test` (test key, STRIPE_TEST_WORKSPACE_IDS allowlist, refuses non-test keys); runbook gains the full lifecycle with public serving/sitemap checks on a test clock | 7ad7a5a, 4306712; gate review CLEAN |
| 2026-10-01 | Founder state re-read (read-only): internal grant active (page_limit 1,000,000), workspace_is_internal_unlimited true, 63 published listings, Sharetribe sync success 2026-10-01 08:00:05Z, 0 pages, 1 domain row (test.* ssl_pending). Qualifying real targets: City Hub "New York" (country/region empty as recorded, 3 listings: 2 experiences + 1 pool); Category Page "pool" (17), "experiences" (20) | SQL |
| 2026-10-01 | Gate review of 6cd7ede: CLEAN (no HIGH/CRITICAL). Its cheap MEDIUMs fixed: the edge workflow runs the edge tests (which pin the binding) BEFORE uploading; a failed config lookup is logged; README states the fail-closed scope (without the binding a host serves its own site only from cached config, ≤24 h, then 404s) | 5a47fad |

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

## Acceptance matrix (scope frozen 2026-09-29; as of 2026-10-01)

A unit test never counts as browser, payment or public-delivery evidence.

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Founder browser: workspace, internal-unlimited, inventory, opportunities, draft creation | **BLOCKED** (needs your own signed-in Google session; I have none and will not reset or create logins) | Data side re-read live 2026-10-01: grant active, internal-unlimited true, 63 listings, sync success 08:00Z. Browser prompt ready: scratchpad `launch/founder-mvp-check.md` |
| 2 | City Hub + Category Page previews on real listings; template/filter/inventory/saved page agree | **BLOCKED** (same session) | Targets qualify on live data: City Hub New York = 3 listings, Category Page pool = 17. After your run I check both saved rows' template, filter and target against SQL. Resource Article already proven live (journey 22/22, edit/double-click/refresh 6/6) |
| 3 | pages.poolrentalnearme.com: unused check, exact DNS + ownership steps | **PASS** (prepared) — DNS change **awaiting approval** | NXDOMAIN on A/AAAA/CNAME/TXT; no certificate ever issued (crt.sh); no workspace_domains row; domain-config 404 `domain_not_found`. Records below |
| 4 | Public delivery (HTML, styling, canonical, listing links, sitemap, edit propagation, unpublish) | **NOT RUN** — and a **FAIL in the live routing path was found and fixed on the branch** | The live edge cannot reach the app (same-zone Worker routing); fix 99d27af + 6cd7ede, needs the edge deploy + app deploy below, then DNS |
| 5 | Ordinary account connect → sync on a separate Sharetribe environment | **BLOCKED** on one input: that environment's Marketplace API Client ID (public, not a secret) | Connect needs only the Client ID (Marketplace API mode); uniqueness is per marketplace id, so the founder's connection is untouched |
| 6 | Stripe: checkout, webhook delivery/replay, paid access, cancellation, period expiry, reactivation, public serving + sitemap | **BLOCKED** (approval + test credentials) | Test-mode checkout made possible on the branch (7ad7a5a, 4306712; gate review CLEAN); runbook docs/STRIPE_TEST_MODE.md |

## Exact DNS + ownership steps for pages.poolrentalnearme.com (do nothing until approved)

Zone poolrentalnearme.com is on Cloudflare DNS. test.poolrentalnearme.com is NOT touched.

1. Founders, signed in as the founder: Settings → Domains → mode **Subdomain** → hostname
   `pages.poolrentalnearme.com` → Add. The page then shows the ownership token (owners only).
2. Cloudflare DNS for poolrentalnearme.com — ownership record:
   `Type TXT · Name _founders-click.pages · Content <the token from step 1> · TTL Auto`
3. Founders → Settings → Domains → **Check now** (also auto-checks every ~25 s). On success the app
   creates the Cloudflare custom hostname + Worker route and shows the routing record.
4. Cloudflare DNS — routing record:
   `Type CNAME · Name pages · Target proxy.founders.click · Proxy status DNS only (grey cloud) · TTL Auto`
   DNS only matters: both zones look like one Cloudflare account, where a proxied (orange) record
   would be served by the poolrentalnearme.com zone and never reach the Founders edge.
5. The certificate is issued automatically over HTTP once the CNAME resolves (no CAA records exist
   on poolrentalnearme.com, so nothing blocks the CA). Then Settings → Domains → **Test connection**
   → status active. The TXT record can stay (harmless) or be removed after activation.

## One consolidated approval request

1. **Edge deploy:** dispatch `Deploy Edge Worker` (confirm `deploy`) from the launch branch at `5a47fad`
   (it runs the edge tests first). Brings the
   binding, fail-closed, kill switch and stale-config fallback; verifies routes and the binding.
   No customer domain is active, so no live traffic changes.
2. **App deploy, after 1:** merge the launch branch up to `6cd7ede` into `main` (auto-deploys the Worker):
   global_fetch_strictly_public + HSTS by forwarded host.
3. **DNS:** the two records above for pages.poolrentalnearme.com (you add them; I can't edit your DNS).
4. **Publish one page there:** the Category Page "pool" (17 listings) from the founder run; I verify
   it end to end and then ask whether it stays published.
5. **Stripe test mode:** deploy `stripe-webhook-test` and `create-checkout-test` (and `create-checkout`
   from the same commit; live behaviour unchanged), a second hostname
   `billing-proof.poolrentalnearme.com` for the throwaway workspace (same two records, created from
   that workspace's Settings → Domains) and publishing one of its existing Resource Article drafts
   there for the lifecycle proof, then full cleanup per the runbook.

## Owner inputs (never through chat or files except the public Client ID)

- Stripe **test-mode** key (`sk_test_…` or a restricted `rk_test_…`): Supabase Dashboard → Edge
  Functions → Secrets → `STRIPE_SECRET_KEY_TEST`; and the same key in this cloud environment's
  settings (session title bar → environment → Edit) as `STRIPE_TEST_SECRET_KEY`, so the test
  clock, cancellation and replay can be driven (a new session picks it up).
- Stripe test-mode webhook endpoint `https://xbxhzinnfhosoztqaaao.supabase.co/functions/v1/stripe-webhook-test`
  (events in docs/STRIPE_TEST_MODE.md) → its signing secret into `STRIPE_WEBHOOK_SECRET_TEST`.
- `STRIPE_TEST_WORKSPACE_IDS` = `f02d1aa9-4e72-40fc-859f-dfecbba34a87` (the approved test workspace).
- The Marketplace API **Client ID** of a separate Sharetribe environment (e.g. your marketplace's
  Test or Dev environment) with a few published listings — public, fine to paste.
- Your founder browser run: `launch/founder-mvp-check.md` in Claude in Chrome.

## Found, not fixed (owner decisions; not launch gates)

- **Stale pre-cutover origin behind www:** the founders.click zone's DNS record for www still points
  at the Lovable host, which serves an old build against the production database. Nothing external
  reaches it today (the Worker route answers every public request), but anything that bypasses the
  route would: same-zone subrequests (fixed above) and a Workers route set to fail open. Retiring it
  is a DNS change on founders.click — owner decision.
- Carried over (need approval, not launch gates): the five retired functions stay deployed as
  410 stubs (permanent deletion optional); the inactive `process-auth-emails` cron job embeds a
  plaintext Supabase secret key in its command — drop the job and rotate that key; the 3 synthetic
  launch-check pages in the approved test workspace can be deleted.
- LOW (parity with the webhook, deferred): mode helpers duplicated between create-checkout and the
  webhook; dot-segment path steering applies to both `-test` deployments equally — deploy `-test`
  from the same commit as live and delete it after each proof.

## Next exact action

1. On approval: edge deploy → app deploy (main) → verify `/api/public/version`, the binding, and that
   nothing customer-facing changed. Then the DNS steps; then Test connection → active.
2. Publish the approved page; verify HTML/styling/canonical/listing links/sitemap/edit/unpublish on
   the public host; ask whether it stays.
3. Founder browser run (`founder-mvp-check.md`) → verify the two saved drafts against SQL.
4. With the Client ID: connect + sync as the normal account (browser) → coverage on its data.
5. With Stripe inputs: the lifecycle in docs/STRIPE_TEST_MODE.md, public serving and sitemap at each step.
