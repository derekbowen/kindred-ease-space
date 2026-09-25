-- Rollback for 20260925000910_help_center_claims_fix.sql.
--
-- Restores, verbatim, the platform help rows that migration changed (the
-- values below are production's as read on 2026-09-25). Touches ONLY rows with
-- workspace_id IS NULL. Each content restore applies only while the row still
-- holds the text the migration wrote, so a later hand edit is not clobbered.

UPDATE public.help_articles
   SET content = $md$# Page limits and upgrades

- **Starter** - 50 pages
- **Growth** - 500 pages
- **Scale** - 5,000 pages
- **Enterprise** - custom

Only *published* pages count.$md$,
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'understanding-page-limits'
   AND content = $md$# Page limits and upgrades

Each plan includes a number of **published** pages. Drafts don't count.

| Plan | Price | Published pages |
|---|---|---|
| Starter | $29/month | 100 |
| Growth | $59/month | 500 |
| Scale | $99/month | 1,000 |
| Pro | $199/month | 3,000 |
| Agency | $299/month | 5,000 |

Need more room without changing plans? On any paid plan you can add page capacity in blocks of 1,000 under **Billing & Plans**.

When you reach your limit, new pages are saved as drafts until you upgrade or unpublish a page.$md$;

UPDATE public.help_articles
   SET content = $md$# Submitting your sitemap

Your sitemap lives at `https://your-domain.com/sitemap.xml`. In GSC, go to *Sitemaps* and paste the URL.

Google will start crawling within hours.$md$,
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'submitting-your-sitemap'
   AND content = $md$# Submitting your sitemap

Once your domain is connected, your SEO pages are listed in their own sitemap at `https://your-domain.com/a/sitemap.xml` (use your own domain). The exact link is shown under **Workspace Settings → Domains**.

In Google Search Console, open **Sitemaps**, paste that URL and submit it. Google usually starts crawling within a few days, and picks up new pages as the sitemap updates.$md$;

UPDATE public.help_articles
   SET title = 'Handling multiple marketplaces in one workspace',
       excerpt = 'Run several Sharetribe marketplaces from a single founders.click workspace.',
       content = $md$# Multiple marketplaces

On paid plans, you can connect multiple Sharetribe accounts to one workspace. Each marketplace gets its own pages and sitemap.$md$,
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'handling-multiple-marketplaces'
   AND content = $md$# Running more than one marketplace

Each founders.click workspace connects to **one** Sharetribe marketplace, and a marketplace can be connected to only one workspace at a time.

Each workspace has its own pages, sitemap, domain and plan. To build SEO pages for another marketplace, contact support and we'll set up a separate workspace for it.$md$;

UPDATE public.help_articles
   SET content = $md$# Creating your first SEO page

Go to **Pages -> New page** and pick a template. The *City landing page* template is the best starting point.

Fill in the variables (city, state, category) and hit *Generate*. The AI fills in the body. Review, edit, and click *Publish*.$md$,
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'creating-your-first-seo-page'
   AND content = $md$# Creating your first SEO page

1. Open **Content → Quick Page Builder**.
2. Pick one of the suggested cities — they come from your synced listings — or type your own.
3. Check the page title and the brief, then click **Generate & publish**.

The page is written from your live listings. If it passes the pre-publish checks and your plan has room, it goes live straight away; otherwise it is saved as a draft and the builder tells you what to fix. You can edit any page later under **Pages**.$md$;

-- All four were published ('published', true) before the migration.
UPDATE public.help_articles
   SET is_published = true,
       status = 'published',
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug IN (
     'mapping-custom-fields-to-page-variables',
     'using-the-matrix-builder',
     'writing-seo-content-with-ai',
     'understanding-page-templates'
   );

UPDATE public.help_categories
   SET is_published = true,
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'page-builder';
