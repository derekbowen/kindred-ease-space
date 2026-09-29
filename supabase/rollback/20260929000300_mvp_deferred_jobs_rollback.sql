-- ROLLBACK for 20260929000300_mvp_deferred_jobs.sql
--
-- Reactivates the pg_cron job 'coach-briefing-nightly' — same schedule, same
-- command (the migration only set active := false). Touches no other job:
-- PRNM's 'competitor-radar-daily' and 'daily-seo-digest' are never read or
-- written here. A missing job is not recreated (20260825122000 defines it).
--
-- Run it only together with turning the briefing back on in the app
-- (platform_settings.enabled_deferred_features must list "briefing", see
-- src/lib/features.server.ts); otherwise the nightly run spends AI money on
-- briefings no screen shows.

DROP TABLE IF EXISTS pg_temp.mvp_deferred_jobs_rollback_before;
CREATE TEMP TABLE mvp_deferred_jobs_rollback_before AS
  SELECT jobid, jobname, active FROM cron.job;

DO $mvp_deferred_jobs_rollback$
DECLARE
  v_job record;
BEGIN
  FOR v_job IN
    SELECT jobid, active FROM cron.job WHERE jobname = 'coach-briefing-nightly'
  LOOP
    IF NOT v_job.active THEN
      PERFORM cron.alter_job(job_id := v_job.jobid, active := true);
      RAISE NOTICE 'coach-briefing-nightly (job %) reactivated', v_job.jobid;
    END IF;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE 'no job named coach-briefing-nightly; nothing to reactivate';
  END IF;
END
$mvp_deferred_jobs_rollback$;

-- VERIFY: every row should say true.
SELECT 'coach-briefing-nightly is active again (or does not exist)' AS check,
       NOT EXISTS (SELECT 1 FROM cron.job
                    WHERE jobname = 'coach-briefing-nightly' AND NOT active) AS ok
UNION ALL SELECT 'no other job changed',
       NOT EXISTS (
         SELECT 1 FROM mvp_deferred_jobs_rollback_before b
          FULL JOIN cron.job j ON j.jobid = b.jobid
          WHERE COALESCE(j.jobname, b.jobname) IS DISTINCT FROM 'coach-briefing-nightly'
            AND (j.jobid IS NULL OR b.jobid IS NULL OR j.active IS DISTINCT FROM b.active)
       );
