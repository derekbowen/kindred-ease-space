-- ROLLBACK for 20260925000900_help_center_platform_fix.sql
-- Puts the platform help center back exactly as production had it on
-- 2026-09-25 before the migration: the five getting-started articles under
-- 'getting-started' again (Pool Rental Near Me's category row — it is only
-- referenced, never changed), the BYOK article published, the four
-- Sharetribe articles with their previous titles and text (verbatim below),
-- and the 'start-here' category removed. That restores the audited defect
-- (six public articles 404), so roll back only to unblock something else.
--
-- Touches ONLY rows with workspace_id IS NULL. Every statement is guarded,
-- so running it twice changes nothing more.
--
-- Not restored:
--  * updated_at on the four rewritten articles: it moves to now() again when
--    their text is restored (the search_vector trigger recomputes itself);
--  * excerpts and reading times are put back only where the migration's own
--    value is still in place (the migration changed them only from the exact
--    seeded values restored below), so a later edit is never overwritten;
--  * help_article_embeddings (the help assistant's index), which the
--    migration did not touch either;
--  * 'start-here' is kept if anything else was filed under it since.
BEGIN;

-- 1. The previous article text, verbatim (production, 2026-09-25).
WITH o(content) AS (SELECT $old$# Connecting your Sharetribe marketplace

This takes about 5 minutes.

## 1. Create Integration API credentials

Go to **Sharetribe Console -> Build -> Applications** and click *Add new*. Pick the **Integration API** scope.

## 2. Copy your client ID and secret

Sharetribe shows the client secret only once. Copy both immediately.

## 3. Paste them into founders.click

Open **Workspace Settings -> Sharetribe** and paste both values, then click *Test connection*.$old$::text)
UPDATE public.help_articles a SET content = o.content, updated_at = now()
  FROM o
 WHERE a.workspace_id IS NULL AND a.slug = 'connecting-your-sharetribe-marketplace'
   AND a.content IS DISTINCT FROM o.content;

WITH o(content) AS (SELECT $old$# Running your first sync

Once Sharetribe is connected, hit **Sync now** on the dashboard. The first sync pulls every published listing.

## What gets synced

- Listing titles, descriptions, prices
- Custom fields (mapped automatically when names match)
- Author profiles
- Photos

## How long does it take?

Most marketplaces sync in under 2 minutes. Marketplaces over 5,000 listings can take up to 15 minutes.$old$::text)
UPDATE public.help_articles a SET content = o.content, updated_at = now()
  FROM o
 WHERE a.workspace_id IS NULL AND a.slug = 'running-your-first-listing-sync'
   AND a.content IS DISTINCT FROM o.content;

WITH o(content) AS (SELECT $old$# Troubleshooting failed syncs

## Most common causes

1. **Invalid credentials** - Re-paste your client secret
2. **API rate limits** - Sharetribe limits to 60 req/min. Wait and retry.
3. **Schema mismatch** - A custom field type changed in Sharetribe

Check **Settings -> Sync history** for the error log.$old$::text)
UPDATE public.help_articles a SET content = o.content, updated_at = now()
  FROM o
 WHERE a.workspace_id IS NULL AND a.slug = 'troubleshooting-failed-syncs'
   AND a.content IS DISTINCT FROM o.content;

WITH o(title, content) AS (SELECT 'Where to find your Integration API credentials'::text, $old$# Finding your Integration API credentials

1. Log in to **Sharetribe Console**
2. Open **Build -> Applications**
3. Click *Add new application*
4. Choose **Integration API**
5. Copy the client ID and secret immediately$old$::text)
UPDATE public.help_articles a SET title = o.title, content = o.content, updated_at = now()
  FROM o
 WHERE a.workspace_id IS NULL AND a.slug = 'where-to-find-integration-api-credentials'
   AND (a.title IS DISTINCT FROM o.title OR a.content IS DISTINCT FROM o.content);

-- 2. The two excerpts the migration changed, back to their previous text
--    (20260511071212's seed values), only where the migration's text is still there.
UPDATE public.help_articles
   SET excerpt = 'Generate Integration API credentials in Sharetribe Console and paste them into founders.click.'
 WHERE workspace_id IS NULL AND slug = 'connecting-your-sharetribe-marketplace'
   AND excerpt = 'Connect with your marketplace address and the Client ID of a Marketplace API application. It is read-only and needs no secret.';
UPDATE public.help_articles
   SET excerpt = 'Step-by-step screenshots for locating your Sharetribe Integration API client ID and secret.'
 WHERE workspace_id IS NULL AND slug = 'where-to-find-integration-api-credentials'
   AND excerpt = 'Your Client ID is in Sharetribe Console under Build → Applications. A client secret is only needed for the advanced Integration API option.';

-- 2b. Reading time back to the seeded value, only where the migration's value is still there.
UPDATE public.help_articles SET reading_time_minutes = 4
 WHERE workspace_id IS NULL AND slug = 'connecting-your-sharetribe-marketplace' AND reading_time_minutes = 2;
UPDATE public.help_articles SET reading_time_minutes = 2
 WHERE workspace_id IS NULL AND slug = 'where-to-find-integration-api-credentials' AND reading_time_minutes = 1;
UPDATE public.help_articles SET reading_time_minutes = 4
 WHERE workspace_id IS NULL AND slug = 'troubleshooting-failed-syncs' AND reading_time_minutes = 1;
UPDATE public.help_articles SET reading_time_minutes = 2
 WHERE workspace_id IS NULL AND slug = 'running-your-first-listing-sync' AND reading_time_minutes = 1;

-- 3. BYOK published again, as it was ('billing', status 'published').
UPDATE public.help_articles SET status = 'published', is_published = true
 WHERE workspace_id IS NULL AND slug = 'bring-your-own-ai-key-byok'
   AND (status IS DISTINCT FROM 'published' OR is_published IS DISTINCT FROM true);

-- 4. The five articles back under 'getting-started'.
UPDATE public.help_articles SET category_slug = 'getting-started'
 WHERE workspace_id IS NULL AND slug = 'welcome-to-founders-click' AND category_slug = 'start-here';
UPDATE public.help_articles SET category_slug = 'getting-started'
 WHERE workspace_id IS NULL AND slug = 'connecting-your-sharetribe-marketplace' AND category_slug = 'start-here';
UPDATE public.help_articles SET category_slug = 'getting-started'
 WHERE workspace_id IS NULL AND slug = 'running-your-first-listing-sync' AND category_slug = 'start-here';
UPDATE public.help_articles SET category_slug = 'getting-started'
 WHERE workspace_id IS NULL AND slug = 'creating-your-first-seo-page' AND category_slug = 'start-here';
UPDATE public.help_articles SET category_slug = 'getting-started'
 WHERE workspace_id IS NULL AND slug = 'publishing-pages-and-getting-indexed' AND category_slug = 'start-here';

-- 5. The category the migration created, once nothing is filed under it.
DELETE FROM public.help_categories
 WHERE workspace_id IS NULL AND slug = 'start-here'
   AND name = 'Getting started'
   AND description = 'Connect Sharetribe, sync your listings and publish your first pages.'
   AND NOT EXISTS (SELECT 1 FROM public.help_articles WHERE category_slug = 'start-here');

COMMIT;

-- VERIFY (rolled back): expect the five under getting-started, BYOK under
-- billing as published, the old titles, and no start-here category.
SELECT slug, category_slug, status, is_published, title, left(content, 45) AS starts_with
  FROM public.help_articles
 WHERE workspace_id IS NULL
   AND slug IN ('welcome-to-founders-click', 'connecting-your-sharetribe-marketplace',
                'running-your-first-listing-sync', 'creating-your-first-seo-page',
                'publishing-pages-and-getting-indexed', 'bring-your-own-ai-key-byok',
                'troubleshooting-failed-syncs', 'where-to-find-integration-api-credentials')
 ORDER BY slug;
SELECT count(*) AS start_here_categories FROM public.help_categories WHERE slug = 'start-here';  -- expect 0
