-- Ensure cron + net are available
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Replace any prior schedule of this job
DO $$
BEGIN
  PERFORM cron.unschedule('coach-briefing-nightly');
EXCEPTION WHEN OTHERS THEN NULL;
END$$;

SELECT cron.schedule(
  'coach-briefing-nightly',
  '0 7 * * *', -- 07:00 UTC daily (~midnight PT / 3am ET)
  $$
  SELECT net.http_post(
    url := 'https://xbxhzinnfhosoztqaaao.supabase.co/functions/v1/coach-briefing-cron',
    headers := '{"Content-Type":"application/json","apikey":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhieGh6aW5uZmhvc296dHFhYWFvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzODU1ODMsImV4cCI6MjA5Mzk2MTU4M30.SyvCaO_bMDrGnlFgkAorYu6ArL2mVJlSOFbr1XRQABU","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhieGh6aW5uZmhvc296dHFhYWFvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzODU1ODMsImV4cCI6MjA5Mzk2MTU4M30.SyvCaO_bMDrGnlFgkAorYu6ArL2mVJlSOFbr1XRQABU"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);