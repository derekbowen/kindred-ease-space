-- ROLLBACK for 20260923000300_generation_jobs.sql
-- Drops the batch-generation bookkeeping. Pages already published from a job
-- live in tenant_pages and are NOT touched. platform_settings is dropped only
-- if it still holds nothing but the two seeded generation keys.
BEGIN;
DROP TABLE IF EXISTS public.generation_items;
DROP TABLE IF EXISTS public.generation_jobs;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.platform_settings WHERE key NOT IN ('generation_paused','generation_daily_cap')) THEN
    DROP TABLE public.platform_settings;
  END IF;
END $$;
COMMIT;
-- VERIFY (rolled back): expect 0 rows
SELECT table_name FROM information_schema.tables
 WHERE table_schema='public' AND table_name IN ('generation_jobs','generation_items');
