-- ROLLBACK for 20260923000300_generation_jobs.sql
-- Drops the batch-generation bookkeeping. Pages already published from a job
-- live in tenant_pages and are NOT touched. platform_settings is dropped only
-- if it still holds nothing but the two seeded generation keys.
BEGIN;
DROP TABLE IF EXISTS public.generation_items;
DROP TABLE IF EXISTS public.generation_jobs;
-- The Quick Page idempotency / daily-cap ledger column on tenant_pages.
-- Dropping it forgets WHICH pages were AI-generated; the pages themselves
-- are untouched.
DROP INDEX IF EXISTS public.tenant_pages_generation_request_uidx;
DROP INDEX IF EXISTS public.tenant_pages_generated_created_idx;
ALTER TABLE public.tenant_pages DROP COLUMN IF EXISTS generation_request_id;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.platform_settings WHERE key NOT IN ('generation_paused','generation_daily_cap')) THEN
    DROP TABLE public.platform_settings;
  END IF;
END $$;
COMMIT;
-- VERIFY (rolled back): expect 0 rows
SELECT table_name AS leftover FROM information_schema.tables
 WHERE table_schema='public' AND table_name IN ('generation_jobs','generation_items')
UNION ALL
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='tenant_pages' AND column_name='generation_request_id';
