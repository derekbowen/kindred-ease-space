-- ============================================================================
-- MVP HELP COPY: THE HELP CENTER DESCRIBES THE MVP, NOTHING MORE
-- (owner brief 2026-09-28).
--
-- Runs after 20260925000900 and 20260925000910 (it rewrites text they wrote).
-- What production's platform articles say that the MVP does not do:
--  * welcome-to-founders-click: "hundreds of SEO landing pages in days, not
--    months", "in under 5 minutes", "Track everything in Google Search
--    Console", and "get value in your first hour" (excerpt). Rewritten to the
--    MVP journey: Sharetribe → sync → opportunities → template → draft →
--    edit and preview → publish on your domain → sitemap.
--  * connecting-your-sharetribe-marketplace: "This takes about five minutes."
--  * running-your-first-listing-sync: "syncs in seconds".
--  * connecting-google-search-console: its title and excerpt read as a
--    founders.click integration; founders.click imports no Search Console
--    data (the GSC import is deferred). Retitled; it says so.
--  * publishing-pages-and-getting-indexed (excerpt): "ping Google" — nothing
--    pings Google.
--  * creating-your-first-seo-page: "Content → Quick Page Builder → Generate &
--    publish", a flow that is no longer in the sidebar. Rewritten to
--    Opportunities → template → draft → publish.
--  * Sidebar names that changed with the MVP sidebar (src/lib/app-nav.ts):
--    "Sharetribe" is now "Sharetribe & inventory", "Workspace Settings" is
--    "Settings", Billing is a Settings tab.
--
-- Touches ONLY rows with workspace_id IS NULL (the public founders.click help
-- center); no Pool Rental Near Me row is inserted, updated or deleted, and
-- no article is deleted or unpublished. Every change applies only
-- while the row still holds the exact text it replaces — a whole article
-- (content = …) or one exact sentence (strpos(content, …) > 0, then
-- replace()) — so an article someone has since edited in the admin UI is left
-- alone, and a second run changes nothing. "N min read" follows a rewritten
-- article (the admin editor's formula, words / 200, at least 1), only from
-- its seeded value.
-- Rollback: supabase/rollback/20260929000310_mvp_help_copy_rollback.sql
-- ============================================================================

-- 1. welcome-to-founders-click: the MVP journey, in place of the speed and
--    Search Console claims.
UPDATE public.help_articles
   SET content = $new$founders.click turns the published listings on your Sharetribe marketplace into SEO landing pages on your own domain.

## How it works

1. **Connect Sharetribe.** Use the Client ID of a Marketplace API application. The connection is read-only.
2. **Sync your listings.** Your published listings are imported, then refreshed automatically about every 30 minutes.
3. **Pick an opportunity.** **Opportunities** shows the city and category pages your listings can support.
4. **Create a draft.** Choose one of the three page templates. founders.click writes a draft from your real listings, and you edit and preview it before anything goes live.
5. **Publish on your domain.** Connect and verify your domain, then publish. The page goes live on your domain and is added to your sitemap automatically.

## Next steps

- [Connecting your Sharetribe marketplace](/help/start-here/connecting-your-sharetribe-marketplace)
- [Running your first listing sync](/help/start-here/running-your-first-listing-sync)
- [Creating your first SEO page](/help/start-here/creating-your-first-seo-page)
- [Submitting your sitemap](/help/seo-growth/submitting-your-sitemap)$new$,
       reading_time_minutes = CASE WHEN reading_time_minutes = 3 THEN 1 ELSE reading_time_minutes END,
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'welcome-to-founders-click'
   AND content = $old$# Welcome to founders.click

founders.click helps Sharetribe marketplace operators ship hundreds of SEO landing pages in days, not months.

## What you can do

- Connect your Sharetribe marketplace in under 5 minutes
- Sync your live listings automatically
- Generate SEO pages from templates with AI-assisted content
- Track everything in Google Search Console

## Next steps

1. Connect Sharetribe
2. Run your first sync
3. Create your first page
4. Publish and submit your sitemap$old$;

UPDATE public.help_articles
   SET excerpt = 'What founders.click does, from connecting Sharetribe to publishing your first page on your own domain.',
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'welcome-to-founders-click'
   AND excerpt = 'A quick tour of what founders.click does and how to get value in your first hour.';

-- 2. connecting-your-sharetribe-marketplace: no time promise.
UPDATE public.help_articles
   SET content = replace(content, $old$This takes about five minutes. Only the workspace owner can connect a marketplace.$old$, $new$Only the workspace owner can connect a marketplace.$new$),
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'connecting-your-sharetribe-marketplace'
   AND strpos(content, $old$This takes about five minutes. Only the workspace owner can connect a marketplace.$old$) > 0;

-- 3. connecting-your-sharetribe-marketplace: the sidebar's names.
UPDATE public.help_articles
   SET content = replace(content, $old$Open **Sharetribe** in the sidebar (it is also under **Workspace Settings → Sharetribe**).$old$, $new$Open **Sharetribe & inventory** in the sidebar (it is also under **Settings → Sharetribe**).$new$),
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'connecting-your-sharetribe-marketplace'
   AND strpos(content, $old$Open **Sharetribe** in the sidebar (it is also under **Workspace Settings → Sharetribe**).$old$) > 0;

-- 4. running-your-first-listing-sync: the sidebar's names.
UPDATE public.help_articles
   SET content = replace(content, $old$open **Sharetribe** in the sidebar (or **Workspace Settings → Sharetribe**)$old$, $new$open **Sharetribe & inventory** in the sidebar (or **Settings → Sharetribe**)$new$),
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'running-your-first-listing-sync'
   AND strpos(content, $old$open **Sharetribe** in the sidebar (or **Workspace Settings → Sharetribe**)$old$) > 0;

-- 5. running-your-first-listing-sync: no speed promise.
UPDATE public.help_articles
   SET content = replace(content, $old$A marketplace with a hundred or so listings syncs in seconds. Larger catalogues take longer, because listings are read from Sharetribe 100 at a time.$old$, $new$It depends on the size of your catalogue: listings are read from Sharetribe 100 at a time, so a larger marketplace takes longer. The **Sharetribe & inventory** page shows when the last sync finished and how many listings it imported.$new$),
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'running-your-first-listing-sync'
   AND strpos(content, $old$A marketplace with a hundred or so listings syncs in seconds. Larger catalogues take longer, because listings are read from Sharetribe 100 at a time.$old$) > 0;

-- 6. troubleshooting-failed-syncs: the sidebar's names.
UPDATE public.help_articles
   SET content = replace(content, $old$open **Sharetribe** in the sidebar, or **Workspace Settings → Sharetribe**.$old$, $new$open **Sharetribe & inventory** in the sidebar, or **Settings → Sharetribe**.$new$),
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'troubleshooting-failed-syncs'
   AND strpos(content, $old$open **Sharetribe** in the sidebar, or **Workspace Settings → Sharetribe**.$old$) > 0;

-- 7. submitting-your-sitemap: the sidebar's names.
UPDATE public.help_articles
   SET content = replace(content, $old$The exact link is shown under **Workspace Settings → Domains**.$old$, $new$The exact link is shown under **Settings → Domains**.$new$),
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'submitting-your-sitemap'
   AND strpos(content, $old$The exact link is shown under **Workspace Settings → Domains**.$old$) > 0;

-- 8. understanding-page-limits: the sidebar's names.
UPDATE public.help_articles
   SET content = replace(content, $old$under **Billing & Plans**.$old$, $new$under **Settings → Billing**.$new$),
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'understanding-page-limits'
   AND strpos(content, $old$under **Billing & Plans**.$old$) > 0;

-- 9. creating-your-first-seo-page: the MVP flow, in place of the Quick Page
--    Builder's (20260925000910's text).
UPDATE public.help_articles
   SET content = $new$1. Open **Opportunities**. It lists the city and category pages your synced listings can support.
2. Pick one, or start from **Page Builder**, and choose one of the three page templates.
3. founders.click writes a **draft** from your real listings. A draft is never live: edit it and preview it as it will appear on your domain.
4. When it looks right, **publish** it. The page goes live on your verified domain and is added to your sitemap automatically.

Published pages are served on your own domain, so connect and verify it first under **Settings → Domains**. Publishing also needs room in your plan; drafts never count against it. Every draft and published page is listed under **My Pages**.$new$,
       reading_time_minutes = CASE WHEN reading_time_minutes = 3 THEN 1 ELSE reading_time_minutes END,
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'creating-your-first-seo-page'
   AND content = $old$# Creating your first SEO page

1. Open **Content → Quick Page Builder**.
2. Pick one of the suggested cities — they come from your synced listings — or type your own.
3. Check the page title and the brief, then click **Generate & publish**.

The page is written from your live listings. If it passes the pre-publish checks and your plan has room, it goes live straight away; otherwise it is saved as a draft and the builder tells you what to fix. You can edit any page later under **Pages**.$old$;

-- 10. connecting-google-search-console: the customer's own Search Console,
--    said plainly (slug kept, so the URL does not change).
UPDATE public.help_articles
   SET title = 'Adding your domain to Google Search Console',
       excerpt = CASE WHEN excerpt = 'Verify your domain in GSC so you can see impressions, clicks, and indexing status.' THEN 'Verify your domain in your own Google Search Console account to see its impressions, clicks and indexing status there.' ELSE excerpt END,
       content = $new$founders.click doesn't connect to Google Search Console or import its data. You use Search Console directly, in your own Google account, to see how Google finds and indexes the pages you publish.

1. Open Google Search Console.
2. Add your custom domain as a *Domain property*.
3. Add the TXT record Search Console gives you to your DNS.
4. Wait for Google to verify it; this can take up to a day.

Then submit your sitemap: see [Submitting your sitemap](/help/seo-growth/submitting-your-sitemap).$new$,
       reading_time_minutes = CASE WHEN reading_time_minutes = 3 THEN 1 ELSE reading_time_minutes END,
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'connecting-google-search-console'
   AND title = 'Connecting Google Search Console'
   AND content = $old$# Connecting Google Search Console

1. Open Google Search Console
2. Add your custom domain as a *Domain property*
3. Add the TXT record GSC gives you to your DNS
4. Wait up to 24 hours for verification$old$;

-- 11. publishing-pages-and-getting-indexed: nothing pings Google.
UPDATE public.help_articles
   SET excerpt = 'Publish on your verified domain, submit your sitemap, and help Google find your pages.',
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'publishing-pages-and-getting-indexed'
   AND excerpt = 'Publish, ping Google, and watch your pages enter the index.';

-- ---------------------------------------------------------------------------
-- VERIFY: every row should say true.
-- ---------------------------------------------------------------------------
WITH a AS (
  SELECT slug, title, excerpt, content FROM public.help_articles WHERE workspace_id IS NULL
)
SELECT 'welcome-to-founders-click: no speed promise, no Search Console tracking' AS check,
       NOT EXISTS (SELECT 1 FROM a WHERE slug = 'welcome-to-founders-click'
                     AND (content LIKE '%in days, not months%' OR content LIKE '%under 5 minutes%'
                          OR content LIKE '%Track everything in Google Search Console%'
                          OR excerpt LIKE '%in your first hour%')) AS ok
UNION ALL SELECT 'connecting-your-sharetribe-marketplace: no "about five minutes", the sidebar''s names',
       NOT EXISTS (SELECT 1 FROM a WHERE slug = 'connecting-your-sharetribe-marketplace'
                     AND (content LIKE '%about five minutes%' OR content LIKE '%Workspace Settings →%'
                          OR content LIKE '%**Sharetribe** in the sidebar%'))
UNION ALL SELECT 'running-your-first-listing-sync: no "syncs in seconds", the sidebar''s names',
       NOT EXISTS (SELECT 1 FROM a WHERE slug = 'running-your-first-listing-sync'
                     AND (content LIKE '%syncs in seconds%' OR content LIKE '%Workspace Settings →%'
                          OR content LIKE '%**Sharetribe** in the sidebar%'))
UNION ALL SELECT 'troubleshooting-failed-syncs: the sidebar''s names',
       NOT EXISTS (SELECT 1 FROM a WHERE slug = 'troubleshooting-failed-syncs'
                     AND (content LIKE '%Workspace Settings →%' OR content LIKE '%**Sharetribe** in the sidebar%'))
UNION ALL SELECT 'submitting-your-sitemap: the sidebar''s names',
       NOT EXISTS (SELECT 1 FROM a WHERE slug = 'submitting-your-sitemap' AND content LIKE '%Workspace Settings →%')
UNION ALL SELECT 'understanding-page-limits: the sidebar''s names',
       NOT EXISTS (SELECT 1 FROM a WHERE slug = 'understanding-page-limits' AND content LIKE '%**Billing & Plans**%')
UNION ALL SELECT 'creating-your-first-seo-page: the MVP flow, not the Quick Page Builder',
       NOT EXISTS (SELECT 1 FROM a WHERE slug = 'creating-your-first-seo-page'
                     AND (content LIKE '%Quick Page Builder%' OR content LIKE '%Generate & publish%'))
UNION ALL SELECT 'connecting-google-search-console: no longer reads as a founders.click integration',
       NOT EXISTS (SELECT 1 FROM a WHERE slug = 'connecting-google-search-console'
                     AND title = 'Connecting Google Search Console')
UNION ALL SELECT 'publishing-pages-and-getting-indexed: no "ping Google"',
       NOT EXISTS (SELECT 1 FROM a WHERE slug = 'publishing-pages-and-getting-indexed' AND excerpt LIKE '%ping Google%');
