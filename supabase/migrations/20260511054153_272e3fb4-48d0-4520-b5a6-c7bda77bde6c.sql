SELECT cron.schedule(
  'canonical-audit-daily',
  '0 6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://project--1e32d901-e1cf-436a-ad20-853b1177ad2e.lovable.app/api/public/hooks/canonical-audit',
    headers := '{"Content-Type": "application/json", "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhieGh6aW5uZmhvc296dHFhYWFvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzODU1ODMsImV4cCI6MjA5Mzk2MTU4M30.SyvCaO_bMDrGnlFgkAorYu6ArL2mVJlSOFbr1XRQABU"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);