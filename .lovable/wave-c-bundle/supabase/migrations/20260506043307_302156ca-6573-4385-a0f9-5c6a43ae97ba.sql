CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Unschedule if exists (idempotent)
DO $$
DECLARE
  job_id bigint;
BEGIN
  SELECT jobid INTO job_id FROM cron.job WHERE jobname = 'daily-seo-digest';
  IF job_id IS NOT NULL THEN
    PERFORM cron.unschedule(job_id);
  END IF;
END $$;

-- Schedule: every day at 12:00 UTC (8am ET)
SELECT cron.schedule(
  'daily-seo-digest',
  '0 12 * * *',
  $$
  SELECT net.http_post(
    url := 'https://project--4831238c-ae4b-468a-bfd8-41cba26ba0b1.lovable.app/api/public/hooks/daily-seo-digest',
    headers := '{"Content-Type": "application/json", "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0ZmpzcGNwaHNraWZvc2VpZHV0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2OTE1MjIsImV4cCI6MjA5MzI2NzUyMn0.ZHv5kA9v8noYXMHi55-WUM1r0QHpORci-yywtcPDPDQ"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);