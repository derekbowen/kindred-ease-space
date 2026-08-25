-- Fix the scheduled jobs found broken in the pre-launch audit and add the
-- missing Sharetribe sync job the welcome email promises ("~every 30 minutes").
--
-- Root causes fixed:
--   * coach-briefing-nightly sent only the anon apikey; coach-briefing-cron now
--     requires the `x-cron-secret` header → every run was 401.
--   * canonical-audit-daily targeted a stale project--*.lovable.app URL with
--     anon-key auth; the hook now requires `Authorization: Bearer <CRON_SECRET>`.
--   * No Sharetribe sync job existed at all.
--
-- The shared secret is read from Vault at run time via _cron_secret(), so no
-- secret is committed to git. REQUIRED OPERATIONAL SETUP before these work:
--   1) Store the secret in Vault:
--        select vault.create_secret('<random-strong-secret>', 'CRON_SECRET');
--   2) Set the SAME value as the CRON_SECRET env var on the app (Cloudflare) and
--      on the coach-briefing-cron edge function.
--   3) Confirm APP_ORIGIN below matches the deployed app host.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Reads the cron secret from Vault (null-safe). SECURITY DEFINER so the cron
-- role can resolve it without direct vault grants.
CREATE OR REPLACE FUNCTION public._cron_secret()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = vault, public
AS $$
  SELECT decrypted_secret
    FROM vault.decrypted_secrets
   WHERE name = 'CRON_SECRET'
   LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public._cron_secret() FROM public, anon, authenticated;

-- Clear any prior schedules (idempotent).
DO $$ BEGIN PERFORM cron.unschedule('coach-briefing-nightly'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM cron.unschedule('canonical-audit-daily'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM cron.unschedule('sharetribe-sync-30min'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- 1) Coach briefings — daily 07:00 UTC, edge function, x-cron-secret header.
SELECT cron.schedule(
  'coach-briefing-nightly',
  '0 7 * * *',
  $CRON$
  SELECT net.http_post(
    url := 'https://xbxhzinnfhosoztqaaao.supabase.co/functions/v1/coach-briefing-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', public._cron_secret()
    ),
    body := '{}'::jsonb
  );
  $CRON$
);

-- 2) Canonical URL audit — daily 06:00 UTC, app hook, Bearer CRON_SECRET.
SELECT cron.schedule(
  'canonical-audit-daily',
  '0 6 * * *',
  $CRON$
  SELECT net.http_post(
    url := 'https://www.founders.click/api/public/hooks/canonical-audit',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_secret()
    ),
    body := '{}'::jsonb
  );
  $CRON$
);

-- 3) Sharetribe sync — every 30 minutes, app hook, Bearer CRON_SECRET. Runs all
--    connected workspaces (empty body => runSharetribeSyncAll).
SELECT cron.schedule(
  'sharetribe-sync-30min',
  '*/30 * * * *',
  $CRON$
  SELECT net.http_post(
    url := 'https://www.founders.click/api/public/hooks/sync-sharetribe',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public._cron_secret()
    ),
    body := '{}'::jsonb
  );
  $CRON$
);
