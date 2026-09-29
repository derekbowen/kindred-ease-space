-- ROLLBACK for 20260929000310_mvp_help_copy.sql
--
-- Restores, verbatim, the platform help text that migration replaced (the
-- values below are what the seed, 20260925000900 and 20260925000910 left in
-- production). Touches ONLY rows with workspace_id IS NULL. Each restore
-- applies only while the row still holds the migration's text, so a later
-- hand edit is not clobbered, and a second run changes nothing. It does not
-- restore updated_at. It brings back the claims the migration removed, so use
-- it only to unblock something else.
BEGIN;

UPDATE public.help_articles
   SET content = $old$# Welcome to founders.click

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
4. Publish and submit your sitemap$old$,
       reading_time_minutes = CASE WHEN reading_time_minutes = 1 THEN 3 ELSE reading_time_minutes END,
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'welcome-to-founders-click'
   AND content = $new$founders.click turns the published listings on your Sharetribe marketplace into SEO landing pages on your own domain.

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
- [Submitting your sitemap](/help/seo-growth/submitting-your-sitemap)$new$;

UPDATE public.help_articles
   SET excerpt = 'A quick tour of what founders.click does and how to get value in your first hour.',
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'welcome-to-founders-click'
   AND excerpt = 'What founders.click does, from connecting Sharetribe to publishing your first page on your own domain.';

UPDATE public.help_articles
   SET content = replace(content, $new$Only the workspace owner can connect a marketplace.$new$, $old$This takes about five minutes. Only the workspace owner can connect a marketplace.$old$),
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'connecting-your-sharetribe-marketplace'
   AND strpos(content, $new$Only the workspace owner can connect a marketplace.$new$) > 0
   AND strpos(content, $old$This takes about five minutes. Only the workspace owner can connect a marketplace.$old$) = 0;

UPDATE public.help_articles
   SET content = replace(content, $new$Open **Sharetribe & inventory** in the sidebar (it is also under **Settings → Sharetribe**).$new$, $old$Open **Sharetribe** in the sidebar (it is also under **Workspace Settings → Sharetribe**).$old$),
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'connecting-your-sharetribe-marketplace'
   AND strpos(content, $new$Open **Sharetribe & inventory** in the sidebar (it is also under **Settings → Sharetribe**).$new$) > 0
   AND strpos(content, $old$Open **Sharetribe** in the sidebar (it is also under **Workspace Settings → Sharetribe**).$old$) = 0;

UPDATE public.help_articles
   SET content = replace(content, $new$open **Sharetribe & inventory** in the sidebar (or **Settings → Sharetribe**)$new$, $old$open **Sharetribe** in the sidebar (or **Workspace Settings → Sharetribe**)$old$),
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'running-your-first-listing-sync'
   AND strpos(content, $new$open **Sharetribe & inventory** in the sidebar (or **Settings → Sharetribe**)$new$) > 0
   AND strpos(content, $old$open **Sharetribe** in the sidebar (or **Workspace Settings → Sharetribe**)$old$) = 0;

UPDATE public.help_articles
   SET content = replace(content, $new$It depends on the size of your catalogue: listings are read from Sharetribe 100 at a time, so a larger marketplace takes longer. The **Sharetribe & inventory** page shows when the last sync finished and how many listings it imported.$new$, $old$A marketplace with a hundred or so listings syncs in seconds. Larger catalogues take longer, because listings are read from Sharetribe 100 at a time.$old$),
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'running-your-first-listing-sync'
   AND strpos(content, $new$It depends on the size of your catalogue: listings are read from Sharetribe 100 at a time, so a larger marketplace takes longer. The **Sharetribe & inventory** page shows when the last sync finished and how many listings it imported.$new$) > 0
   AND strpos(content, $old$A marketplace with a hundred or so listings syncs in seconds. Larger catalogues take longer, because listings are read from Sharetribe 100 at a time.$old$) = 0;

UPDATE public.help_articles
   SET content = replace(content, $new$open **Sharetribe & inventory** in the sidebar, or **Settings → Sharetribe**.$new$, $old$open **Sharetribe** in the sidebar, or **Workspace Settings → Sharetribe**.$old$),
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'troubleshooting-failed-syncs'
   AND strpos(content, $new$open **Sharetribe & inventory** in the sidebar, or **Settings → Sharetribe**.$new$) > 0
   AND strpos(content, $old$open **Sharetribe** in the sidebar, or **Workspace Settings → Sharetribe**.$old$) = 0;

UPDATE public.help_articles
   SET content = replace(content, $new$The exact link is shown under **Settings → Domains**.$new$, $old$The exact link is shown under **Workspace Settings → Domains**.$old$),
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'submitting-your-sitemap'
   AND strpos(content, $new$The exact link is shown under **Settings → Domains**.$new$) > 0
   AND strpos(content, $old$The exact link is shown under **Workspace Settings → Domains**.$old$) = 0;

UPDATE public.help_articles
   SET content = replace(content, $new$under **Settings → Billing**.$new$, $old$under **Billing & Plans**.$old$),
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'understanding-page-limits'
   AND strpos(content, $new$under **Settings → Billing**.$new$) > 0
   AND strpos(content, $old$under **Billing & Plans**.$old$) = 0;

UPDATE public.help_articles
   SET content = $old$# Creating your first SEO page

1. Open **Content → Quick Page Builder**.
2. Pick one of the suggested cities — they come from your synced listings — or type your own.
3. Check the page title and the brief, then click **Generate & publish**.

The page is written from your live listings. If it passes the pre-publish checks and your plan has room, it goes live straight away; otherwise it is saved as a draft and the builder tells you what to fix. You can edit any page later under **Pages**.$old$,
       reading_time_minutes = CASE WHEN reading_time_minutes = 1 THEN 3 ELSE reading_time_minutes END,
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'creating-your-first-seo-page'
   AND content = $new$1. Open **Opportunities**. It lists the city and category pages your synced listings can support.
2. Pick one, or start from **Page Builder**, and choose one of the three page templates.
3. founders.click writes a **draft** from your real listings. A draft is never live: edit it and preview it as it will appear on your domain.
4. When it looks right, **publish** it. The page goes live on your verified domain and is added to your sitemap automatically.

Published pages are served on your own domain, so connect and verify it first under **Settings → Domains**. Publishing also needs room in your plan; drafts never count against it. Every draft and published page is listed under **My Pages**.$new$;

UPDATE public.help_articles
   SET title = 'Connecting Google Search Console',
       excerpt = CASE WHEN excerpt = 'Verify your domain in your own Google Search Console account to see its impressions, clicks and indexing status there.' THEN 'Verify your domain in GSC so you can see impressions, clicks, and indexing status.' ELSE excerpt END,
       content = $old$# Connecting Google Search Console

1. Open Google Search Console
2. Add your custom domain as a *Domain property*
3. Add the TXT record GSC gives you to your DNS
4. Wait up to 24 hours for verification$old$,
       reading_time_minutes = CASE WHEN reading_time_minutes = 1 THEN 3 ELSE reading_time_minutes END,
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'connecting-google-search-console'
   AND title = 'Adding your domain to Google Search Console'
   AND content = $new$founders.click doesn't connect to Google Search Console or import its data. You use Search Console directly, in your own Google account, to see how Google finds and indexes the pages you publish.

1. Open Google Search Console.
2. Add your custom domain as a *Domain property*.
3. Add the TXT record Search Console gives you to your DNS.
4. Wait for Google to verify it; this can take up to a day.

Then submit your sitemap: see [Submitting your sitemap](/help/seo-growth/submitting-your-sitemap).$new$;

UPDATE public.help_articles
   SET excerpt = 'Publish, ping Google, and watch your pages enter the index.',
       updated_at = now()
 WHERE workspace_id IS NULL
   AND slug = 'publishing-pages-and-getting-indexed'
   AND excerpt = 'Publish on your verified domain, submit your sitemap, and help Google find your pages.';

COMMIT;

-- VERIFY: what the rollback restored (expect the seeded / 000900 / 000910 text back).
SELECT slug, title, excerpt, reading_time_minutes, left(content, 70) AS starts_with
  FROM public.help_articles
 WHERE workspace_id IS NULL
   AND slug IN ('welcome-to-founders-click', 'connecting-your-sharetribe-marketplace',
                'running-your-first-listing-sync', 'troubleshooting-failed-syncs',
                'submitting-your-sitemap', 'understanding-page-limits',
                'creating-your-first-seo-page', 'connecting-google-search-console',
                'publishing-pages-and-getting-indexed')
 ORDER BY slug;
