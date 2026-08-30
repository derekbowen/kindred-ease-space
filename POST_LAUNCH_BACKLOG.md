# Post-launch backlog

Real findings that do **not** block the first paying customer. Each one says
why it is safe to defer, so the deferral is a decision rather than an omission.

Anything that blocks launch does not belong here — it goes in the launch
verdict.

---

## Content model

### Collapse `content_pages` into `tenant_pages`
Two page models exist. `tenant_pages` is canonical; `content_pages` is legacy
but still holds live rows — the public route falls back to it, the sitemap
merges both, and redirects are read from it.

*Safe to defer:* both paths work and are exercised in production. The risk is
maintenance drift, not customer breakage.

*Plan:* backfill `content_pages` rows into `tenant_pages` keyed on
`(workspace_id, slug)`, keep the redirect table separate (it is genuinely a
different concept), then delete the fallback branch in
`getPublicTenantPage` and the merge in `tenantSitemapXml`. Until then, no new
writes to `content_pages`.

### Persist the published-page contract verdict
`src/lib/seo/page-contract.ts` runs at publish time and its result is not
stored, so the dashboard cannot show "3 of your pages would fail today's
checks" without re-running everything.

*Safe to defer:* the gate blocks bad pages at the moment that matters. This is
reporting, not enforcement.

*Plan:* add `tenant_pages.contract_status` + `contract_checked_at` +
`contract_violations jsonb`, write on publish, and add a periodic re-check so
a page that degrades (its listings disappear) is surfaced.

### Legacy thin pages may still be in sitemaps
The contract gate stops *new* thin pages, but pages published before it exists
can still be `noindex` at render while appearing in the sitemap — a
conflicting signal.

*Safe to defer:* no customer has published at scale yet, so the affected set is
currently empty or tiny.

*Plan:* once the contract verdict is persisted (above), exclude pages whose
verdict is failing from `tenantSitemapXml`.

### Shard sitemaps above 50,000 URLs
`tenantSitemapXml` caps at 50,000 URLs — the per-file sitemap limit — and does
not shard or emit a sitemap index.

*Safe to defer:* the largest plan sells 5,000 pages, so the cap is 10x current
maximum reachable usage.

*Plan:* emit `/a/sitemap.xml` as an index pointing at `/a/sitemap-1.xml` … once
any workspace passes ~40,000 pages.

---

## Billing

### Downgrade leaves a workspace over its new capacity
Downgrading sets `page_limit_base` to the smaller plan, but already-published
pages are not touched. A customer on Scale with 900 published pages who moves
to Starter (100) keeps all 900 live and simply cannot publish more.

*Safe to defer:* the system is stable and nothing is destroyed — the atomic
gate stops the over-limit set from growing. It is revenue leakage, not
breakage.

*Not a code decision.* Choosing what should happen — grandfather, suspend the
newest N, or prompt the customer to choose — changes what customers are
charged, so it needs Derek. Raised in the launch verdict's blocker list.

### Reactivation restores every suspended page regardless of current plan
`reactivatePages` flips all `billing_suspended` rows back to `published`
without re-checking capacity, so a customer who was suspended at 900 pages and
returns on a 100-page plan gets all 900 back.

*Safe to defer:* same reasoning as above, and the same decision unblocks both.

### Plan catalog is mirrored in two files
`supabase/functions/_shared/stripe-catalog.ts` and `src/lib/plan-catalog.ts`
must be kept in sync by hand; both carry a comment saying so.

*Safe to defer:* a drift changes displayed pricing, which is visible fast, and
the entitlement written by the webhook comes from the Stripe-side catalog —
the authoritative one.

*Plan:* generate the app-side mirror from the shared file at build time, or add
a test asserting the two agree.

---

## Edge and operations

### `edge_health_events` has no retention policy
Throttled to roughly one row per hostname per minute, so a sustained incident
across 50 domains writes ~72k rows/day.

*Safe to defer:* only reachable during an actual outage, and the volume is
small in absolute terms.

*Plan:* a pg_cron job deleting rows older than 30 days.

### Worker deploy has no staging rehearsal
`deploy-edge-worker.yml` deploys straight to the account that fronts customer
domains. Its preflights and post-deploy checks reduce the risk but there is no
place to rehearse a change.

*Safe to defer:* deploys are manual and rare, and the route-count and
reachability assertions catch the failure modes that matter.

*Plan:* a second Worker (`founders-edge-staging`) on a test hostname, deployed
by the same workflow with an environment input.

### Opportunity engine is unvalidated against real data
Shipped behind `feature_enrollments` with no workspace enrolled. The gate fails
closed when the tables are missing, and `/app/opportunities` is not linked from
any navigation.

*Safe to defer:* it is genuinely unreachable for customers.

*Plan:* validate against a real marketplace workspace before enrolling anyone.

---

## Testing

### Billing assertions need a live database
The entitlement rules Derek asked to be proven — publish cannot exceed
entitlement, a failed publish consumes nothing, upgrade changes capacity
immediately, Stripe and application state reconcile — are integration
behaviour, not pure logic. They are specified in
`tests/billing-entitlement.test.ts` and skip loudly without credentials.

*Safe to defer running them in CI;* not safe to defer running them once. They
must pass against staging before the first paying customer.

### No end-to-end test covers the full golden path
`tests/e2e/smoke.py` covers signup through billing. Nothing yet walks domain
connection → generation → publish → serve → sitemap in one run.

*Plan:* extend the smoke test once a test domain exists at the edge.
