-- Scheduled Sharetribe sync: fan out one request per workspace.
--
-- Before: two overlapping pg_cron jobs ('sharetribe-sync-30min' from
-- 20260825122000 and a hand-created 'sync-sharetribe-30min') each POSTed an
-- empty body to the sync hook, which then synced EVERY connected workspace
-- sequentially inside one Cloudflare Worker request. That put the whole fleet
-- behind one request's subrequest budget: as tenants were added, the tail of
-- the loop simply never ran.
--
-- After: a single job every 30 minutes calls enqueue_sharetribe_syncs(), which
-- issues one net.http_post per connected workspace with {"workspace_id": ...}.
-- Each Worker request then does one tenant's worth of work. pg_net queues the
-- requests asynchronously, so the cron tick itself stays fast.
--
-- The hook's empty-body mode still exists but is now capped at a few
-- workspaces per call, oldest sync first — a safety net, not the schedule.
--
-- Operational prerequisite (unchanged from 20260825122000): the shared secret
-- must exist in Vault as 'CRON_SECRET' and match the app's CRON_SECRET env.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.enqueue_sharetribe_syncs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
DECLARE
  v_secret text;
  v_row record;
  v_count integer := 0;
BEGIN
  v_secret := public._cron_secret();
  IF v_secret IS NULL THEN
    -- Without the secret every request would 401/500 at the hook. Skip the
    -- whole tick rather than spam the app 2× per hour per tenant.
    RAISE NOTICE 'enqueue_sharetribe_syncs: CRON_SECRET missing from Vault; skipping';
    RETURN 0;
  END IF;

  FOR v_row IN
    SELECT workspace_id
      FROM public.tenant_integrations
     WHERE provider = 'sharetribe'
       AND status IN ('connected', 'pending')
     ORDER BY last_sync_at ASC NULLS FIRST
  LOOP
    PERFORM net.http_post(
      url := 'https://www.founders.click/api/public/hooks/sync-sharetribe',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_secret
      ),
      body := jsonb_build_object('workspace_id', v_row.workspace_id),
      -- pg_net's default is 5 s. One tenant's sync takes longer than that
      -- as soon as it has a real catalogue (125 listings: ~6 s in production
      -- on 2026-09-25), so every response was recorded as a timeout and the
      -- caller hung up while the Worker was still writing. Two minutes covers
      -- the hook's own bounded work; the request stays asynchronous, so the
      -- cron tick itself is not held up.
      timeout_milliseconds := 120000
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_sharetribe_syncs() FROM public, anon, authenticated;

-- Replace BOTH prior schedules with the single fan-out job (idempotent).
DO $$ BEGIN PERFORM cron.unschedule('sharetribe-sync-30min'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM cron.unschedule('sync-sharetribe-30min'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'sharetribe-sync-30min',
  '*/30 * * * *',
  $CRON$ SELECT public.enqueue_sharetribe_syncs(); $CRON$
);

-- Verification: every row should say true.
SELECT 'enqueue function exists' AS check,
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'enqueue_sharetribe_syncs') AS ok
UNION ALL SELECT 'exactly one sharetribe cron job',
       (SELECT count(*) = 1 FROM cron.job WHERE jobname ILIKE '%sharetribe%')
UNION ALL SELECT 'fan-out job scheduled',
       EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sharetribe-sync-30min'
                 AND command ILIKE '%enqueue_sharetribe_syncs%');
