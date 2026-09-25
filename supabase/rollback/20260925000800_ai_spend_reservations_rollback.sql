-- ROLLBACK for 20260925000800_ai_spend_reservations.sql
--
-- PAIR THIS WITH A CODE ROLLBACK. The build shipped with 000800 reserves,
-- marks, settles and releases every AI call through ai_reserve /
-- ai_mark_called / ai_settle / ai_release; with this file applied and that
-- build still deployed, every AI request fails at the reservation (fail
-- closed: nothing is called). Redeploy the previous Worker version FIRST, and
-- the previous coach-briefing-cron, then run this file.
--
-- What it does, in order:
--   1. Ends every open hold so no customer money stays locked: a held
--      reservation (provider never called) is released with a full refund; a
--      called one is settled at the full hold on the platform budget (the
--      provider may have been paid) with the customer refunded. Same
--      functions the reaper uses.
--   2. Unschedules the reaper and drops the ai_* functions, the reservation,
--      budget, settings and briefing-claim tables, and the ledger index.
--   3. Restores what 000800 superseded and the previous build calls:
--      settle_generation_free_quota and credit_ledger_generation_settlement_uidx
--      (the 000600 bodies, verbatim).
--
-- What it keeps: the ai_hold / ai_refund rows in credit_ledger and the
-- ai_usage_log rows (history). What it forgets: the per-request spend record
-- (ai_spend_reservations) and the day's ceiling ledger — a later re-apply of
-- 000800 starts both from zero. The kill switch's setting is lost with its
-- table (re-applying seeds it ON, $10.00/day).
BEGIN;

-- 1) Close every open hold ------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  IF to_regclass('public.ai_spend_reservations') IS NULL THEN
    RETURN;
  END IF;
  FOR r IN SELECT workspace_id, request_id, status FROM public.ai_spend_reservations
            WHERE status IN ('held','called') ORDER BY workspace_id, request_id LOOP
    PERFORM pg_advisory_xact_lock(hashtext('ai_spend:' || r.workspace_id::text));
    IF r.status = 'held' THEN
      PERFORM public._ai_release_row(r.workspace_id, r.request_id, 'rollback');
    ELSE
      PERFORM public._ai_settle_row(r.workspace_id, r.request_id, NULL, NULL, NULL, NULL, NULL, NULL,
                                    'failed', 'rollback', 'rollback_full_hold');
    END IF;
  END LOOP;
END $$;

-- 2) Drop 000800 -------------------------------------------------------------------
DO $$ BEGIN PERFORM cron.unschedule('ai-reap-stale-reservations'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DROP FUNCTION IF EXISTS public.ai_reap_stale_reservations();
DROP FUNCTION IF EXISTS public.ai_release(uuid, uuid);
DROP FUNCTION IF EXISTS public.ai_settle(uuid, uuid, int, int, int, int, bigint, int, text, text);
DROP FUNCTION IF EXISTS public.ai_mark_called(uuid, uuid);
DROP FUNCTION IF EXISTS public.ai_reserve(uuid, uuid, uuid, text, text, text, int, int, bigint, int, text);
DROP FUNCTION IF EXISTS public._ai_expire_workspace(uuid);
DROP FUNCTION IF EXISTS public._ai_settle_row(uuid, uuid, int, int, int, int, bigint, int, text, text, text);
DROP FUNCTION IF EXISTS public._ai_release_row(uuid, uuid, text);
DROP FUNCTION IF EXISTS public._ai_generation_paused();
DROP FUNCTION IF EXISTS public.coach_briefing_store(uuid, date, uuid, jsonb);
DROP FUNCTION IF EXISTS public.coach_briefing_claim(uuid, date, uuid);
DROP TABLE IF EXISTS public.coach_briefing_claims;
DROP TABLE IF EXISTS public.ai_spend_reservations;
DROP TABLE IF EXISTS public.ai_budget_days;
DROP TABLE IF EXISTS public.ai_platform_settings;
DROP INDEX IF EXISTS public.credit_ledger_ai_spend_uidx;

-- 3) Restore what 000800 superseded (000600, verbatim) ------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_generation_settlement_uidx
  ON public.credit_ledger (workspace_id, ref_id)
  WHERE reason = 'ai_usage'
    AND ref_type IN ('batch_generation','quick_page')
    AND ref_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.settle_generation_free_quota(
  _workspace_id uuid,
  _ref_type text,
  _ref_id text,
  _ai_model text DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_remaining int;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF _ref_type IS NULL OR _ref_type NOT IN ('batch_generation','quick_page') THEN
    RAISE EXCEPTION 'settle_generation_free_quota: ref_type must be batch_generation or quick_page'
      USING ERRCODE = '22023';
  END IF;
  IF _ref_id IS NULL THEN
    RAISE EXCEPTION 'settle_generation_free_quota: ref_id is required'
      USING ERRCODE = '22023';
  END IF;

  -- The settlement record, first.
  INSERT INTO public.credit_ledger (workspace_id, delta, reason, ai_model, ref_type, ref_id, metadata)
  VALUES (
    _workspace_id, 0, 'ai_usage', _ai_model, _ref_type, _ref_id,
    jsonb_build_object('provider', 'platform', 'billing', 'free_quota', 'feature', _ref_type)
  );

  INSERT INTO public.workspace_ai_quota (workspace_id) VALUES (_workspace_id)
  ON CONFLICT (workspace_id) DO NOTHING;

  UPDATE public.workspace_ai_quota
    SET platform_credits_remaining = platform_credits_remaining - 1,
        lifetime_platform_used = lifetime_platform_used + 1
    WHERE workspace_id = _workspace_id
      AND platform_credits_remaining > 0
    RETURNING platform_credits_remaining INTO v_remaining;

  IF v_remaining IS NULL THEN
    -- Rolls the ledger row back with it: the page is not settled yet.
    RAISE EXCEPTION 'platform_ai_quota_exhausted' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_remaining;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.settle_generation_free_quota(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_generation_free_quota(uuid, text, text, text) TO service_role;
COMMIT;

-- VERIFY (rolled back): expect exactly two rows, both restored objects:
--   'restored settle_generation_free_quota' and 'restored credit_ledger_generation_settlement_uidx'
SELECT 'leftover function ' || p.proname AS item
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('ai_reserve','ai_mark_called','ai_settle','ai_release','ai_reap_stale_reservations',
                     '_ai_generation_paused','_ai_release_row','_ai_settle_row','_ai_expire_workspace',
                     'coach_briefing_claim','coach_briefing_store')
UNION ALL
SELECT 'leftover table ' || table_name FROM information_schema.tables
 WHERE table_schema = 'public'
   AND table_name IN ('ai_spend_reservations','ai_budget_days','ai_platform_settings','coach_briefing_claims')
UNION ALL
SELECT 'leftover index ' || indexname FROM pg_indexes
 WHERE schemaname = 'public' AND indexname = 'credit_ledger_ai_spend_uidx'
UNION ALL
SELECT 'leftover cron job ' || jobname FROM cron.job WHERE jobname = 'ai-reap-stale-reservations'
UNION ALL
SELECT 'restored settle_generation_free_quota'
 WHERE to_regprocedure('public.settle_generation_free_quota(uuid,text,text,text)') IS NOT NULL
UNION ALL
SELECT 'restored credit_ledger_generation_settlement_uidx'
 WHERE EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
                 AND indexname = 'credit_ledger_generation_settlement_uidx');
