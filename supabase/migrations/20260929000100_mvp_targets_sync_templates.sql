-- ============================================================================
-- MVP: ONE PAGE TARGET, A COMPLETE LISTING SYNC, THREE REAL TEMPLATES
-- (owner brief 2026-09-28). Additive and idempotent; no data is removed.
--
-- 1. tenant_listings: comparison keys (country/region/city/category), written
--    by the sync from src/lib/coverage/target.ts (the ONE normalization), plus
--    the listing's pricing unit. Rows synced before this file have NULL keys
--    until their next sync (every 30 minutes, or "Sync now").
-- 2. tenant_integrations: a sync lease (one run per workspace at a time),
--    progress, the last SUCCESSFUL sync, the upstream total, and sync state
--    (confirmed-empty strikes). Lease/progress/reconcile go through
--    service-role functions so the lease check and the stale-row delete are
--    one transaction.
-- 3. tenant_pages: seo_title (the <title> the writer produced — no longer
--    discarded), target_key (the page's inventory identity) with a partial
--    unique index so one intended page exists once per workspace (archived
--    pages excepted), noindex, content_version (optimistic concurrency for
--    edits), generation (draft-first generation state), and a status CHECK.
-- 4. page_templates: Category Page and Resource Article become active with
--    their real contracts (src/lib/templates/contracts.ts); City Hub's
--    contract is replaced. The other placeholders stay inactive.
-- 5. coverage_dismissals: an opportunity the customer dismissed.
-- 6. inventory_coverage_groups(): published inventory grouped by target keys
--    — the exact totals the Opportunities screen reports.
-- 7. workspace_domains.sitemap_check: the last explicit sitemap validation.
--
-- Rollback: supabase/rollback/20260929000100_mvp_targets_sync_templates_rollback.sql
-- ============================================================================

-- 1) tenant_listings ----------------------------------------------------------
ALTER TABLE public.tenant_listings
  ADD COLUMN IF NOT EXISTS country_key text,
  ADD COLUMN IF NOT EXISTS region_key text,
  ADD COLUMN IF NOT EXISTS city_key text,
  ADD COLUMN IF NOT EXISTS category_key text,
  ADD COLUMN IF NOT EXISTS price_unit text;

CREATE INDEX IF NOT EXISTS tenant_listings_place_key_idx
  ON public.tenant_listings (workspace_id, city_key, region_key, country_key)
  WHERE state_published;
CREATE INDEX IF NOT EXISTS tenant_listings_category_key_idx
  ON public.tenant_listings (workspace_id, category_key)
  WHERE state_published;
CREATE INDEX IF NOT EXISTS tenant_listings_workspace_synced_idx
  ON public.tenant_listings (workspace_id, synced_at);

-- 2) tenant_integrations --------------------------------------------------------
ALTER TABLE public.tenant_integrations
  ADD COLUMN IF NOT EXISTS last_success_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_run_id uuid,
  ADD COLUMN IF NOT EXISTS sync_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS sync_progress jsonb,
  ADD COLUMN IF NOT EXISTS upstream_total integer,
  ADD COLUMN IF NOT EXISTS sync_state jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Take the workspace's sync lease: true when this run may sync now.
CREATE OR REPLACE FUNCTION public.claim_listing_sync(
  _workspace_id uuid, _run_id uuid, _lease_seconds integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF _workspace_id IS NULL OR _run_id IS NULL THEN
    RAISE EXCEPTION 'claim_listing_sync: missing argument' USING ERRCODE = '22023';
  END IF;
  UPDATE public.tenant_integrations
     SET sync_run_id = _run_id,
         sync_started_at = now(),
         sync_lease_until = now() + make_interval(secs => GREATEST(30, LEAST(COALESCE(_lease_seconds, 300), 900))),
         sync_progress = jsonb_build_object('phase', 'starting', 'pages', 0, 'fetched', 0),
         updated_at = now()
   WHERE workspace_id = _workspace_id
     AND provider = 'sharetribe'
     AND (sync_lease_until IS NULL OR sync_lease_until < now());
  RETURN FOUND;
END $$;

-- Report progress and extend the lease; false = the lease was lost (another
-- run took over, or the connection is gone) and the caller must stop.
CREATE OR REPLACE FUNCTION public.touch_listing_sync(
  _workspace_id uuid, _run_id uuid, _progress jsonb, _lease_seconds integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.tenant_integrations
     SET sync_progress = COALESCE(_progress, sync_progress),
         sync_lease_until = now() + make_interval(secs => GREATEST(30, LEAST(COALESCE(_lease_seconds, 300), 900))),
         updated_at = now()
   WHERE workspace_id = _workspace_id
     AND provider = 'sharetribe'
     AND sync_run_id = _run_id
     AND sync_lease_until IS NOT NULL
     AND sync_lease_until >= now();
  RETURN FOUND;
END $$;

-- After a COMPLETE upstream snapshot: remove this workspace's listings that the
-- snapshot did not contain (not re-stamped by this run), under the lease, in
-- one statement — no id list, no row cap. Returns the number removed, or -1
-- when this run no longer holds the lease (nothing is removed).
CREATE OR REPLACE FUNCTION public.reconcile_listing_sync(
  _workspace_id uuid, _run_id uuid, _run_started_at timestamptz
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_removed integer;
BEGIN
  PERFORM 1 FROM public.tenant_integrations
   WHERE workspace_id = _workspace_id AND provider = 'sharetribe'
     AND sync_run_id = _run_id AND sync_lease_until >= now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN -1;
  END IF;
  DELETE FROM public.tenant_listings
   WHERE workspace_id = _workspace_id
     AND synced_at < _run_started_at;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END $$;

-- End the run: release the lease and record the outcome in one write.
CREATE OR REPLACE FUNCTION public.finish_listing_sync(
  _workspace_id uuid, _run_id uuid, _outcome jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ok boolean := COALESCE((_outcome ->> 'success')::boolean, false);
BEGIN
  UPDATE public.tenant_integrations
     SET sync_lease_until = NULL,
         sync_progress = COALESCE(_outcome -> 'progress', sync_progress),
         last_sync_at = now(),
         last_sync_status = COALESCE(_outcome ->> 'status', last_sync_status),
         last_sync_error = CASE WHEN _outcome ? 'error' THEN _outcome ->> 'error' ELSE last_sync_error END,
         last_success_at = CASE WHEN v_ok THEN now() ELSE last_success_at END,
         listings_count = COALESCE((_outcome ->> 'listings_count')::integer, listings_count),
         upstream_total = COALESCE((_outcome ->> 'upstream_total')::integer, upstream_total),
         sync_state = COALESCE(_outcome -> 'sync_state', sync_state),
         status = COALESCE(_outcome ->> 'connection_status', status),
         updated_at = now()
   WHERE workspace_id = _workspace_id
     AND provider = 'sharetribe'
     AND sync_run_id = _run_id;
  RETURN FOUND;
END $$;

-- 3) tenant_pages ---------------------------------------------------------------
ALTER TABLE public.tenant_pages
  ADD COLUMN IF NOT EXISTS seo_title text,
  ADD COLUMN IF NOT EXISTS target_key text,
  ADD COLUMN IF NOT EXISTS noindex boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS content_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS generation jsonb;

-- One live page per intended target: a second request for the same page
-- (a double click, two tabs, the batch and the builder at once) meets this
-- index before any provider is paid, and gets the existing draft instead.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_pages_live_target_uidx
  ON public.tenant_pages (workspace_id, target_key)
  WHERE target_key IS NOT NULL AND status <> 'archived';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.tenant_pages'::regclass AND conname = 'tenant_pages_status_check'
  ) THEN
    ALTER TABLE public.tenant_pages
      ADD CONSTRAINT tenant_pages_status_check
      CHECK (status IN ('draft', 'published', 'archived', 'billing_suspended')) NOT VALID;
    ALTER TABLE public.tenant_pages VALIDATE CONSTRAINT tenant_pages_status_check;
  END IF;
END $$;

-- 4) page_templates ---------------------------------------------------------------
UPDATE public.page_templates
   SET name = 'City Hub',
       description = 'A landing page for one city, with that city''s live listings.',
       is_active = true,
       config_schema = '{"version":1,"kind":"city_hub","required_scope":["country","region","city"],"whole_place":true,"requires_listings":true,"min_body_chars":300,"sections":["hero","intro","listing_grid","body","related_pages"]}'::jsonb
 WHERE slug = 'city_hub';
UPDATE public.page_templates
   SET name = 'Category Page',
       description = 'A page for one category, with its live listings.',
       is_active = true,
       config_schema = '{"version":1,"kind":"category_page","required_scope":["category"],"whole_place":true,"requires_listings":true,"min_body_chars":300,"sections":["hero","intro","listing_grid","body","related_pages"]}'::jsonb
 WHERE slug = 'category_page';
UPDATE public.page_templates
   SET name = 'Resource Article',
       description = 'A useful guide written from your marketplace''s data, linking to your marketplace and your other pages.',
       is_active = true,
       config_schema = '{"version":1,"kind":"resource_article","required_scope":[],"whole_place":true,"requires_listings":false,"min_body_chars":600,"sections":["hero","body","related_listings","cta","related_pages"]}'::jsonb
 WHERE slug = 'resource_article';

-- 5) coverage_dismissals ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.coverage_dismissals (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  target_key text NOT NULL CHECK (char_length(target_key) BETWEEN 3 AND 400),
  dismissed_by uuid,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, target_key)
);
ALTER TABLE public.coverage_dismissals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coverage_dismissals FROM anon, authenticated;

-- 6) inventory_coverage_groups ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inventory_coverage_groups(_workspace_id uuid)
RETURNS TABLE (
  country_key text, region_key text, city_key text, category_key text,
  country text, region text, city text, category text,
  listing_count bigint, priced_count bigint,
  currencies text[], price_units text[],
  unkeyed_count bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT l.country_key, l.region_key, l.city_key, l.category_key,
         min(l.country), min(l.state), min(l.city), min(l.category),
         count(*)::bigint,
         count(l.price_amount)::bigint,
         COALESCE(array_agg(DISTINCT l.price_currency) FILTER (WHERE l.price_currency IS NOT NULL), '{}'),
         COALESCE(array_agg(DISTINCT l.price_unit) FILTER (WHERE l.price_unit IS NOT NULL), '{}'),
         count(*) FILTER (WHERE (l.city IS NOT NULL AND btrim(l.city) <> '' AND l.city_key IS NULL)
                             OR (l.category IS NOT NULL AND btrim(l.category) <> '' AND l.category_key IS NULL))::bigint
    FROM public.tenant_listings l
   WHERE l.workspace_id = _workspace_id
     AND l.state_published
   GROUP BY l.country_key, l.region_key, l.city_key, l.category_key
$$;

-- 7) workspace_domains -------------------------------------------------------------
ALTER TABLE public.workspace_domains
  ADD COLUMN IF NOT EXISTS sitemap_check jsonb;

-- Privileges: service role only ----------------------------------------------------
DO $$
DECLARE sig text;
BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'public.claim_listing_sync(uuid, uuid, integer)',
    'public.touch_listing_sync(uuid, uuid, jsonb, integer)',
    'public.reconcile_listing_sync(uuid, uuid, timestamptz)',
    'public.finish_listing_sync(uuid, uuid, jsonb)',
    'public.inventory_coverage_groups(uuid)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
  END LOOP;
END $$;

-- Verification: every row should read true.
SELECT 'tenant_listings has the four keys and price_unit' AS check,
       (SELECT count(*) = 5 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'tenant_listings'
           AND column_name IN ('country_key','region_key','city_key','category_key','price_unit')) AS ok
UNION ALL SELECT 'tenant_integrations has the sync lease columns',
       (SELECT count(*) = 7 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'tenant_integrations'
           AND column_name IN ('last_success_at','sync_run_id','sync_started_at','sync_lease_until','sync_progress','upstream_total','sync_state'))
UNION ALL SELECT 'tenant_pages has seo_title, target_key, noindex, content_version, generation',
       (SELECT count(*) = 5 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'tenant_pages'
           AND column_name IN ('seo_title','target_key','noindex','content_version','generation'))
UNION ALL SELECT 'one live page per target (partial unique index)',
       EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'tenant_pages_live_target_uidx')
UNION ALL SELECT 'tenant_pages status is checked',
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_pages_status_check' AND convalidated)
UNION ALL SELECT 'the three MVP templates are active, the rest are not',
       (SELECT array_agg(slug ORDER BY slug) FROM public.page_templates WHERE is_active)
         = ARRAY['category_page','city_hub','resource_article']
UNION ALL SELECT 'coverage_dismissals exists with RLS on',
       COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.coverage_dismissals'::regclass), false)
UNION ALL SELECT 'the sync and coverage functions are service-role only',
       NOT has_function_privilege('authenticated', 'public.claim_listing_sync(uuid, uuid, integer)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.inventory_coverage_groups(uuid)', 'EXECUTE')
       AND has_function_privilege('service_role', 'public.reconcile_listing_sync(uuid, uuid, timestamptz)', 'EXECUTE')
UNION ALL SELECT 'workspace_domains has sitemap_check',
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                AND table_name = 'workspace_domains' AND column_name = 'sitemap_check');
