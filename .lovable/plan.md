# PSEO Admin Engine → founders.click — Port Plan

## Bundle inventory

- **44 route files** in `bundle/src/routes/admin.*.tsx` (you said 43; one is `admin.learning.$userId.tsx`)
- **13 server modules** in `bundle/src/server/admin-*.functions.ts` (≈220 KB total — `admin-tools` 50K, `admin-weapons` 39K, `admin-dashboard` 22K alone)
- **8 edge functions** in `bundle/supabase/functions/`
- **103 SQL migrations** in `bundle/supabase/migrations/`
- **1 layout** (`admin-layout.tsx`, 13K) and 2 lib files (`admin-tech-docs.ts`, `admin-tech-flows.ts`)

## Critical findings from inspecting the source

1. **Source code is 100% single-tenant.** `rg "workspace_id|workspaceId|getMe"` across `src/server/` and `src/routes/` returns **zero matches**. Every `.from(...)` query in 13 server modules has to be retrofitted with workspace scoping. This is the single biggest piece of work — far bigger than the file copying.
2. **Auth model differs.** Source uses `checkAdminRole()` against `user_roles.role='admin'` and a `/admin/no-access` route. This project uses workspace membership (`is_workspace_member` / `is_workspace_owner`). Port will replace the admin gate with a workspace-membership gate sourced from `getMe()`.
3. **One missing import in the bundle.** `admin.click-report.tsx` imports `getCityClickReport` from `@/server/click-report.functions` — that file is **not in the bundle**. I will reconstruct it from `city_link_clicks` (which already has `workspace_id`).
4. **`getCanonicalOrigin` / sitemap helpers** are not in the bundle. Some routes need them; I'll inline minimal versions.

## Table mapping (bundle ↔ this project's DB)

Bundle queries 35 tables. Crossing against this project's 68 tables:

**Already exist with `workspace_id` + RLS — just need filter retrofitting:**
blog_posts, competitor_host_matches, competitor_pages, competitor_sites, competitor_urls, content_pages, content_plan, courses, enrichment_spend_log, gsc_query_data, help_articles, host_match_false_positives, internal_link_suggestions, listing_sync_log, page_audits, provider_claims, provider_leads, provider_plan_requests, providers, seo_fix_jobs, serp_rankings, site_issues, synced_listings, template_quality_breakdown, tracked_keywords

**Already exist, no `workspace_id` (global / shared):** cities, profiles, user_roles, pool_waitlist

**Net-new tables this port must create (with `workspace_id` + `is_workspace_member` RLS from day 1):**
- `admin_section_presets` — used by content generator presets
- `gsc_daily_pages` — daily aggregates for GSC import (current `gsc_query_data` is per-query, not per-day-per-page)
- `host_leads` — used by lead inbox; we have `provider_leads` so I will **map references to `provider_leads`** instead of creating a new table (your "Lead inbox" already points at this)
- `listing_audits` — output of listing-auditor (Phase 5 skip — not porting)
- `missing_pages` — we already have `content_404_log` with the same shape; I will **map references to `content_404_log`** instead of creating a duplicate

Net new tables to actually create: **`admin_section_presets`** and **`gsc_daily_pages`** only.

## Route mapping (Phase 6 — porting)

Source `/admin/X` → Target `/_authenticated/app/SECTION/Y`:

### Overview (2)
- `admin.dashboard.tsx` → `app.index.tsx` (replace existing)
- `admin.tech-docs.tsx` → `app.tech-docs.tsx` (new route file; sidebar link)

### Content (6)
- `admin.quick-page.tsx` → `app.content.quick-page-builder.tsx`
- `admin.generate-content.tsx` → `app.content.generate.tsx` ★ THE BIG ONE
- `admin.content-migration.tsx` → `app.content.migration.tsx`
- `admin.content-pages.tsx` → `app.content.bulk-editor.tsx`
- `admin.data-import.tsx` → `app.content.data-import.tsx`
- `admin.data-export.tsx` → `app.content.data-export.tsx`

### SEO (17)
- `admin.competitor-radar.tsx` → `app.seo.competitor-radar.tsx`
- `admin.competitors.tsx` → `app.seo.competitor-tracker.tsx`
- `admin.keyword-opportunities.tsx` → `app.seo.keyword-opportunities.tsx`
- `admin.missing-pages.tsx` → `app.seo.missing-pages.tsx` (rewires to `content_404_log`)
- `admin.gsc-import.tsx` → `app.seo.gsc-import.tsx`
- `admin.scrape-import.tsx` → `app.seo.scrape-import.tsx`
- `admin.page-auditor.tsx` → `app.seo.page-auditor.tsx`
- `admin.seo-coach.tsx` → `app.seo.seo-coach.tsx` (new file; replaces `app.seo-coach.tsx`)
- `admin.seo-health.tsx` → `app.seo.health.tsx`
- `admin.link-checker.tsx` → `app.seo.link-checker.tsx`
- `admin.link-audit.tsx` → `app.seo.link-audit.tsx`
- `admin.internal-links.tsx` → `app.seo.internal-links.tsx`
- `admin.rank-tracker.tsx` → `app.seo.rank-tracker.tsx`
- `admin.click-report.tsx` → `app.seo.click-report.tsx` (+ reconstruct `click-report.functions.ts`)
- `admin.indexing.tsx` → `app.seo.sitemap.tsx`
- `admin.content-health.tsx` → `app.seo.content-health.tsx` (new)
- `admin.redirect-aliases.tsx` → `app.seo.redirects.tsx` (new)
- `admin.landing-link-check.tsx` → **skip** (merge into link-checker)

### Ops (2)
- `admin.leads.tsx` → `app.ops.lead-inbox.tsx` (rewires `host_leads` → `provider_leads`)
- `admin.email-verify.tsx` → `app.ops.email-verify.tsx`

**Total Phase 6: 27 routes ported.**

## Routes I will SKIP (per your Phase 5 list)

directory, claims, listing-auditor, sharetribe-prune, ig-lead-hunter, social-lead-hunter, site-footer, email-branding, cities-heroes, cities-heroes-report, learning, learning.$userId, blog, team, plan-requests, privacy-requests, no-access. Existing stubs stay; their nav entries stay marked `internalOnly` until you ask for them.

## Server modules — port + retrofit

All 13 modules copied from `bundle/src/server/admin-*.functions.ts` → `src/lib/admin-*.functions.ts` (per template's import-protection rules — `*.functions.ts` files outside `src/server/`). For each module:

1. Replace `checkAdminRole()` calls with a **`requireWorkspace()`** middleware that reads the active `workspace_id` from `getMe()` and rejects if user has no membership.
2. Add `.eq("workspace_id", workspaceId)` to every `SELECT/UPDATE/DELETE` against any table in the "already exist with workspace_id" list above.
3. Add `workspace_id: workspaceId` to every `.insert(...)` payload on those tables.
4. Leave `cities`, `profiles`, `user_roles` queries unscoped (intentionally global).
5. `admin-team.functions.ts`, `admin-listing-audit.functions.ts`, `admin-blog.functions.ts` → **skip entirely** (their routes are Phase 5).

Port targets (10 modules): `admin-auth`, `admin-dashboard`, `admin-tools`, `admin-weapons`, `admin-seo-tools`, `admin-seo-coach`, `admin-data-io`, `admin-quick-page`, `admin-pending-actions`, `admin-email-verify`. Plus reconstruct `click-report.functions.ts`.

## Edge functions — port all 8

Copy `bundle/supabase/functions/{name}/` → `supabase/functions/{name}/` verbatim. Then patch each to:
- Accept `workspace_id` in the JSON body (required).
- Verify caller's session and that they belong to that workspace (use `SUPABASE_SERVICE_ROLE_KEY` for auth check, then scope all writes by `workspace_id`).
- Insert any new rows with `workspace_id` set.

Functions: `generate-content-batch`, `generate-advocacy`, `generate-academy-pages`, `generate-course-content`, `generate-help-article`, `drive-content-generation`, `seed-academy-courses`, `seed-blog-posts`.

## Migrations

I will **NOT** copy the 103 bundle migrations wholesale — most would conflict with this project's existing schema. Instead, one new migration that creates only what's missing:

```sql
-- 20260511_admin_engine_port.sql
-- 1. admin_section_presets (new)
-- 2. gsc_daily_pages (new)
-- 3. add a few missing columns the bundle code expects on existing tables
--    (audit during port; e.g. content_pages.template_type is fine, etc.)
```

I'll only know the full ALTER list after walking each ported file. Will add as a follow-up migration before claiming a tool is wired.

## Sidebar nav update

`src/lib/app-nav.ts` rewritten to match the bundle's GROUPS exactly (Overview / Content / SEO / Users & Ops), but with `/app/...` paths and `internalOnly` flags preserved on the Phase-5 stubs.

## Execution order (waves)

Realistic scope: ~25 large React route files + 10 server modules + 8 edge functions + auth retrofit on every query. Doing it in one shot would burn a huge amount of tool calls and likely hit limits mid-way. I'll do it in **3 waves**, committing after each so nothing is left half-broken:

- **Wave A — foundation** (this loop)
  - New migration: `admin_section_presets`, `gsc_daily_pages`
  - `src/lib/admin-auth.functions.ts` with `requireWorkspace()` helper
  - `src/components/admin-layout.tsx` ported (renamed nav, workspace-aware)
  - `src/lib/app-nav.ts` rewritten
  - Port the 4 small server modules: `admin-quick-page`, `admin-pending-actions`, `admin-email-verify`, reconstruct `click-report`
  - Port 5 small routes: `quick-page-builder`, `click-report`, `email-verify`, `tech-docs`, `lead-inbox`
  - Port `admin.dashboard.tsx` → `app.index.tsx`

- **Wave B — content + data IO** (next loop)
  - `admin-tools.functions.ts`, `admin-data-io.functions.ts`
  - Routes: generate, bulk-editor, migration, data-import, data-export
  - Edge fns: `generate-content-batch`, `generate-advocacy`

- **Wave C — SEO suite + remaining edge fns** (loop after)
  - `admin-weapons`, `admin-seo-tools`, `admin-seo-coach`, `admin-dashboard`
  - Routes: all 17 SEO routes
  - Edge fns: remaining 6

After each wave: report on what's live, what's broken, what TODOs remain.

## Open questions before I start (please confirm or override)

1. **`host_leads` → `provider_leads` mapping** — OK? (Otherwise I create a separate `host_leads` table.)
2. **`missing_pages` → `content_404_log` mapping** — OK?
3. **Admin gate** — Confirm replacing `user_roles.role='admin'` check with workspace membership (any logged-in workspace member can use the admin tools for their own workspace; `is_internal=true` workspaces still see the internalOnly sidebar items).
4. **Demo mode toggle** in the bundle's sidebar — keep it? (Lets you screenshare without exposing internal tools.)

If you reply "go" without overriding, I'll proceed with all four defaults as written and start Wave A.