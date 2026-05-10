
-- ============================================================================
-- PHASE 1: MULTI-TENANT DATA ISOLATION
-- Internal workspace: 6501e018-473c-4c09-a834-a0bdb59aa0ee
-- (excludes views: page_quality, site_issues, template_quality_breakdown)
-- ============================================================================

DO $$
DECLARE
  internal_ws uuid := '6501e018-473c-4c09-a834-a0bdb59aa0ee';
  t text;
  simple_tables text[] := ARRAY[
    'content_plan',
    'competitor_sites','competitor_urls','competitor_pages','competitor_host_matches','host_match_false_positives',
    'gsc_query_data','serp_rankings','tracked_keywords',
    'page_audits',
    'internal_link_suggestions','seo_overrides','seo_fix_jobs',
    'content_404_log',
    'blog_posts','host_tools','help_articles','help_categories',
    'providers','provider_leads','provider_claims','provider_plan_requests',
    'enriched_contacts','enrichment_spend_log',
    'host_profiles',
    'listing_sync_log','synced_listings',
    'courses','course_enrollments','course_progress','course_progress_events','course_completions',
    'mb_threads','mb_replies',
    'pool_waitlist','feature_requests','city_link_clicks','cities_hero_backfill_log',
    'suppressed_emails',
    'email_send_log'
  ];
BEGIN
  FOREACH t IN ARRAY simple_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=t AND column_name='workspace_id'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE', t);
      EXECUTE format('UPDATE public.%I SET workspace_id = %L WHERE workspace_id IS NULL', t, internal_ws);
      EXECUTE format('CREATE INDEX %I ON public.%I(workspace_id)', t || '_workspace_id_idx', t);
    END IF;
  END LOOP;

  FOREACH t IN ARRAY ARRAY[
    'content_plan','competitor_sites','competitor_urls','competitor_pages','competitor_host_matches','host_match_false_positives',
    'gsc_query_data','serp_rankings','tracked_keywords',
    'page_audits',
    'internal_link_suggestions','seo_overrides','seo_fix_jobs',
    'content_404_log',
    'blog_posts','host_tools','help_articles','help_categories',
    'providers','provider_leads','provider_claims','provider_plan_requests',
    'enriched_contacts','enrichment_spend_log',
    'host_profiles',
    'listing_sync_log','synced_listings',
    'courses','course_enrollments','course_progress','course_progress_events','course_completions',
    'mb_threads','mb_replies',
    'pool_waitlist','feature_requests','city_link_clicks','cities_hero_backfill_log',
    'suppressed_emails'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN workspace_id SET NOT NULL', t);
  END LOOP;
END $$;

-- mb_likes: backfill via parent thread/reply, then NOT NULL
ALTER TABLE public.mb_likes ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE;
UPDATE public.mb_likes l
   SET workspace_id = COALESCE(t.workspace_id, r_t.workspace_id, '6501e018-473c-4c09-a834-a0bdb59aa0ee')
  FROM public.mb_likes l2
  LEFT JOIN public.mb_threads t ON t.id = l2.thread_id
  LEFT JOIN public.mb_replies r ON r.id = l2.reply_id
  LEFT JOIN public.mb_threads r_t ON r_t.id = r.thread_id
  WHERE l.id = l2.id AND l.workspace_id IS NULL;
ALTER TABLE public.mb_likes ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS mb_likes_workspace_id_idx ON public.mb_likes(workspace_id);

-- email_branding -> per-workspace
ALTER TABLE public.email_branding ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE;
UPDATE public.email_branding SET workspace_id = '6501e018-473c-4c09-a834-a0bdb59aa0ee' WHERE workspace_id IS NULL;
ALTER TABLE public.email_branding ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE public.email_branding DROP CONSTRAINT IF EXISTS email_branding_pkey;
ALTER TABLE public.email_branding DROP COLUMN IF EXISTS id;
ALTER TABLE public.email_branding ADD PRIMARY KEY (workspace_id);

-- site_footer_settings -> per-workspace
ALTER TABLE public.site_footer_settings ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE;
UPDATE public.site_footer_settings SET workspace_id = '6501e018-473c-4c09-a834-a0bdb59aa0ee' WHERE workspace_id IS NULL;
ALTER TABLE public.site_footer_settings ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE public.site_footer_settings DROP CONSTRAINT IF EXISTS site_footer_settings_pkey;
ALTER TABLE public.site_footer_settings DROP COLUMN IF EXISTS id;
ALTER TABLE public.site_footer_settings ADD PRIMARY KEY (workspace_id);

-- ============================================================================
-- RLS REWRITE
-- ============================================================================
DROP POLICY IF EXISTS "Admins manage content plan" ON public.content_plan;
DROP POLICY IF EXISTS "Admins manage competitor_sites" ON public.competitor_sites;
DROP POLICY IF EXISTS "Admins manage competitor_urls" ON public.competitor_urls;
DROP POLICY IF EXISTS "admins manage competitor pages" ON public.competitor_pages;
DROP POLICY IF EXISTS "Admins manage host matches" ON public.competitor_host_matches;
DROP POLICY IF EXISTS "Admins manage false positives" ON public.host_match_false_positives;
DROP POLICY IF EXISTS "admins manage gsc query data" ON public.gsc_query_data;

DO $$
DECLARE
  rec record;
  t text;
  batch text[] := ARRAY[
    'content_plan','competitor_sites','competitor_urls','competitor_pages','competitor_host_matches','host_match_false_positives',
    'gsc_query_data','serp_rankings','tracked_keywords','page_audits',
    'internal_link_suggestions','seo_overrides','seo_fix_jobs','content_404_log',
    'providers','provider_leads','provider_claims','provider_plan_requests',
    'enriched_contacts','enrichment_spend_log',
    'host_profiles','listing_sync_log','synced_listings',
    'pool_waitlist','feature_requests','city_link_clicks','cities_hero_backfill_log',
    'suppressed_emails',
    'host_tools','help_articles','help_categories','blog_posts','courses'
  ];
BEGIN
  -- drop any remaining "admins manage..." ALL policies on these tables
  FOR rec IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname='public'
      AND cmd='ALL'
      AND tablename = ANY (batch)
      AND (policyname ILIKE '%admin%manage%' OR policyname ILIKE '%admins can manage%')
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', rec.policyname, rec.tablename);
  END LOOP;

  -- create workspace + admin policies (skip tables that don't exist as base tables)
  FOREACH t IN ARRAY batch LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=t AND column_name='workspace_id') THEN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='Workspace members manage ' || t) THEN
        EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (is_workspace_member(workspace_id, auth.uid())) WITH CHECK (is_workspace_member(workspace_id, auth.uid()))',
          'Workspace members manage ' || t, t);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='Admin escape ' || t) THEN
        EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (has_role(auth.uid(),''admin'')) WITH CHECK (has_role(auth.uid(),''admin''))',
          'Admin escape ' || t, t);
      END IF;
    END IF;
  END LOOP;
END $$;

-- mb_threads / mb_replies: keep public read + author rules, replace admin-only
DROP POLICY IF EXISTS "Admins manage threads" ON public.mb_threads;
CREATE POLICY "Workspace members moderate mb_threads" ON public.mb_threads FOR ALL TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid())) WITH CHECK (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Admin escape mb_threads" ON public.mb_threads FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin')) WITH CHECK (has_role(auth.uid(),'admin'));

DROP POLICY IF EXISTS "Admins manage replies" ON public.mb_replies;
CREATE POLICY "Workspace members moderate mb_replies" ON public.mb_replies FOR ALL TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid())) WITH CHECK (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Admin escape mb_replies" ON public.mb_replies FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin')) WITH CHECK (has_role(auth.uid(),'admin'));

CREATE POLICY "Admin escape mb_likes" ON public.mb_likes FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin')) WITH CHECK (has_role(auth.uid(),'admin'));

-- course_* tables: keep user-owned policies, replace admin-only
DO $$
DECLARE
  t text;
  rec record;
BEGIN
  FOREACH t IN ARRAY ARRAY['course_enrollments','course_progress','course_progress_events','course_completions'] LOOP
    FOR rec IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t AND cmd='ALL' AND policyname ILIKE 'Admins manage%' LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', rec.policyname, t);
    END LOOP;
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (is_workspace_member(workspace_id, auth.uid())) WITH CHECK (is_workspace_member(workspace_id, auth.uid()))',
      'Workspace members manage ' || t, t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (has_role(auth.uid(),''admin'')) WITH CHECK (has_role(auth.uid(),''admin''))',
      'Admin escape ' || t, t);
  END LOOP;
END $$;

-- email_branding: drop old single-row admin policies, recreate per-workspace
DROP POLICY IF EXISTS "Admins can insert email branding" ON public.email_branding;
DROP POLICY IF EXISTS "Admins can update email branding" ON public.email_branding;
DROP POLICY IF EXISTS "Admins can view email branding" ON public.email_branding;
CREATE POLICY "Workspace members manage email_branding" ON public.email_branding FOR ALL TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid())) WITH CHECK (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Admin escape email_branding" ON public.email_branding FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin')) WITH CHECK (has_role(auth.uid(),'admin'));

-- site_footer_settings: enable RLS, public read + workspace manage
ALTER TABLE public.site_footer_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public can read footer settings" ON public.site_footer_settings;
CREATE POLICY "Public can read footer settings" ON public.site_footer_settings FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Workspace members manage site_footer_settings" ON public.site_footer_settings FOR ALL TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid())) WITH CHECK (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Admin escape site_footer_settings" ON public.site_footer_settings FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin')) WITH CHECK (has_role(auth.uid(),'admin'));

-- email_send_log: keep service-role policies, add workspace read + admin escape
CREATE POLICY "Workspace members read email_send_log" ON public.email_send_log FOR SELECT TO authenticated
  USING (workspace_id IS NOT NULL AND is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Admin escape email_send_log" ON public.email_send_log FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin')) WITH CHECK (has_role(auth.uid(),'admin'));

-- ============================================================================
-- Helper: resolve workspace by request host (for SSR site reads)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.current_workspace_id_by_host(_host text)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH normalized AS (
    SELECT lower(regexp_replace(regexp_replace(_host, ':\d+$', ''), '^www\.', '')) AS h
  )
  SELECT id FROM public.workspaces, normalized
   WHERE marketplace_domain = normalized.h
   LIMIT 1;
$$;
