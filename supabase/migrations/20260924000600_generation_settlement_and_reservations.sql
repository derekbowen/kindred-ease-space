-- ============================================================================
-- GENERATION SETTLEMENT + DAILY-CAP RESERVATIONS
--
-- Closes three holes an adversarial review found in the page-generation
-- billing core (src/lib/generation.server.ts, src/lib/admin-quick-page.functions.ts):
--
--  1. Free-quota settlement was not idempotent. consume_platform_ai_credit
--     writes no ledger row, so a page settled from the free quota left no
--     record that findLedgerCharge (which only saw deduct_credits rows,
--     delta < 0) could recognise: a crash between the consume and the item
--     update re-consumed on the retry, or charged purchased credits for a page
--     the quota had already covered; two drivers after a stall could both
--     deduct, because nothing on the ledger was unique per page.
--     → credit_ledger_generation_settlement_uidx: ONE ai_usage row per
--       generated page is the settlement record, whichever currency paid.
--     → settle_generation_free_quota writes that row FIRST (delta 0), so a
--       duplicate settlement fails on the index before the quota is touched.
--  2. The Quick Page daily cap was a read, not a reservation: N concurrent
--     requests at remaining = 1 all passed the count-and-compare. For a beta
--     ('granted') tenant that is unbounded platform spend.
--     → generation_reservations + reserve_generation_slot: a per-workspace
--       advisory lock, the count and the insert in ONE transaction.
--     → generation_consumed_last_24h is the single definition of "consumed"
--       for both generators; the app no longer counts in TypeScript.
--  3. A replayed Quick Page could not tell whether its page still owed a
--     platform charge. tenant_pages.generation_billing_mode records who paid
--     for a generated page so the replay path can settle a platform page
--     (idempotently, through the ledger) instead of reporting it as free.
--
-- Every step is idempotent (IF NOT EXISTS, CREATE OR REPLACE, guarded DO
-- blocks) so the file can be re-run without harm. Rollback:
-- supabase/rollback/20260924000600_generation_settlement_and_reservations_rollback.sql
-- ============================================================================

-- 1) Settlement record ---------------------------------------------------------
-- Scoped to the two generation features only. coach-chat writes many ai_usage
-- rows per conversation under ref_type 'coach' (ref_id = conversation id) and
-- ai-proxy writes ref_id NULL; neither may be covered. Verified 2026-09-24:
-- production has no rows matching this predicate, so no dedupe is needed
-- before the index builds.
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_generation_settlement_uidx
  ON public.credit_ledger (workspace_id, ref_id)
  WHERE reason = 'ai_usage'
    AND ref_type IN ('batch_generation','quick_page')
    AND ref_id IS NOT NULL;

-- Same body as consume_platform_ai_credit (20260923000400) with the ledger
-- row in front of the quota. The ORDER is the point: the INSERT hits the
-- unique index first, so a second settlement for the same page raises
-- unique_violation (23505) before a single free credit moves. An exhausted
-- quota raises AFTER the insert and rolls the row back with it, so the caller
-- can fall through to deduct_credits — whose own ledger row (delta < 0, same
-- ref) then becomes the page's settlement record instead.
-- delta 0: nothing purchased was spent; the row exists to be unique.
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

-- 2) Daily-cap reservations ----------------------------------------------------
-- One row per Quick Page request that was granted a slot. The batch generator
-- needs no row here: its reservation is its pending generation_items row,
-- claimed before anything is generated. Rows are tiny, age out of the count
-- after 24h and are kept as history; the app deletes a row (best effort)
-- when its request produced no page.
CREATE TABLE IF NOT EXISTS public.generation_reservations (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, request_id)
);
CREATE INDEX IF NOT EXISTS generation_reservations_ws_created_idx
  ON public.generation_reservations (workspace_id, created_at DESC);

-- Service role only: RLS with no policy denies every other role, and the
-- privilege is withdrawn explicitly on top.
ALTER TABLE public.generation_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.generation_reservations FROM anon, authenticated;

-- The ONE definition of "consumed from the daily cap in the last 24 hours",
-- used by reserve_generation_slot below and by the app (countConsumedLast24h):
--   batch  = generation_items done / running / pending — a reservation, see
--            DAILY_CAP_COUNTED_STATUSES in src/lib/generation.server.ts.
--            _exclude_item_id lets an item re-check the cap without counting
--            its own slot (a pending item already holds one).
--   quick  = tenant_pages created in the window that carry a
--            generation_request_id (batch pages never do — no double count).
--   held   = generation_reservations in the window whose request has NOT
--            produced a page yet. Once the page exists it is counted as a
--            quick page and the reservation is neutralised, never both.
CREATE OR REPLACE FUNCTION public.generation_consumed_last_24h(
  _workspace_id uuid,
  _exclude_item_id uuid DEFAULT NULL
)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (
    (SELECT count(*)
       FROM public.generation_items i
      WHERE i.workspace_id = _workspace_id
        AND i.status IN ('done','running','pending')
        AND i.updated_at >= now() - interval '24 hours'
        AND (_exclude_item_id IS NULL OR i.id <> _exclude_item_id))
    +
    (SELECT count(*)
       FROM public.tenant_pages p
      WHERE p.workspace_id = _workspace_id
        AND p.generation_request_id IS NOT NULL
        AND p.created_at >= now() - interval '24 hours')
    +
    (SELECT count(*)
       FROM public.generation_reservations r
      WHERE r.workspace_id = _workspace_id
        AND r.created_at >= now() - interval '24 hours'
        AND NOT EXISTS (SELECT 1
                          FROM public.tenant_pages p
                         WHERE p.workspace_id = r.workspace_id
                           AND p.generation_request_id = r.request_id))
  )::int;
$$;

REVOKE EXECUTE ON FUNCTION public.generation_consumed_last_24h(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generation_consumed_last_24h(uuid, uuid) TO service_role;

-- Reserve one slot for this request, or say no. The advisory lock serialises
-- every reservation for the workspace for the rest of the transaction, so the
-- count and the insert are one step: two requests arriving at remaining = 1
-- cannot both read 1 and both reserve. A replay of a request that already
-- holds a slot keeps it (true) — no second count, no refusal.
CREATE OR REPLACE FUNCTION public.reserve_generation_slot(
  _workspace_id uuid,
  _request_id uuid,
  _cap int
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_consumed int;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('generation_cap:' || _workspace_id::text));

  IF EXISTS (SELECT 1 FROM public.generation_reservations
              WHERE workspace_id = _workspace_id AND request_id = _request_id) THEN
    RETURN true;
  END IF;

  v_consumed := public.generation_consumed_last_24h(_workspace_id, NULL);
  IF v_consumed >= GREATEST(COALESCE(_cap, 0), 0) THEN
    RETURN false;
  END IF;

  INSERT INTO public.generation_reservations (workspace_id, request_id)
  VALUES (_workspace_id, _request_id);
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reserve_generation_slot(uuid, uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_generation_slot(uuid, uuid, int) TO service_role;

-- 3) Who paid for a generated page --------------------------------------------
-- NULL for hand-written pages and for pages generated before this migration.
-- 'platform' is the only value that can still owe a charge, which is what
-- the Quick Page replay path settles.
ALTER TABLE public.tenant_pages ADD COLUMN IF NOT EXISTS generation_billing_mode text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'tenant_pages_generation_billing_mode_check') THEN
    ALTER TABLE public.tenant_pages
      ADD CONSTRAINT tenant_pages_generation_billing_mode_check
      CHECK (generation_billing_mode IN ('byok','granted','platform'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Verification — every row should read true.
-- ---------------------------------------------------------------------------
SELECT 'settlement index present with the generation predicate' AS check,
       EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public'
                  AND indexname = 'credit_ledger_generation_settlement_uidx'
                  AND indexdef LIKE '%batch_generation%'
                  AND indexdef LIKE '%quick_page%'
                  AND indexdef LIKE '%ref_id IS NOT NULL%') AS ok
UNION ALL SELECT 'settle_generation_free_quota: service_role only',
       has_function_privilege('service_role', 'public.settle_generation_free_quota(uuid,text,text,text)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.settle_generation_free_quota(uuid,text,text,text)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.settle_generation_free_quota(uuid,text,text,text)', 'EXECUTE')
UNION ALL SELECT 'settle_generation_free_quota: membership guard present',
       (SELECT prosrc LIKE '%is_workspace_member(_workspace_id, auth.uid())%'
          FROM pg_proc WHERE oid = 'public.settle_generation_free_quota(uuid,text,text,text)'::regprocedure)
UNION ALL SELECT 'settle_generation_free_quota: ledger row inserted before the quota update',
       (SELECT position('INSERT INTO public.credit_ledger' IN prosrc) > 0
           AND position('INSERT INTO public.credit_ledger' IN prosrc)
             < position('UPDATE public.workspace_ai_quota' IN prosrc)
          FROM pg_proc WHERE oid = 'public.settle_generation_free_quota(uuid,text,text,text)'::regprocedure)
UNION ALL SELECT 'generation_reservations present',
       to_regclass('public.generation_reservations') IS NOT NULL
UNION ALL SELECT 'generation_reservations: RLS on, no policies',
       (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'generation_reservations')
       AND NOT EXISTS (SELECT 1 FROM pg_policies
                        WHERE schemaname = 'public' AND tablename = 'generation_reservations')
UNION ALL SELECT 'generation_reservations: not readable or writable by authenticated or anon',
       NOT has_table_privilege('authenticated', 'public.generation_reservations', 'SELECT')
       AND NOT has_table_privilege('authenticated', 'public.generation_reservations', 'INSERT')
       AND NOT has_table_privilege('anon', 'public.generation_reservations', 'SELECT')
       AND NOT has_table_privilege('anon', 'public.generation_reservations', 'INSERT')
UNION ALL SELECT 'generation_consumed_last_24h: service_role only',
       has_function_privilege('service_role', 'public.generation_consumed_last_24h(uuid,uuid)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.generation_consumed_last_24h(uuid,uuid)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.generation_consumed_last_24h(uuid,uuid)', 'EXECUTE')
UNION ALL SELECT 'generation_consumed_last_24h: counts items, quick pages and held reservations',
       (SELECT prosrc LIKE '%public.generation_items%'
           AND prosrc LIKE '%generation_request_id IS NOT NULL%'
           AND prosrc LIKE '%public.generation_reservations%'
          FROM pg_proc WHERE oid = 'public.generation_consumed_last_24h(uuid,uuid)'::regprocedure)
UNION ALL SELECT 'reserve_generation_slot: service_role only',
       has_function_privilege('service_role', 'public.reserve_generation_slot(uuid,uuid,int)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.reserve_generation_slot(uuid,uuid,int)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.reserve_generation_slot(uuid,uuid,int)', 'EXECUTE')
UNION ALL SELECT 'reserve_generation_slot: takes the per-workspace advisory lock before counting',
       (SELECT position('pg_advisory_xact_lock' IN prosrc) > 0
           AND position('pg_advisory_xact_lock' IN prosrc)
             < position('generation_consumed_last_24h' IN prosrc)
          FROM pg_proc WHERE oid = 'public.reserve_generation_slot(uuid,uuid,int)'::regprocedure)
UNION ALL SELECT 'tenant_pages.generation_billing_mode present',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'tenant_pages'
                  AND column_name = 'generation_billing_mode')
UNION ALL SELECT 'tenant_pages.generation_billing_mode constrained to byok / granted / platform',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'tenant_pages_generation_billing_mode_check' AND contype = 'c');
