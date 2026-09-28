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
| Production app | `8ff1c41` (`/api/public/version`, built 2026-09-28T21:06Z), Worker version `42e50f5a-43bc-4ae2-ac87-f3f41111179d` |
| Previous app (rollback) | `123534f`, Worker version `dbb4b72c-532f-4d2a-b307-9e612df6aa58` |
| Launch branch | `claude/repost-assembly-j3l3qg` @ `51e9541` (8ff1c41 + data-import hotfix a76eed0, 51e9541 — reviewed clean, not yet deployed) |
| Migrations in prod | 000100–000930 applied 2026-09-28 (ledger versions 20260928194935…20260928204541); every launch object present (generation_jobs/items/reservations, ai_spend_reservations, ai_platform_settings, reserve_generation_slot, ai_reserve, workspace_is_internal_unlimited, auth_mode). Opportunity Engine tables (20260830000000) absent — not a dependency. |
| Edge functions | stripe-webhook v39, coach-briefing-cron v24, create-checkout v41 (this release). Legacy Founders-only AI endpoints still deployed: ai-proxy v22, coach-chat v25, help-assistant-chat v26 (verify_jwt **false**), help-assistant-embed v26 — no callers in code, no invocations in 24 h. |
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

## Remaining blockers / owner actions

- Founder domain routing: DNS for test.poolrentalnearme.com must point at
  `proxy.founders.click` (owner's Cloudflare zone) — see MVP-6.
- Second smoke-signup runner (~4/day, `smoke*@example.com`) is outside the
  four repos in this session; emails are suppressed.

## Next exact action

The six area maps are done (findings summarized in the design section and the
task list). Implement in parallel on top of the spine commit:
W1 surface/deferral, W2 sync, W3 sitemap + public delivery, W4 templates +
renderers; lead: coverage service + Opportunities, generation (grounding,
claim-first drafts, seo_title), builder/editor/publish, billing reconciliation.
Then merge, full validation, test:pg, deploy, journeys A–H.
