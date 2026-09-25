-- ============================================================================
-- HELP CENTER: GIVE THE ORPHANED PLATFORM ARTICLES A HOME, RETIRE BYOK, AND
-- MAKE THE SHARETRIBE ARTICLES DESCRIBE THE LAUNCH CONNECT FLOW.
--
-- Facts (production, read-only, 2026-09-25):
--  * help_categories.slug and help_articles.slug are globally UNIQUE, and
--    help_articles.category_slug references help_categories(slug).
--  * The platform (public founders.click) help center is the rows with
--    workspace_id IS NULL: categories account-billing, page-builder,
--    seo-growth, sharetribe-integration.
--  * "getting-started" and "billing" are Pool Rental Near Me's categories
--    (workspace_id NOT NULL). The seed in 20260511071212 tried to create a
--    platform "getting-started" with ON CONFLICT (slug) DO NOTHING, so its
--    five platform articles were attached to PRNM's category, and the BYOK
--    article (20260511095806) to PRNM's "billing". The public help center
--    only reads platform categories, so all six 404.
--
-- What this does, touching ONLY rows with workspace_id IS NULL:
--  1. creates the platform category 'start-here' ("Getting started"),
--     published, ordered before every other platform category;
--  2. moves the five getting-started platform articles into it;
--  3. unpublishes the BYOK article (OpenRouter/Gemini/credits; bring-your-own
--     -key is not a launch feature): status 'draft', is_published false —
--     what the admin editor writes for a draft (adminUpsertArticle);
--  4. rewrites four Sharetribe articles to the launch flow
--     (src/routes/_authenticated/app.settings.integrations.sharetribe.tsx,
--     src/lib/sharetribe-sync.*): Marketplace URL + Client ID of a
--     Marketplace API application, read-only, no secret, Integration API
--     only as the advanced option, sync every ~30 minutes. Two excerpts that
--     described the old flow, and the seeded "min read" values, follow the
--     new text — each only from its exact seeded value, so the rollback can
--     restore it exactly.
-- No Pool Rental Near Me row is inserted, updated or deleted.
--
-- Idempotent: every statement is guarded (NOT EXISTS / IS DISTINCT FROM /
-- the old value), so a second run changes nothing. Rollback:
-- supabase/rollback/20260925000900_help_center_platform_fix_rollback.sql
-- ============================================================================

-- 0. Refuse to run against an unexpected state rather than guess. A
--    'start-here' category owned by a workspace would make step 2 attach
--    platform articles to a tenant's category again.
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.help_categories
     WHERE slug = 'start-here' AND workspace_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'help_categories.start-here belongs to a workspace; not reusing it for the platform help center';
  END IF;
END
$guard$;

-- 1. The platform "Getting started" category, first in order. sort_order is
--    0, or one below the lowest platform category if that is already 0.
INSERT INTO public.help_categories (slug, name, description, icon, sort_order, is_published, workspace_id)
SELECT 'start-here',
       'Getting started',
       'Connect Sharetribe, sync your listings and publish your first pages.',
       'Rocket',
       LEAST(0, COALESCE((SELECT min(c.sort_order) FROM public.help_categories c WHERE c.workspace_id IS NULL), 1) - 1),
       true,
       NULL
 WHERE NOT EXISTS (SELECT 1 FROM public.help_categories WHERE slug = 'start-here');

-- 2. The five platform articles out of PRNM's "getting-started".
UPDATE public.help_articles SET category_slug = 'start-here'
 WHERE workspace_id IS NULL AND slug = 'welcome-to-founders-click' AND category_slug = 'getting-started';
UPDATE public.help_articles SET category_slug = 'start-here'
 WHERE workspace_id IS NULL AND slug = 'connecting-your-sharetribe-marketplace' AND category_slug = 'getting-started';
UPDATE public.help_articles SET category_slug = 'start-here'
 WHERE workspace_id IS NULL AND slug = 'running-your-first-listing-sync' AND category_slug = 'getting-started';
UPDATE public.help_articles SET category_slug = 'start-here'
 WHERE workspace_id IS NULL AND slug = 'creating-your-first-seo-page' AND category_slug = 'getting-started';
UPDATE public.help_articles SET category_slug = 'start-here'
 WHERE workspace_id IS NULL AND slug = 'publishing-pages-and-getting-indexed' AND category_slug = 'getting-started';

-- 3. BYOK: unpublished, as a draft. Category, content and published_at stay.
UPDATE public.help_articles SET status = 'draft', is_published = false
 WHERE workspace_id IS NULL AND slug = 'bring-your-own-ai-key-byok'
   AND (status IS DISTINCT FROM 'draft' OR is_published IS DISTINCT FROM false);

-- 4. The launch connect flow, in four articles. The page renders the title as
--    its <h1>, so the markdown does not repeat it. updated_at moves only when
--    the text actually changes.

-- 4a. Connecting your Sharetribe marketplace
WITH n(content) AS (SELECT $md$This takes about five minutes. Only the workspace owner can connect a marketplace.

## 1. Copy a Client ID from Sharetribe

In **Sharetribe Console**, open **Build → Applications** and create an application. Any name works, for example *founders.click*. Copy its **Client ID**.

This is a Marketplace API application. founders.click uses it read-only: it can read the published listings your marketplace already shows visitors, and it cannot change anything in your marketplace. You don't need the application's client secret.

## 2. Connect it in founders.click

Open **Sharetribe** in the sidebar (it is also under **Workspace Settings → Sharetribe**). Keep **Marketplace API** selected and fill in:

- **Marketplace URL**: the address visitors use to browse your marketplace, for example `https://your-marketplace.com`. It is used to link back to each listing.
- **Client ID**: the one you copied.

Click **Validate & Connect**. founders.click checks the Client ID with Sharetribe and looks up your marketplace's ID and name itself, so there is nothing else to enter. When it works, you see *Connected to* followed by your marketplace's name.

## 3. Run your first sync

Click **Sync now** on the same page to import your published listings. After that, listings refresh automatically about every 30 minutes. See [Running your first listing sync](/help/start-here/running-your-first-listing-sync).

## Advanced: Integration API

Choose **Integration API** only if you need it. It needs the **Client ID** and **Client Secret** of an Integration API application, and that secret gives full read and write access to your marketplace. founders.click stores the secret encrypted, never shows it back to you, and deletes it when you disconnect.

## Good to know

- A marketplace can be connected to one founders.click workspace at a time. If yours is already connected to another workspace, [contact support](/help/contact).
- To use a different Client ID, disconnect and connect again. Disconnecting removes the synced listings from founders.click; they are imported again on your next sync. Nothing changes in Sharetribe.$md$::text)
UPDATE public.help_articles a SET content = n.content, updated_at = now()
  FROM n
 WHERE a.workspace_id IS NULL AND a.slug = 'connecting-your-sharetribe-marketplace'
   AND a.content IS DISTINCT FROM n.content;

UPDATE public.help_articles
   SET excerpt = 'Connect with your marketplace address and the Client ID of a Marketplace API application. It is read-only and needs no secret.'
 WHERE workspace_id IS NULL AND slug = 'connecting-your-sharetribe-marketplace'
   AND excerpt = 'Generate Integration API credentials in Sharetribe Console and paste them into founders.click.';

-- 4b. Where to find your Client ID (slug kept, so the URL does not change)
WITH n(title, content) AS (SELECT 'Where to find your Client ID'::text, $md$founders.click connects to your marketplace with the **Client ID** of a Sharetribe application.

## Marketplace API (recommended)

1. Log in to **Sharetribe Console**.
2. Open **Build → Applications**.
3. Create an application (any name works, for example *founders.click*) or open one you already have.
4. Copy its **Client ID**.

That is all founders.click needs. The connection is read-only, and you don't need the application's client secret.

## Integration API (advanced)

Only if you chose **Integration API** when connecting:

1. In **Build → Applications**, create an **Integration API** application.
2. Copy its **Client ID** and **Client Secret**. Sharetribe shows the secret only once, so copy it straight away. If you lose it, create a new Integration API application and use its values.

founders.click stores the secret encrypted, never shows it back to you, and deletes it when you disconnect.

Next: [Connecting your Sharetribe marketplace](/help/start-here/connecting-your-sharetribe-marketplace).$md$::text)
UPDATE public.help_articles a SET title = n.title, content = n.content, updated_at = now()
  FROM n
 WHERE a.workspace_id IS NULL AND a.slug = 'where-to-find-integration-api-credentials'
   AND (a.title IS DISTINCT FROM n.title OR a.content IS DISTINCT FROM n.content);

UPDATE public.help_articles
   SET excerpt = 'Your Client ID is in Sharetribe Console under Build → Applications. A client secret is only needed for the advanced Integration API option.'
 WHERE workspace_id IS NULL AND slug = 'where-to-find-integration-api-credentials'
   AND excerpt = 'Step-by-step screenshots for locating your Sharetribe Integration API client ID and secret.';

-- 4c. Troubleshooting failed syncs (the quoted messages are the ones the
--     Sharetribe page shows: friendlySharetribeError / the empty-sync warning)
WITH n(content) AS (SELECT $md$Your sync status is on the **Sharetribe** page: open **Sharetribe** in the sidebar, or **Workspace Settings → Sharetribe**. It shows:

- **Sync status**: *Last synced* with the date and time, *Last synced … with a warning*, or *Last sync failed*.
- **Listings imported**: how many listings the last sync brought in.
- The reason, when the last sync had a problem.

Listings sync automatically about every 30 minutes. To try again straight away, click **Sync now**.

## What the messages mean

**"Sharetribe didn't accept that Client ID"**: the Client ID is wrong, or its application was deleted in Sharetribe, and the connection shows *Needs attention*. Copy the Client ID again from **Build → Applications** in Sharetribe Console, then disconnect and connect again with it. For an Integration API connection, copy the Client Secret too.

**"Sharetribe rejected the connection"**: Sharetribe accepted the Client ID but refused to share listings with it. Check that it belongs to a Marketplace API application for your marketplace, then connect again.

**"Sharetribe is not answering right now"**: Sharetribe was unavailable and founders.click's automatic retries ran out. Wait a minute and click **Sync now**.

**"Sharetribe returned no published listings"**: founders.click kept your last synced listings instead of deleting them. Check that your listings are published in Sharetribe, then sync again.

**"We couldn't read the stored Integration API secret"**: disconnect and connect again with your Client ID and Client Secret.

## Listings that disappear

A listing that is no longer published on your marketplace is removed from founders.click on the next sync. Publish it again in Sharetribe and it comes back on the sync after that.

Still stuck? [Contact support](/help/contact) and tell us the message you see.$md$::text)
UPDATE public.help_articles a SET content = n.content, updated_at = now()
  FROM n
 WHERE a.workspace_id IS NULL AND a.slug = 'troubleshooting-failed-syncs'
   AND a.content IS DISTINCT FROM n.content;

-- 4d. Running your first listing sync (only fields mapListing() imports)
WITH n(content) AS (SELECT $md$Once your marketplace is connected, open **Sharetribe** in the sidebar (or **Workspace Settings → Sharetribe**) and click **Sync now**. The first sync imports every listing that is published on your marketplace.

When it finishes, the page tells you how many listings were synced, and shows **Listings imported** and **Sync status**. The **Synced Listings** card on your dashboard shows the same count.

## After the first sync

Listings refresh automatically about every 30 minutes, and you can click **Sync now** at any time. A listing that is no longer published on your marketplace is removed on the next sync.

## What is imported

For each published listing:

- title and description
- price and currency
- city, state and country from the listing's public data, and its map location
- category
- photos
- the author's display name
- the listing's other public fields
- a link back to the listing on your marketplace

founders.click reads published listings and their public data only. Private listing data is never imported, and nothing is written back to Sharetribe.

## How long does it take?

A marketplace with a hundred or so listings syncs in seconds. Larger catalogues take longer, because listings are read from Sharetribe 100 at a time.$md$::text)
UPDATE public.help_articles a SET content = n.content, updated_at = now()
  FROM n
 WHERE a.workspace_id IS NULL AND a.slug = 'running-your-first-listing-sync'
   AND a.content IS DISTINCT FROM n.content;

-- 4e. "N min read" for the new text, computed as the admin editor does on
--     save (readingTime in src/lib/help-admin.functions.ts: words / 200,
--     at least 1). Only from the seeded value, so the rollback can put it
--     back exactly; any other value is left alone.
UPDATE public.help_articles SET reading_time_minutes = 2
 WHERE workspace_id IS NULL AND slug = 'connecting-your-sharetribe-marketplace' AND reading_time_minutes = 4;
UPDATE public.help_articles SET reading_time_minutes = 1
 WHERE workspace_id IS NULL AND slug = 'where-to-find-integration-api-credentials' AND reading_time_minutes = 2;
UPDATE public.help_articles SET reading_time_minutes = 1
 WHERE workspace_id IS NULL AND slug = 'troubleshooting-failed-syncs' AND reading_time_minutes = 4;
UPDATE public.help_articles SET reading_time_minutes = 1
 WHERE workspace_id IS NULL AND slug = 'running-your-first-listing-sync' AND reading_time_minutes = 2;

-- VERIFY: every row should say true.
SELECT 'start-here is a published platform category, first in order' AS check,
       EXISTS (SELECT 1 FROM public.help_categories s
                WHERE s.slug = 'start-here' AND s.workspace_id IS NULL AND s.is_published
                  AND s.sort_order < ALL (SELECT c.sort_order FROM public.help_categories c
                                           WHERE c.workspace_id IS NULL AND c.slug <> 'start-here')) AS ok
UNION ALL SELECT 'five getting-started platform articles now in start-here',
       (SELECT count(*) = 5 FROM public.help_articles
         WHERE workspace_id IS NULL AND category_slug = 'start-here'
           AND slug IN ('welcome-to-founders-click', 'connecting-your-sharetribe-marketplace',
                        'running-your-first-listing-sync', 'creating-your-first-seo-page',
                        'publishing-pages-and-getting-indexed'))
UNION ALL SELECT 'no platform article left in a PRNM category except the unpublished BYOK one',
       NOT EXISTS (SELECT 1 FROM public.help_articles a JOIN public.help_categories c ON c.slug = a.category_slug
                    WHERE a.workspace_id IS NULL AND c.workspace_id IS NOT NULL AND a.status = 'published')
UNION ALL SELECT 'BYOK is a draft and unpublished',
       EXISTS (SELECT 1 FROM public.help_articles
                WHERE workspace_id IS NULL AND slug = 'bring-your-own-ai-key-byok'
                  AND status = 'draft' AND NOT is_published)
UNION ALL SELECT 'the four Sharetribe articles describe the launch flow',
       (SELECT count(*) = 4 FROM public.help_articles
         WHERE workspace_id IS NULL
           AND slug IN ('connecting-your-sharetribe-marketplace', 'where-to-find-integration-api-credentials',
                        'troubleshooting-failed-syncs', 'running-your-first-listing-sync')
           AND content NOT LIKE '%Test connection%' AND content NOT LIKE '%Re-paste your client secret%'
           AND content NOT LIKE '%Sync history%' AND content NOT LIKE '%on the dashboard%')
UNION ALL SELECT 'PRNM categories untouched and still PRNM''s',
       (SELECT count(*) = 2 FROM public.help_categories
         WHERE slug IN ('getting-started', 'billing') AND workspace_id IS NOT NULL);
