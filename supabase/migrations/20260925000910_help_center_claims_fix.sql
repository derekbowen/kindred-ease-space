-- ============================================================================
-- HELP CENTER: NO PUBLIC ARTICLE MAY DESCRIBE A FEATURE OR FACT THE LAUNCH
-- PRODUCT DOES NOT HAVE.
--
-- Runs after 20260925000900 (which moved creating-your-first-seo-page into
-- the platform 'start-here' category). Facts (production, read-only,
-- 2026-09-25; plan facts from src/lib/plan-catalog.ts; sitemap path from the
-- Domains page and the /a/sitemap.xml route):
--  * understanding-page-limits lists Starter 50 / Growth 500 / Scale 5,000 /
--    Enterprise custom. The plans are Starter 100, Growth 500, Scale 1,000,
--    Pro 3,000, Agency 5,000 pages, with 1,000-page add-ons on paid plans.
--  * submitting-your-sitemap gives /sitemap.xml; a customer's SEO pages are
--    listed at https://<their domain>/a/sitemap.xml.
--  * handling-multiple-marketplaces promises several marketplaces per
--    workspace; a workspace connects exactly one, and a marketplace can be
--    connected to one workspace at a time.
--  * creating-your-first-seo-page describes Pages -> New page -> template ->
--    Generate; the launch flow is Content -> Quick Page Builder ->
--    Generate & publish (draft when checks fail or the plan is full).
--  * mapping-custom-fields-to-page-variables ("Settings -> Field mapping"),
--    using-the-matrix-builder, writing-seo-content-with-ai ("Generate with
--    AI" per section) and understanding-page-templates ("edit one template,
--    regenerate hundreds") describe screens that do not exist at launch:
--    unpublished (status 'draft', is_published false — what the admin editor
--    writes). With all three of its articles unpublished, the platform
--    'page-builder' category would be an empty page in the sitemap, so it is
--    unpublished too.
--
-- Touches ONLY rows with workspace_id IS NULL (the platform help center).
-- No Pool Rental Near Me row is written. Every content rewrite applies only
-- while the row still holds the exact text it replaces, so an article someone
-- has since edited in the admin UI is left alone, and a second run changes
-- nothing. Rollback: supabase/rollback/20260925000910_help_center_claims_fix_rollback.sql
-- ============================================================================

-- 1. Page limits: the real plans.
UPDATE public.help_articles
   SET content = $md$# Page limits and upgrades

Each plan includes a number of **published** pages. Drafts don't count.

| Plan | Price | Published pages |
|---|---|---|
| Starter | $29/month | 100 |
| Growth | $59/month | 500 |
| Scale | $99/month | 1,000 |
| Pro | $199/month | 3,000 |
| Agency | $299/month | 5,000 |

Need more room without changing plans? On any paid plan you can add page capacity in blocks of 1,000 under **Billing & Plans**.

When you reach your limit, new pages are saved as drafts until you upgrade or unpublish a page.$md$,
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'understanding-page-limits'
   AND content = $md$# Page limits and upgrades

- **Starter** - 50 pages
- **Growth** - 500 pages
- **Scale** - 5,000 pages
- **Enterprise** - custom

Only *published* pages count.$md$;

-- 2. Sitemap: the path customers' SEO pages are actually listed at.
UPDATE public.help_articles
   SET content = $md$# Submitting your sitemap

Once your domain is connected, your SEO pages are listed in their own sitemap at `https://your-domain.com/a/sitemap.xml` (use your own domain). The exact link is shown under **Workspace Settings → Domains**.

In Google Search Console, open **Sitemaps**, paste that URL and submit it. Google usually starts crawling within a few days, and picks up new pages as the sitemap updates.$md$,
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'submitting-your-sitemap'
   AND content = $md$# Submitting your sitemap

Your sitemap lives at `https://your-domain.com/sitemap.xml`. In GSC, go to *Sitemaps* and paste the URL.

Google will start crawling within hours.$md$;

-- 3. One marketplace per workspace.
UPDATE public.help_articles
   SET title = 'Running more than one marketplace',
       excerpt = 'Each workspace connects to one Sharetribe marketplace.',
       content = $md$# Running more than one marketplace

Each founders.click workspace connects to **one** Sharetribe marketplace, and a marketplace can be connected to only one workspace at a time.

Each workspace has its own pages, sitemap, domain and plan. To build SEO pages for another marketplace, contact support and we'll set up a separate workspace for it.$md$,
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'handling-multiple-marketplaces'
   AND content = $md$# Multiple marketplaces

On paid plans, you can connect multiple Sharetribe accounts to one workspace. Each marketplace gets its own pages and sitemap.$md$;

-- 4. First page: the launch flow.
UPDATE public.help_articles
   SET content = $md$# Creating your first SEO page

1. Open **Content → Quick Page Builder**.
2. Pick one of the suggested cities — they come from your synced listings — or type your own.
3. Check the page title and the brief, then click **Generate & publish**.

The page is written from your live listings. If it passes the pre-publish checks and your plan has room, it goes live straight away; otherwise it is saved as a draft and the builder tells you what to fix. You can edit any page later under **Pages**.$md$,
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'creating-your-first-seo-page'
   AND content = $md$# Creating your first SEO page

Go to **Pages -> New page** and pick a template. The *City landing page* template is the best starting point.

Fill in the variables (city, state, category) and hit *Generate*. The AI fills in the body. Review, edit, and click *Publish*.$md$;

-- 5. Screens that do not exist at launch: unpublish, keep the rows.
UPDATE public.help_articles
   SET is_published = false,
       status = 'draft',
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug IN (
     'mapping-custom-fields-to-page-variables',
     'using-the-matrix-builder',
     'writing-seo-content-with-ai',
     'understanding-page-templates'
   )
   AND (is_published IS DISTINCT FROM false OR status IS DISTINCT FROM 'draft');

-- 6. An empty platform category is not a public page.
UPDATE public.help_categories c
   SET is_published = false,
       updated_at = now()
 WHERE c.workspace_id IS NULL
   AND c.slug = 'page-builder'
   AND c.is_published
   AND NOT EXISTS (
     SELECT 1 FROM public.help_articles a
      WHERE a.category_slug = c.slug
        AND a.workspace_id IS NULL
        AND a.is_published
   );

-- ---------------------------------------------------------------------------
-- Verification — what the public help center now contains.
-- ---------------------------------------------------------------------------
SELECT a.category_slug, a.slug, a.title, a.is_published, a.status,
       left(a.content, 60) AS starts_with
  FROM public.help_articles a
 WHERE a.workspace_id IS NULL
   AND a.slug IN (
     'understanding-page-limits', 'submitting-your-sitemap',
     'handling-multiple-marketplaces', 'creating-your-first-seo-page',
     'mapping-custom-fields-to-page-variables', 'using-the-matrix-builder',
     'writing-seo-content-with-ai', 'understanding-page-templates'
   )
 ORDER BY a.category_slug, a.slug;
