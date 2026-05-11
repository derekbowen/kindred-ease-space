
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
  'competitor-radar-daily',
  '0 8 * * *',
  $$
  SELECT net.http_post(
    url := 'https://fresh-web.lovable.app/api/public/hooks/competitor-radar-scan',
    headers := '{"Content-Type": "application/json", "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0ZmpzcGNwaHNraWZvc2VpZHV0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2OTE1MjIsImV4cCI6MjA5MzI2NzUyMn0.ZHv5kA9v8noYXMHi55-WUM1r0QHpORci-yywtcPDPDQ"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
