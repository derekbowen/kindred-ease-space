# Wave C Bundle — SEO Suite + Dashboard + Edge Functions

This is the consolidated bundle for Wave C. Contains everything from the original
`pseo-admin-engine.zip` + `pseo-server-supplement.zip` merged into one.

## What's in here

### Server functions for Wave C (critical)
- `src/server/admin-weapons.functions.ts` (39K) — competitor radar, host matching, gap detection, AI enrichment
- `src/server/admin-seo-tools.functions.ts` (20K) — keyword ops, rank tracking, link checker, page auditor
- `src/server/admin-seo-coach.functions.ts` (9K) — AI page critic
- `src/server/admin-dashboard.functions.ts` (22K) — Morning Command Center widgets

### Supporting server files (already partially ported)
- `src/server/admin-tools.functions.ts` (50K) — core CRUD
- `src/server/admin-data-io.functions.ts` (18K) — already ported in Wave B
- `src/server/admin-blog.functions.ts`, `admin-team.functions.ts`, `admin-pending-actions.functions.ts`
- `src/server/internal-links.functions.ts`, `click-report.functions.ts`, `content-health.functions.ts`
- `src/server/content-404-log.functions.ts`, `content-scrape.functions.ts`, etc.

### Edge functions (8 total)
- `generate-content-batch/` — THE big one, completes the Generate Content tool
- `generate-advocacy/`, `generate-academy-pages/`, `generate-course-content/`
- `generate-help-article/`, `drive-content-generation/`, `seed-academy-courses/`, `seed-blog-posts/`

### Original admin routes (43 files in `src/routes/admin.*.tsx`)
Use these as the SOURCE for porting. Map each to `_authenticated/app.SECTION.X.tsx` in the
founders.click project. The 13 still-pending routes for Wave C are:
- competitor-radar, competitors, gsc-import, indexing, internal-links
- keyword-opportunities, link-audit, link-checker, page-auditor
- rank-tracker, scrape-import, seo-coach, seo-health

## CRITICAL GOTCHAS FOR WAVE C

### Gotcha 1: scrape-import and gsc-import depend on directory.functions.ts
Both routes import from `@/server/directory.functions`:
- scrape-import: `adminScrapeProviderUrl`, `adminListScrapeJobs`
- gsc-import: `adminImportGscRows`

`directory.functions.ts` is 42K and contains BOTH SEO logic (we want this) AND
marketplace directory moderation logic (we DON'T want this — it's pool-specific).

Solution: EXTRACT just those three functions into a new file
`src/server/admin-scrape-import.functions.ts` and `src/server/admin-gsc-import.functions.ts`.
Add workspaceId scoping. Skip the rest of directory.functions.ts.

### Gotcha 2: competitor-radar is the most complex tool
Imports 17+ functions from `admin-weapons.functions.ts`. Includes AI calls
(Lovable AI Gateway), Firecrawl scraping, host matching across listings.

For initial port: get the listing/CRUD parts working first (`listCompetitorSites`,
`addCompetitorSite`, `deleteCompetitorSite`, `listNewCompetitorUrls`,
`runCompetitorScan`). Defer the AI enrichment + host matching to Wave D if time-constrained.

### Gotcha 3: External API keys
These routes need these Supabase secrets configured (use shared org-level for now,
BYOK in Wave D):
- `SERPAPI_KEY` — rank-tracker, competitor-radar, keyword-opportunities
- `FIRECRAWL_API_KEY` — scrape-import, competitor-radar (URL scraping)
- `LOVABLE_AI_GATEWAY` — seo-coach, page-auditor (already configured)

### Gotcha 4: GSC import has no OAuth wired
Original imports CSV exports manually. For Wave C, keep the CSV-paste flow.
GSC OAuth integration is a Wave D feature.

### Gotcha 5: indexing.tsx is the sitemap admin
Route name is misleading — it's the sitemap inspection tool, not a separate indexer.
Map to `app.seo.sitemap.tsx`.

## Multi-tenancy rules (same as Waves A/B)
- Every Supabase query: `.eq('workspace_id', workspaceId)`
- Every server fn input: `workspaceId: workspaceIdSchema` in Zod schema
- Every handler starts: `await assertWorkspaceMember(data.workspaceId, (context as any).userId)`
- Every new table: `workspace_id uuid references workspaces(id) on delete cascade` + RLS policy

## Port order priority (highest ROI first)
1. **generate-content-batch edge function** — completes the most-wanted tool
2. **gsc-import + keyword-opportunities** — unlocks the "free SEO audit" sales motion
3. **page-auditor + seo-coach** — AI-powered, low API cost
4. **missing-pages** (already done in partial Wave C)
5. **content-health** (already done in partial Wave C)
6. **seo-health + internal-links + link-checker + link-audit** — low API cost
7. **rank-tracker** — needs SERPAPI rate limiting solid
8. **competitor-radar + competitors** — most complex, highest SERPAPI burn
9. **indexing/sitemap admin** — small wrapper
10. **scrape-import** — Firecrawl-dependent, port last
