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
--     ('granted') tenant that is unbounded platform spend. And the count read
--     rows that customers control — pages (deletable, editable) and batch
--     items (re-armable) — so deleting a draft freed a slot.
--     → generation_reservations: ONE row per provider call, from every
--       generator (quick page, coach city page, Opportunity Engine, each
--       batch item attempt). generation_consumed_last_24h counts these rows
--       and nothing else; no page or item can free a slot.
--     → reserve_generation_slot: a per-workspace advisory lock, the count and
--       the insert in ONE transaction; per request id it answers 'reserved',
--       'cap_reached', 'in_progress' or 'consumed', so one id buys at most
--       one provider call (a replay no longer "keeps its slot" for a second
--       call, and a deleted draft is not regenerated for free).
--     → mark_generation_provider_called: set immediately before the provider
--       request; from then on release_generation_slot cannot free the row.
--  3. A replayed Quick Page could not tell whether its page still owed a
--     platform charge. tenant_pages.generation_billing_mode records who paid
--     for a generated page so the replay path can settle a platform page
--     (idempotently, through the ledger) instead of reporting it as free.
--     → tenant_pages_pin_generation_columns: members may still edit their
--       pages, but created_at, generation_request_id and
--       generation_billing_mode keep their values unless the service role
--       writes them (a platform page cannot be relabelled 'byok' to dodge
--       the charge it owes, nor detached from its request id).
--
-- Every step is idempotent (IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF
-- EXISTS ahead of a changed signature or return type, guarded DO blocks) so
-- the file can be re-run without harm. Rollback:
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
-- ONE row per provider call a generator was allowed to make: a quick page /
-- coach city page / Opportunity Engine request (its generation request id) or
-- one batch item ATTEMPT (a deterministic id per item, job and attempt,
-- src/lib/generation.server.ts batchAttemptRequestId). This row is the unit
-- of daily-cap consumption: it is counted for 24 hours from created_at
-- whatever happens to the page it produced — deleting a draft, editing a
-- page or re-arming a batch item frees nothing. Rows are tiny and kept as
-- history. The only delete is release_generation_slot, for a request that
-- ended BEFORE its provider call.
CREATE TABLE IF NOT EXISTS public.generation_reservations (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, request_id)
);
-- Set by mark_generation_provider_called immediately before the provider
-- request. From then on the slot is spent: it cannot be released, and the
-- request id can never buy a second provider call. NULL = never called.
ALTER TABLE public.generation_reservations ADD COLUMN IF NOT EXISTS provider_called_at timestamptz;
CREATE INDEX IF NOT EXISTS generation_reservations_ws_created_idx
  ON public.generation_reservations (workspace_id, created_at DESC);

-- Service role only: RLS with no policy denies every other role, and the
-- privilege is withdrawn explicitly on top.
ALTER TABLE public.generation_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.generation_reservations FROM anon, authenticated;

-- The ONE definition of "consumed from the daily cap in the last 24 hours",
-- used by reserve_generation_slot below and by the app (countConsumedLast24h,
-- for the "N left today" figure and to size a batch job): reservations
-- created in the window, i.e. provider calls. tenant_pages and
-- generation_items are deliberately NOT read — both are rows a customer can
-- delete, edit or re-arm. The earlier (uuid, uuid) signature took an item to
-- exclude; items are not counted at all any more, so it is dropped first
-- (CREATE OR REPLACE with a new signature would leave an ambiguous overload).
DROP FUNCTION IF EXISTS public.generation_consumed_last_24h(uuid, uuid);
CREATE OR REPLACE FUNCTION public.generation_consumed_last_24h(
  _workspace_id uuid
)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::int
    FROM public.generation_reservations r
   WHERE r.workspace_id = _workspace_id
     AND r.created_at >= now() - interval '24 hours';
$$;

REVOKE EXECUTE ON FUNCTION public.generation_consumed_last_24h(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generation_consumed_last_24h(uuid) TO service_role;

-- Reserve one slot for this request id, or say why not. The advisory lock
-- serialises every reservation for the workspace for the rest of the
-- transaction, so the count and the insert are one step: two requests
-- arriving at remaining = 1 cannot both read 1 and both reserve. Per id:
--   'consumed'    a page carries this id, or its row is older than 15 minutes
--                 and its provider was called: that call is spent for good.
--   'in_progress' its row is younger than 15 minutes and no page carries the
--                 id: another request has it RIGHT NOW (the provider call is
--                 capped at 120 s, OPENROUTER_TIMEOUT_MS). Never a second call.
--   'reserved'    a new row, counted from now — or a row older than 15
--                 minutes whose provider was never called (the request died
--                 before spending anything), retaken with a fresh created_at.
--   'cap_reached' the last 24 hours already hold _cap reservations.
-- It returns text, not boolean: the earlier boolean version said "true" to a
-- replay of an id that held a slot, which handed the replay a provider call
-- of its own. Dropped first because CREATE OR REPLACE cannot change a return
-- type.
DROP FUNCTION IF EXISTS public.reserve_generation_slot(uuid, uuid, int);
CREATE OR REPLACE FUNCTION public.reserve_generation_slot(
  _workspace_id uuid,
  _request_id uuid,
  _cap int
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_created_at timestamptz;
  v_provider_called_at timestamptz;
  v_consumed int;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF _workspace_id IS NULL OR _request_id IS NULL THEN
    RAISE EXCEPTION 'reserve_generation_slot: workspace and request id are required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('generation_cap:' || _workspace_id::text));

  -- The request already produced a page: nothing left to generate.
  IF EXISTS (SELECT 1 FROM public.tenant_pages p
              WHERE p.workspace_id = _workspace_id
                AND p.generation_request_id = _request_id) THEN
    RETURN 'consumed';
  END IF;

  SELECT r.created_at, r.provider_called_at
    INTO v_created_at, v_provider_called_at
    FROM public.generation_reservations r
   WHERE r.workspace_id = _workspace_id
     AND r.request_id = _request_id
     FOR UPDATE;

  IF FOUND THEN
    IF v_created_at > now() - interval '15 minutes' THEN
      RETURN 'in_progress';
    END IF;
    IF v_provider_called_at IS NOT NULL THEN
      RETURN 'consumed';
    END IF;
    -- Stale and never spent: retake it against the cap, without counting the
    -- row itself twice while it is still inside the window.
    v_consumed := public.generation_consumed_last_24h(_workspace_id)
                  - CASE WHEN v_created_at >= now() - interval '24 hours' THEN 1 ELSE 0 END;
    IF v_consumed >= GREATEST(COALESCE(_cap, 0), 0) THEN
      RETURN 'cap_reached';
    END IF;
    UPDATE public.generation_reservations
       SET created_at = now()
     WHERE workspace_id = _workspace_id
       AND request_id = _request_id;
    RETURN 'reserved';
  END IF;

  v_consumed := public.generation_consumed_last_24h(_workspace_id);
  IF v_consumed >= GREATEST(COALESCE(_cap, 0), 0) THEN
    RETURN 'cap_reached';
  END IF;

  INSERT INTO public.generation_reservations (workspace_id, request_id)
  VALUES (_workspace_id, _request_id);
  RETURN 'reserved';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reserve_generation_slot(uuid, uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_generation_slot(uuid, uuid, int) TO service_role;

-- Called by the app IMMEDIATELY before the provider request. Marks the
-- reservation spent; true only for the call that flipped provider_called_at
-- from NULL. False (no row, or already marked) means another request owns
-- this id's provider call, and the caller must not make one.
CREATE OR REPLACE FUNCTION public.mark_generation_provider_called(
  _workspace_id uuid,
  _request_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_marked int;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  UPDATE public.generation_reservations
     SET provider_called_at = now()
   WHERE workspace_id = _workspace_id
     AND request_id = _request_id
     AND provider_called_at IS NULL;
  GET DIAGNOSTICS v_marked = ROW_COUNT;
  RETURN v_marked = 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mark_generation_provider_called(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_generation_provider_called(uuid, uuid) TO service_role;

-- Give a slot back. The app calls this only from the request that was
-- granted the reservation ('reserved') and only on a path that ended before
-- its provider call; the predicate enforces the second half here, so a spent
-- slot can never be freed. True when a row was deleted.
CREATE OR REPLACE FUNCTION public.release_generation_slot(
  _workspace_id uuid,
  _request_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_released int;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.generation_reservations
   WHERE workspace_id = _workspace_id
     AND request_id = _request_id
     AND provider_called_at IS NULL;
  GET DIAGNOSTICS v_released = ROW_COUNT;
  RETURN v_released = 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.release_generation_slot(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_generation_slot(uuid, uuid) TO service_role;

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

-- 4) Pin the generation columns -------------------------------------------------
-- Members may update their own tenant_pages rows through PostgREST ("members
-- update tenant_pages"). They must not be able to rewrite who paid for a
-- generated page (relabel a 'platform' page 'byok' so the replay path never
-- settles it), detach a page from its request id, or back-date it. For any
-- caller that is not the service role (auth.role(), as the service-role
-- policies in this schema check it) the three columns keep their OLD values;
-- every other column updates as before. Service-role writes — the app's
-- server path — are unaffected. A session with no JWT at all (auth.role()
-- NULL, e.g. the SQL editor) is pinned too: fail closed.
-- EXECUTE is not checked when a trigger fires, so the function is service-role
-- only like everything else in this file.
CREATE OR REPLACE FUNCTION public.tenant_pages_pin_generation_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    NEW.created_at := OLD.created_at;
    NEW.generation_request_id := OLD.generation_request_id;
    NEW.generation_billing_mode := OLD.generation_billing_mode;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.tenant_pages_pin_generation_columns() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_pages_pin_generation_columns() TO service_role;

DROP TRIGGER IF EXISTS tenant_pages_pin_generation_columns ON public.tenant_pages;
CREATE TRIGGER tenant_pages_pin_generation_columns
  BEFORE UPDATE ON public.tenant_pages
  FOR EACH ROW EXECUTE FUNCTION public.tenant_pages_pin_generation_columns();

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
UNION ALL SELECT 'generation_reservations.provider_called_at present',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'generation_reservations'
                  AND column_name = 'provider_called_at')
UNION ALL SELECT 'generation_consumed_last_24h: service_role only',
       has_function_privilege('service_role', 'public.generation_consumed_last_24h(uuid)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.generation_consumed_last_24h(uuid)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.generation_consumed_last_24h(uuid)', 'EXECUTE')
UNION ALL SELECT 'generation_consumed_last_24h: counts reservations only, never pages or items',
       (SELECT prosrc LIKE '%public.generation_reservations%'
           AND prosrc NOT LIKE '%tenant_pages%'
           AND prosrc NOT LIKE '%generation_items%'
          FROM pg_proc WHERE oid = 'public.generation_consumed_last_24h(uuid)'::regprocedure)
UNION ALL SELECT 'generation_consumed_last_24h: the old (uuid, uuid) overload is gone',
       to_regprocedure('public.generation_consumed_last_24h(uuid,uuid)') IS NULL
UNION ALL SELECT 'reserve_generation_slot: service_role only',
       has_function_privilege('service_role', 'public.reserve_generation_slot(uuid,uuid,int)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.reserve_generation_slot(uuid,uuid,int)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.reserve_generation_slot(uuid,uuid,int)', 'EXECUTE')
UNION ALL SELECT 'reserve_generation_slot: returns text (reserved / cap_reached / in_progress / consumed)',
       (SELECT prorettype = 'text'::regtype
           AND prosrc LIKE '%''reserved''%' AND prosrc LIKE '%''cap_reached''%'
           AND prosrc LIKE '%''in_progress''%' AND prosrc LIKE '%''consumed''%'
          FROM pg_proc WHERE oid = 'public.reserve_generation_slot(uuid,uuid,int)'::regprocedure)
UNION ALL SELECT 'reserve_generation_slot: takes the per-workspace advisory lock before counting',
       (SELECT position('pg_advisory_xact_lock' IN prosrc) > 0
           AND position('pg_advisory_xact_lock' IN prosrc)
             < position('generation_consumed_last_24h' IN prosrc)
          FROM pg_proc WHERE oid = 'public.reserve_generation_slot(uuid,uuid,int)'::regprocedure)
UNION ALL SELECT 'mark_generation_provider_called: service_role only',
       has_function_privilege('service_role', 'public.mark_generation_provider_called(uuid,uuid)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.mark_generation_provider_called(uuid,uuid)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.mark_generation_provider_called(uuid,uuid)', 'EXECUTE')
UNION ALL SELECT 'release_generation_slot: service_role only',
       has_function_privilege('service_role', 'public.release_generation_slot(uuid,uuid)', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.release_generation_slot(uuid,uuid)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.release_generation_slot(uuid,uuid)', 'EXECUTE')
UNION ALL SELECT 'release_generation_slot: frees only a row whose provider was never called',
       (SELECT prosrc LIKE '%provider_called_at IS NULL%'
          FROM pg_proc WHERE oid = 'public.release_generation_slot(uuid,uuid)'::regprocedure)
UNION ALL SELECT 'tenant_pages.generation_billing_mode present',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'tenant_pages'
                  AND column_name = 'generation_billing_mode')
UNION ALL SELECT 'tenant_pages.generation_billing_mode constrained to byok / granted / platform',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'tenant_pages_generation_billing_mode_check' AND contype = 'c')
UNION ALL SELECT 'tenant_pages_pin_generation_columns: service_role only',
       has_function_privilege('service_role', 'public.tenant_pages_pin_generation_columns()', 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.tenant_pages_pin_generation_columns()', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.tenant_pages_pin_generation_columns()', 'EXECUTE')
UNION ALL SELECT 'tenant_pages_pin_generation_columns: BEFORE UPDATE trigger on tenant_pages',
       EXISTS (SELECT 1 FROM pg_trigger
                WHERE tgname = 'tenant_pages_pin_generation_columns'
                  AND tgrelid = 'public.tenant_pages'::regclass
                  AND NOT tgisinternal
                  AND tgenabled <> 'D');
