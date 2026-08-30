# Source of truth per customer object

One authoritative home per concept. Anything else holding the same fact is a
*projection* and must be rebuildable from the authority. Where a projection
exists, this file says how it is refreshed and what happens when it drifts.

Verified against the code on 2026-08-30 unless marked otherwise.

---

## Customer / account

| Concept | Authority | Projections |
| --- | --- | --- |
| Workspace (the customer) | `workspaces` | — |
| Membership & role | `workspace_members`, read through the `is_workspace_member` RPC | — |
| Identity / login | Supabase Auth (`auth.users`) | — |

Every server function authorizes through `is_workspace_member`, never by
trusting a workspace id from the client.

## Billing

| Concept | Authority | Projections |
| --- | --- | --- |
| Payment truth | **Stripe** | `subscriptions`, `workspaces.subscription_status`, `workspaces.current_period_end` |
| Plan catalog | `supabase/functions/_shared/stripe-catalog.ts` | `src/lib/plan-catalog.ts` (app-side mirror — keep in sync) |
| Published-page capacity | `workspaces.page_limit_base` + `page_limit_addon` + `page_limit_bonus` | `PageEntitlement.pageLimit` (computed per read) |
| Current published count | `count(*)` over `tenant_pages WHERE status='published'` | never cached |
| Webhook idempotency | `stripe_webhook_events` | — |
| Billing audit trail | `billing_events` | — |

Stripe is the only payment authority. The webhook projects it onto
`workspaces.page_limit_*`; nothing else may write those columns — client roles
have INSERT/UPDATE revoked at the table level (`20260830010000`), because RLS
row-scoping alone still permits writing any column of your own row.

**Capacity is the product.** AI credits (`credit_balances`, `credit_ledger`,
`ai_usage_log`) are internal metering only and must not resurface as the
customer-facing billing unit.

The published count is deliberately never cached. It is the number a customer
is charged against, and a stale copy is a billing error.

## Domains and routing

| Concept | Authority | Projections |
| --- | --- | --- |
| Connected domain & state | `workspace_domains` | — |
| Edge routing config | `workspace_domains`, served by `/api/public/domain-config` | Cloudflare edge cache (60s fresh / 24h stale-while-error) |
| Cloudflare hostname & route ids | `workspace_domains.cloudflare_hostname_id` / `cloudflare_route_id` | the objects themselves live in Cloudflare |
| Kill switch | `workspace_domains.founders_disabled` | edge config payload |

The control plane owns routing. Worker deploys ship code only and declare no
routes — see `edge/founders-edge/README.md`.

`status='active'` is only ever set after live HTTP checks pass over the public
internet (`activateWorkspaceDomain`). It is never inferred from a successful
API call.

## Content

| Concept | Authority | Projections |
| --- | --- | --- |
| Page (canonical model) | `tenant_pages` | — |
| Page (legacy model) | `content_pages` | — see the debt note below |
| Templates | `page_templates` | — |
| Marketplace inventory | **Sharetribe** | `tenant_listings` (synced copy) |
| Marketplace route shapes | `tenant_integrations.route_config` | URLs derived at render, never persisted as authority |
| Sitemap entries | derived at request time from `tenant_pages` + `content_pages` | not stored |
| Published-page health | derived by `src/lib/seo/page-contract.ts` at publish time | not stored — see backlog |

`tenant_listings.marketplace_url` is a **fallback**, not authority: real URLs
are rebuilt at render from `sharetribe_listing_id` through the marketplace
adapter, so a route-convention change takes effect without re-syncing.

### Known debt: two page models

`tenant_pages` is canonical. `content_pages` predates it and still holds live
rows: `getPublicTenantPage` falls back to it, the sitemap merges both, and
redirects are read from it.

This is the "no parallel customer models" rule being violated by history rather
than by choice. It is **not** a launch blocker — both paths work and are
tested — but it needs a migration plan, tracked in `POST_LAUNCH_BACKLOG.md`.
No new writes should target `content_pages`.

## Opportunity engine

| Concept | Authority |
| --- | --- |
| Site crawl results | `site_scans`, `site_scan_pages` |
| Inventory rollups | `inventory_aggregates` |
| Opportunities & decisions | `seo_opportunities`, `opportunity_evidence` |
| Feature rollout | `feature_enrollments` (workspace-scoped, no global flag) |

Decision history is preserved from day one: an opportunity's verdict and the
evidence behind it are stored, not recomputed, so a customer can be told why a
page was or was not recommended.

---

## Rules

1. A projection must be rebuildable from its authority. If it cannot be
   rebuilt, it is a second authority and does not belong here.
2. One business rule has one representation. `listing_filter` is not copied
   into a page spec; the page spec references it.
3. Never introduce a `_v2` table for a concept already listed above without
   adding the migration plan to `POST_LAUNCH_BACKLOG.md` first.
4. Anything a customer is billed against is computed live, never cached.
