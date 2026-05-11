# PSEO Admin Engine — Source of Truth for Port

This bundle contains the ENTIRE working admin tool engine from the production app.
Every file here is operational and currently running in production (5,100+ live pages).

## Bundle Layout

- `src/routes/admin.*.tsx` — 43 admin tool route components (TanStack Router file-based routes)
- `src/server/admin-*.functions.ts` — Server-side functions called by the routes (Supabase queries, AI calls, etc.)
- `src/lib/admin-tech-docs.ts` + `admin-tech-flows.ts` — Internal documentation data
- `src/components/admin-layout.tsx` — The sidebar layout + nav groups (Overview / Content / SEO / Users & Ops)
- `supabase/functions/` — Edge functions (AI content generators)
- `supabase/migrations/` — Database schema (90+ migrations)

## What the Sidebar Looks Like (from admin-layout.tsx)

### Overview
- Dashboard, SEO Coach, Technical docs

### Content
- Quick page builder, Generate content (AI), Content migration, Bulk page editor,
  Blog admin, Learning admin, City heroes, Data export, Data import

### SEO
- Competitor radar, Rank tracker, AI page auditor, Listing auditor,
  Keyword opportunities, Competitor tracker, Internal link recommender,
  SEO health, Link checker, Link audit dashboard, Missing pages (404s),
  Sitemap & indexing, GSC import, Scrape import, Click report

### Users & Ops
- Lead inbox, IG lead hunter, Social lead hunter, Email branding, Email verify,
  Site footer, Directory moderation, Listing claims, Plan requests, Admin team

## Tool → Server Function Mapping

Most routes import from one of these server modules:
- `admin-tools.functions.ts` (50K — main tool functions)
- `admin-weapons.functions.ts` (39K — SEO weapons: competitors, keywords, links)
- `admin-dashboard.functions.ts` (21K — dashboard widgets)
- `admin-seo-tools.functions.ts` (20K — SEO-specific server logic)
- `admin-data-io.functions.ts` (18K — import/export)
- `admin-listing-audit.functions.ts` (12K)
- `admin-seo-coach.functions.ts` (9K — AI page critic)
- `admin-team.functions.ts` (9K)
- `admin-blog.functions.ts` (7K)
- `admin-pending-actions.functions.ts` (7K)
- `admin-quick-page.functions.ts` (6K)
- `admin-email-verify.functions.ts` (6K)
- `admin-auth.functions.ts` (1K — auth guard)

## Edge Functions (Supabase)

- `generate-content-batch/` (42K) — Bulk AI page generation (THE big one)
- `generate-advocacy/` (11K) — Host advocacy page generator
- `generate-academy-pages/` (10K) — Course/academy page generator
- `generate-course-content/` — Per-course content
- `generate-help-article/` — Help center articles
- `drive-content-generation/` — Google Drive content sync
- `seed-academy-courses/` + `seed-blog-posts/` — Seeders
