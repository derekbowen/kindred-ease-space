-- ============================================================================
-- MVP: A DEFERRED FEATURE RUNS NO BACKGROUND WORK (owner brief 2026-09-28).
--
-- The daily briefing is deferred with the rest of the Coach. Its nightly run
-- is the pg_cron job 'coach-briefing-nightly' (20260825122000): at 07:00 UTC
-- it POSTs to the coach-briefing-cron function, which makes one AI call per
-- workspace. The app's on-demand path is refused in the Worker
-- (assertFeatureAvailable("briefing"), src/lib/features.server.ts); this file
-- stops the scheduled one.
--
-- DEACTIVATED, NOT UNSCHEDULED: cron.alter_job(job_id, active := false)
-- keeps the job, its schedule and its command exactly as they are, so the
-- rollback is the same call with active := true.
--
-- ONLY that job. 'competitor-radar-daily' and 'daily-seo-digest' belong to
-- Pool Rental Near Me, another product on this database, and are never
-- touched here; neither is any other job ('sharetribe-sync-30min',
-- 'canonical-audit-daily', 'ai-reap-stale-reservations', …). No row of any
-- table is written or removed; stored briefings are kept.
--
-- Idempotent: an inactive job stays inactive, and when no job has that name a
-- NOTICE says so and nothing changes.
-- Rollback: supabase/rollback/20260929000300_mvp_deferred_jobs_rollback.sql
-- ============================================================================

-- What cron.job looked like before this file ran (this session only), so the
-- verification below can show that nothing else changed.
DROP TABLE IF EXISTS pg_temp.mvp_deferred_jobs_before;
CREATE TEMP TABLE mvp_deferred_jobs_before AS
  SELECT jobid, jobname, active FROM cron.job;

DO $mvp_deferred_jobs$
DECLARE
  v_job record;
BEGIN
  FOR v_job IN
    SELECT jobid, active FROM cron.job WHERE jobname = 'coach-briefing-nightly'
  LOOP
    IF v_job.active THEN
      PERFORM cron.alter_job(job_id := v_job.jobid, active := false);
      RAISE NOTICE 'coach-briefing-nightly (job %) deactivated', v_job.jobid;
    ELSE
      RAISE NOTICE 'coach-briefing-nightly (job %) was already inactive', v_job.jobid;
    END IF;
  END LOOP;
  IF NOT FOUND THEN
    RAISE NOTICE 'no job named coach-briefing-nightly; nothing to deactivate';
  END IF;
END
$mvp_deferred_jobs$;

-- VERIFY: every row should say true.
SELECT 'coach-briefing-nightly is not active' AS check,
       NOT EXISTS (SELECT 1 FROM cron.job
                    WHERE jobname = 'coach-briefing-nightly' AND active) AS ok
UNION ALL SELECT 'coach-briefing-nightly is kept for the rollback (deactivated, not unscheduled)',
       EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'coach-briefing-nightly')
       OR NOT EXISTS (SELECT 1 FROM mvp_deferred_jobs_before WHERE jobname = 'coach-briefing-nightly')
UNION ALL SELECT 'no other job changed (PRNM''s competitor-radar-daily and daily-seo-digest included)',
       NOT EXISTS (
         SELECT 1 FROM mvp_deferred_jobs_before b
          FULL JOIN cron.job j ON j.jobid = b.jobid
          WHERE COALESCE(j.jobname, b.jobname) IS DISTINCT FROM 'coach-briefing-nightly'
            AND (j.jobid IS NULL OR b.jobid IS NULL OR j.active IS DISTINCT FROM b.active)
       );
