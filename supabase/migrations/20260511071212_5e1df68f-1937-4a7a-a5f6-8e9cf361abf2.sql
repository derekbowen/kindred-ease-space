
ALTER TABLE public.help_categories ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE public.help_articles ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE public.help_articles
  ADD COLUMN IF NOT EXISTS body_html TEXT,
  ADD COLUMN IF NOT EXISTS author_name TEXT,
  ADD COLUMN IF NOT EXISTS author_avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS reading_time_minutes INT,
  ADD COLUMN IF NOT EXISTS helpful_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS not_helpful_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS related_article_ids UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;

UPDATE public.help_articles SET status = 'published', published_at = COALESCE(published_at, created_at) WHERE is_published = true AND status = 'draft';

CREATE INDEX IF NOT EXISTS idx_help_articles_search ON public.help_articles USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_help_articles_published_at ON public.help_articles(published_at DESC) WHERE status = 'published';

DROP TRIGGER IF EXISTS help_articles_search_vector_update ON public.help_articles;
CREATE TRIGGER help_articles_search_vector_update
BEFORE INSERT OR UPDATE ON public.help_articles
FOR EACH ROW EXECUTE FUNCTION
  tsvector_update_trigger(search_vector, 'pg_catalog.english', title, excerpt, content);

UPDATE public.help_articles SET title = title;

CREATE TABLE IF NOT EXISTS public.help_article_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id UUID NOT NULL REFERENCES public.help_articles(id) ON DELETE CASCADE,
  is_helpful BOOLEAN NOT NULL,
  comment TEXT,
  user_id UUID,
  session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_help_article_feedback_article ON public.help_article_feedback(article_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.help_search_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query TEXT NOT NULL,
  results_count INT,
  clicked_article_id UUID REFERENCES public.help_articles(id) ON DELETE SET NULL,
  user_id UUID,
  session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_help_search_queries_query ON public.help_search_queries(query);
CREATE INDEX IF NOT EXISTS idx_help_search_queries_created ON public.help_search_queries(created_at DESC);

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES public.workspaces(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  name TEXT,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  category TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  assigned_to UUID,
  attachments JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON public.support_tickets(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_workspace ON public.support_tickets(workspace_id);

ALTER TABLE public.help_article_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.help_search_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can submit feedback" ON public.help_article_feedback;
DROP POLICY IF EXISTS "Admins read feedback" ON public.help_article_feedback;
CREATE POLICY "Anyone can submit feedback" ON public.help_article_feedback FOR INSERT WITH CHECK (true);
CREATE POLICY "Admins read feedback" ON public.help_article_feedback FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Anyone can log search queries" ON public.help_search_queries;
DROP POLICY IF EXISTS "Admins read search queries" ON public.help_search_queries;
CREATE POLICY "Anyone can log search queries" ON public.help_search_queries FOR INSERT WITH CHECK (true);
CREATE POLICY "Admins read search queries" ON public.help_search_queries FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Anyone can create tickets" ON public.support_tickets;
DROP POLICY IF EXISTS "Admins or workspace members read tickets" ON public.support_tickets;
DROP POLICY IF EXISTS "Admins update tickets" ON public.support_tickets;
CREATE POLICY "Anyone can create tickets" ON public.support_tickets FOR INSERT WITH CHECK (true);
CREATE POLICY "Admins or workspace members read tickets" ON public.support_tickets FOR SELECT
  USING (public.has_role(auth.uid(), 'admin') OR (workspace_id IS NOT NULL AND public.is_workspace_member(workspace_id, auth.uid())));
CREATE POLICY "Admins update tickets" ON public.support_tickets FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

INSERT INTO public.help_categories (slug, name, description, icon, sort_order, is_published, workspace_id)
VALUES
  ('getting-started', 'Getting Started', 'Onboarding, first page, connecting Sharetribe, and your first sync.', 'Rocket', 1, true, NULL),
  ('sharetribe-integration', 'Sharetribe Integration', 'Credentials, sync troubleshooting, listing mapping, and custom fields.', 'Plug', 2, true, NULL),
  ('page-builder', 'Page Builder', 'Templates, variables, the matrix builder, AI content, and publishing.', 'LayoutGrid', 3, true, NULL),
  ('seo-growth', 'SEO & Growth', 'Programmatic SEO, structured data, internal linking, GSC, and indexing.', 'TrendingUp', 4, true, NULL),
  ('account-billing', 'Account & Billing', 'Plans, page limits, upgrading, team members, invoices, and cancellation.', 'CreditCard', 5, true, NULL)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.help_articles (category_slug, slug, title, excerpt, content, status, is_published, published_at, reading_time_minutes, workspace_id)
SELECT c, sl, t, e, m, 'published', true, now(), rt, NULL
FROM (VALUES
  ('getting-started','welcome-to-founders-click','Welcome to founders.click','A quick tour of what founders.click does and how to get value in your first hour.',E'# Welcome to founders.click\n\nfounders.click helps Sharetribe marketplace operators ship hundreds of SEO landing pages in days, not months.\n\n## What you can do\n\n- Connect your Sharetribe marketplace in under 5 minutes\n- Sync your live listings automatically\n- Generate SEO pages from templates with AI-assisted content\n- Track everything in Google Search Console\n\n## Next steps\n\n1. Connect Sharetribe\n2. Run your first sync\n3. Create your first page\n4. Publish and submit your sitemap',3),
  ('getting-started','connecting-your-sharetribe-marketplace','Connecting your Sharetribe marketplace','Generate Integration API credentials in Sharetribe Console and paste them into founders.click.',E'# Connecting your Sharetribe marketplace\n\nThis takes about 5 minutes.\n\n## 1. Create Integration API credentials\n\nGo to **Sharetribe Console -> Build -> Applications** and click *Add new*. Pick the **Integration API** scope.\n\n## 2. Copy your client ID and secret\n\nSharetribe shows the client secret only once. Copy both immediately.\n\n## 3. Paste them into founders.click\n\nOpen **Workspace Settings -> Sharetribe** and paste both values, then click *Test connection*.',4),
  ('getting-started','running-your-first-listing-sync','Running your first listing sync','Pull your live Sharetribe listings into founders.click so they can power SEO pages.',E'# Running your first sync\n\nOnce Sharetribe is connected, hit **Sync now** on the dashboard. The first sync pulls every published listing.\n\n## What gets synced\n\n- Listing titles, descriptions, prices\n- Custom fields (mapped automatically when names match)\n- Author profiles\n- Photos\n\n## How long does it take?\n\nMost marketplaces sync in under 2 minutes. Marketplaces over 5,000 listings can take up to 15 minutes.',2),
  ('getting-started','creating-your-first-seo-page','Creating your first SEO page','Use a template to ship your first city or category landing page in under 10 minutes.',E'# Creating your first SEO page\n\nGo to **Pages -> New page** and pick a template. The *City landing page* template is the best starting point.\n\nFill in the variables (city, state, category) and hit *Generate*. The AI fills in the body. Review, edit, and click *Publish*.',3),
  ('getting-started','publishing-pages-and-getting-indexed','Publishing pages and getting indexed','Publish, ping Google, and watch your pages enter the index.',E'# Publishing pages and getting indexed\n\nPublishing makes a page live at your custom domain. Google needs to crawl it before it can rank.\n\n## Speed up indexing\n\n- Submit your sitemap in Google Search Console\n- Use the URL Inspection tool to request indexing for your top 10 pages\n- Internal-link from your homepage',3),
  ('sharetribe-integration','where-to-find-integration-api-credentials','Where to find your Integration API credentials','Step-by-step screenshots for locating your Sharetribe Integration API client ID and secret.',E'# Finding your Integration API credentials\n\n1. Log in to **Sharetribe Console**\n2. Open **Build -> Applications**\n3. Click *Add new application*\n4. Choose **Integration API**\n5. Copy the client ID and secret immediately',2),
  ('sharetribe-integration','troubleshooting-failed-syncs','Troubleshooting failed syncs','When a sync fails: how to read the error, what causes most failures, and how to fix them.',E'# Troubleshooting failed syncs\n\n## Most common causes\n\n1. **Invalid credentials** - Re-paste your client secret\n2. **API rate limits** - Sharetribe limits to 60 req/min. Wait and retry.\n3. **Schema mismatch** - A custom field type changed in Sharetribe\n\nCheck **Settings -> Sync history** for the error log.',4),
  ('sharetribe-integration','mapping-custom-fields-to-page-variables','Mapping custom fields to page variables','Connect your Sharetribe custom fields to template variables for richer auto-generated pages.',E'# Mapping custom fields\n\nGo to **Settings -> Field mapping**. founders.click auto-detects fields with matching names. For others, drag a Sharetribe field onto a template variable.',3),
  ('sharetribe-integration','handling-multiple-marketplaces','Handling multiple marketplaces in one workspace','Run several Sharetribe marketplaces from a single founders.click workspace.',E'# Multiple marketplaces\n\nOn paid plans, you can connect multiple Sharetribe accounts to one workspace. Each marketplace gets its own pages and sitemap.',2),
  ('page-builder','understanding-page-templates','Understanding page templates','Templates define page structure. Variables make them dynamic.',E'# Page templates\n\nTemplates are reusable page structures with `{{variables}}` for dynamic content. Edit one template, regenerate hundreds of pages.',4),
  ('page-builder','using-the-matrix-builder','Using the matrix builder for bulk page creation','Generate pages for every combination of two or more variables in one click.',E'# The matrix builder\n\nUpload two CSVs and the matrix builder generates a page for every combination.',3),
  ('page-builder','writing-seo-content-with-ai','Writing SEO-optimized content with AI assist','Use AI to draft sections, but always review and personalize before publishing.',E'# AI content assist\n\nClick *Generate with AI* on any section. Provide a brief prompt and the AI fills in 200-500 words. Always review.',3),
  ('seo-growth','connecting-google-search-console','Connecting Google Search Console','Verify your domain in GSC so you can see impressions, clicks, and indexing status.',E'# Connecting Google Search Console\n\n1. Open Google Search Console\n2. Add your custom domain as a *Domain property*\n3. Add the TXT record GSC gives you to your DNS\n4. Wait up to 24 hours for verification',3),
  ('seo-growth','submitting-your-sitemap','Submitting your sitemap','Tell Google about every page you have published in one shot.',E'# Submitting your sitemap\n\nYour sitemap lives at `https://your-domain.com/sitemap.xml`. In GSC, go to *Sitemaps* and paste the URL.\n\nGoogle will start crawling within hours.',2),
  ('account-billing','understanding-page-limits','Understanding page limits and upgrading','Each plan has a published-page limit.',E'# Page limits and upgrades\n\n- **Starter** - 50 pages\n- **Growth** - 500 pages\n- **Scale** - 5,000 pages\n- **Enterprise** - custom\n\nOnly *published* pages count.',2)
) AS s(c, sl, t, e, m, rt)
ON CONFLICT (slug) DO NOTHING;
