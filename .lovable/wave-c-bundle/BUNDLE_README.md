# Wave B Supplement — Missing Server Function Files

This bundle contains the server function files that were missing from the original
`pseo-admin-engine.zip`. Drop these into `src/server/` in the founders.click project.

## Why these were missing

The original bundle only included files matching the `admin-*` prefix. These files
don't have that prefix but are imported by admin routes. They are part of the same
production codebase.

## Files in this bundle (28 server files)

### Required to unblock Wave B
- `content-scrape.functions.ts` — Firecrawl scraping pipeline (used by `admin.content-migration`)
- `generate-content-batch.functions.ts` — server wrapper that triggers the edge function (used by `admin.generate-content`)
- `generate-content-stats.functions.ts` — polling stats for the content batch (used by `admin.generate-content`)

### Note for bulk-editor
`admin.content-pages.tsx` (the bulk editor) does NOT need a separate server file.
It imports everything from `admin-tools.functions.ts`, which is already in the
project. The functions it needs are:
- `listContentPages`, `bulkUpdateContentPages`, `getContentPage`, `updateContentPage`
- `appendAiContentToPage`, `generateFullPageContent`, `improvePageContent`
- `generateSeoMeta`, `generateSectionPreset`, `autoFixSeo`
- `enqueueSeoFixJobs`, `processSeoFixQueue`, `getSeoJobStatus`
- `listSectionPresets`, `saveSectionPreset`, `deleteSectionPreset`, `generateCustomSection`
- Types: `ContentPageRow`, `ContentPageFull`, `CustomSectionPreset`
- Constant: `SECTION_PRESETS`

These exports already exist in `admin-tools.functions.ts` (50KB file you already have).

### Other server files included (port these too — they unblock later waves)
- `content-pages.functions.ts` — public-facing content page reads
- `content.functions.ts` — content helpers
- `content-health.functions.ts` — used by `admin.content-health`
- `content-404-log.functions.ts` — used by `admin.missing-pages`
- `blog-enrichment.functions.ts` + `blog-posts.functions.ts` — used by `admin.blog`
- `click-report.functions.ts` — used by `admin.click-report`
- `email-branding.functions.ts` — used by `admin.email-branding`
- `internal-links.functions.ts` — used by `admin.internal-links`
- `landing-link-check.functions.ts` — used by `admin.landing-link-check`
- `ig-lead-hunter.functions.ts` + `.server.ts` — used by `admin.ig-lead-hunter` (SKIP per port plan)
- `cities-hero-backfill.functions.ts` + `.server.ts` + `cities-hero-report.functions.ts` — used by `admin.cities-heroes` (SKIP per port plan, pool-specific)
- `host-tools.functions.ts` — host-facing tools
- `builders.functions.ts` — pool builder directory (SKIP, pool-specific)
- `directory.functions.ts` — directory moderation (SKIP per port plan)
- `feature-requests.functions.ts`, `intercom.functions.ts`
- `alias-backfill.*` — redirect alias system
- `canonical.server.ts` — canonical URL helper
- `contact-enricher.server.ts` — PDL/BatchData lead enrichment
- `backfill-content-pages.server.ts` — bulk content backfill worker

## Multi-tenancy reminder

EVERY file in this bundle was written for a single-tenant production app. When
porting:
1. Add `workspace_id` filter to every Supabase query
2. Strip any CSV-supplied or user-supplied `workspace_id` values
3. Get the active workspace from session, never from input
4. Add RLS policies on any new tables: `workspace_id in (select workspace_id from memberships where user_id = auth.uid())`

The pattern Lovable used in `admin-data-io.functions.ts` is the correct template
to follow for all of these.
