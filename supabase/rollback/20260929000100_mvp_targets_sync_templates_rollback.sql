-- ROLLBACK for 20260929000100_mvp_targets_sync_templates.sql
--
-- Normally unnecessary: the previous app build ignores every column and
-- function this migration adds (roll back the Worker and main only). Use this
-- only for an incident the schema itself caused.
--
-- What it undoes, in reverse order:
--   7. workspace_domains.sitemap_check             (column dropped)
--   6. inventory_coverage_groups()                 (dropped)
--   5. coverage_dismissals                         (dropped — dismissals are lost)
--   4. page_templates: category_page and resource_article inactive again
--      (config_schema is left as written; the old app never read it)
--   3. tenant_pages: the live-target index and status CHECK dropped; the new
--      columns are dropped (seo_title, target_key, noindex, content_version,
--      generation) — seo_title text written by the new app is lost
--   2. tenant_integrations: the sync functions and lease columns dropped
--   1. tenant_listings: the key/price-unit columns and their indexes dropped
--      (they are rebuilt by the next sync if the migration is re-applied)
BEGIN;

ALTER TABLE public.workspace_domains DROP COLUMN IF EXISTS sitemap_check;

DROP FUNCTION IF EXISTS public.inventory_coverage_groups(uuid);
DROP TABLE IF EXISTS public.coverage_dismissals;

UPDATE public.page_templates SET is_active = false WHERE slug IN ('category_page', 'resource_article');

DROP INDEX IF EXISTS public.tenant_pages_live_target_uidx;
ALTER TABLE public.tenant_pages DROP CONSTRAINT IF EXISTS tenant_pages_status_check;
ALTER TABLE public.tenant_pages
  DROP COLUMN IF EXISTS seo_title,
  DROP COLUMN IF EXISTS target_key,
  DROP COLUMN IF EXISTS noindex,
  DROP COLUMN IF EXISTS content_version,
  DROP COLUMN IF EXISTS generation;

DROP FUNCTION IF EXISTS public.finish_listing_sync(uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.reconcile_listing_sync(uuid, uuid, timestamptz);
DROP FUNCTION IF EXISTS public.touch_listing_sync(uuid, uuid, jsonb, integer);
DROP FUNCTION IF EXISTS public.claim_listing_sync(uuid, uuid, integer);
ALTER TABLE public.tenant_integrations
  DROP COLUMN IF EXISTS last_success_at,
  DROP COLUMN IF EXISTS sync_run_id,
  DROP COLUMN IF EXISTS sync_started_at,
  DROP COLUMN IF EXISTS sync_lease_until,
  DROP COLUMN IF EXISTS sync_progress,
  DROP COLUMN IF EXISTS upstream_total,
  DROP COLUMN IF EXISTS sync_state;

DROP INDEX IF EXISTS public.tenant_listings_place_key_idx;
DROP INDEX IF EXISTS public.tenant_listings_category_key_idx;
DROP INDEX IF EXISTS public.tenant_listings_workspace_synced_idx;
ALTER TABLE public.tenant_listings
  DROP COLUMN IF EXISTS country_key,
  DROP COLUMN IF EXISTS region_key,
  DROP COLUMN IF EXISTS city_key,
  DROP COLUMN IF EXISTS category_key,
  DROP COLUMN IF EXISTS price_unit;

COMMIT;

-- VERIFY (rolled back): every row should read true.
SELECT 'listing keys gone' AS check,
       NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                    AND table_name = 'tenant_listings' AND column_name = 'city_key') AS ok
UNION ALL SELECT 'sync functions gone', to_regprocedure('public.claim_listing_sync(uuid, uuid, integer)') IS NULL
UNION ALL SELECT 'page columns gone',
       NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                    AND table_name = 'tenant_pages' AND column_name IN ('seo_title', 'target_key'))
UNION ALL SELECT 'only City Hub active',
       (SELECT array_agg(slug) FROM public.page_templates WHERE is_active) = ARRAY['city_hub'];
