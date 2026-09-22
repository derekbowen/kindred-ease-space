-- ROLLBACK for 20260923000200_sync_fanout_cron.sql
-- Restores the single pre-release job exactly as it was in production on
-- 2026-09-22 (jobid 9, name sharetribe-sync-30min, one POST with an empty
-- body). The dead job (jobid 5, "sync-sharetribe-30min", pointing at a
-- retired lovable.app host with a placeholder apikey) is NOT restored.
DO $$ BEGIN PERFORM cron.unschedule('sharetribe-sync-30min'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DROP FUNCTION IF EXISTS public.enqueue_sharetribe_syncs();
SELECT cron.schedule(
  'sharetribe-sync-30min',
  '*/30 * * * *',
  $job$
  SELECT net.http_post(
    url := 'https://www.founders.click/api/public/hooks/sync-sharetribe',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_secret()
    ),
    body := '{}'::jsonb
  );
  $job$
);
-- VERIFY (rolled back): exactly one row, command contains body := '{}'
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname LIKE '%sharetribe%';
