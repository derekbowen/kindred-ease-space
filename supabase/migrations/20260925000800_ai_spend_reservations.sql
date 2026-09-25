-- ============================================================================
-- ONE AI SPEND ARCHITECTURE: an atomic reservation before every OpenAI call
--
-- Every AI request founders.click makes — page generation (Quick Page, the
-- coach's city page, the Opportunity Engine, each batch item attempt), the
-- coach's page tools (add_meta, fix_thin_page, add_internal_links), the SEO
-- coach, the page auditor and the daily briefing — goes through the same four
-- functions, in this order, keyed by (workspace_id, request_id):
--
--   ai_reserve      reserve the MAXIMUM the call can cost, atomically:
--                   idempotency by request id, the per-workspace rate limit,
--                   the platform kill switch, the global daily ceiling, and
--                   the tenant charge (a free-quota unit, else purchased
--                   credits) — all under one per-workspace lock, one
--                   transaction. Refused → nothing moved, no provider call.
--   ai_mark_called  held → called, immediately before the provider request.
--                   The caller must not call the provider unless this says
--                   true. It re-checks the kill switch, so flipping it stops
--                   holds that have not reached the provider yet.
--   ai_settle       called → settled with the usage the provider reported
--                   (or the full hold when usage is unknown): charge the
--                   actual cost, capped at the hold; refund the rest; return
--                   unused budget; write the one ai_usage_log row.
--   ai_release      held → released (the provider was never called): full
--                   refund of the quota unit / credits and of the budget.
--
-- and ai_reap_stale_reservations (pg_cron, every 5 minutes, pure SQL) ends
-- every abandoned hold within bounded time whether or not the workspace ever
-- makes another request: held and never called for 10 minutes → released
-- with a full refund; called and unsettled for 30 minutes → settled at the
-- full hold. ai_reserve does the same for its own workspace on the way in.
--
-- The platform settings row is an EMERGENCY CEILING and kill switch, not
-- customer accounting: platform_ai_enabled = false refuses every reservation
-- that would spend the platform key ('platform_paused'), whatever a
-- workspace's balance; daily_budget_micros caps what all of them together may
-- hold or spend per UTC day ('budget_exhausted'). Per-workspace allowances
-- (free quota, credits, the beta grant's daily page cap) are separate and
-- unchanged. BYOK calls (the customer's own key) take neither the ceiling nor
-- tenant funds but still take a row and the rate limit.
--
--   Flip the kill switch (Supabase SQL editor, as postgres):
--     UPDATE public.ai_platform_settings SET platform_ai_enabled = false, updated_at = now();
--   Change the ceiling ($10.00/day = 10000000 micros):
--     UPDATE public.ai_platform_settings SET daily_budget_micros = 10000000, updated_at = now();
--
-- The page-generation pause (platform_settings.generation_paused, 000300)
-- is enforced here too, atomically, for page generation on every key type
-- (as before). The app's early read of it is only a fail-fast UX check.
--
-- Also here: the daily briefing's per-(workspace, UTC date) claim, so the
-- cron and any number of concurrent "Refresh" clicks produce ONE stored
-- briefing and at most one AI call (coach_briefing_claim / _store).
--
-- Supersedes settle_generation_free_quota and its settlement index (000600,
-- never applied in production): generation is settled here now, once per
-- request. Unchanged: generation_reservations and the daily cap.
--
-- Idempotent (IF NOT EXISTS, CREATE OR REPLACE, guarded cron) — the file can
-- be re-run. Rollback:
-- supabase/rollback/20260925000800_ai_spend_reservations_rollback.sql
-- ============================================================================

-- 0) Superseded --------------------------------------------------------------
DROP FUNCTION IF EXISTS public.settle_generation_free_quota(uuid, text, text, text);
DROP INDEX IF EXISTS public.credit_ledger_generation_settlement_uidx;

-- 1) The kill switch and the ceiling ------------------------------------------
-- One row (id is always true). Service role only: RLS with no policy, and the
-- privileges withdrawn from anon and authenticated on top.
CREATE TABLE IF NOT EXISTS public.ai_platform_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  platform_ai_enabled boolean NOT NULL DEFAULT true,
  daily_budget_micros bigint NOT NULL DEFAULT 10000000 CHECK (daily_budget_micros >= 0),
  workspace_reservations_per_minute int NOT NULL DEFAULT 30
    CHECK (workspace_reservations_per_minute > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.ai_platform_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.ai_platform_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_platform_settings FROM anon, authenticated;

-- 2) What the platform key has held or spent per UTC day ------------------------
-- spent_micros = the hold of every open non-BYOK reservation charged to the
-- day + the actual cost of every settled one. Always equal to
-- sum(ai_spend_reservations.budget_micros) for that day.
CREATE TABLE IF NOT EXISTS public.ai_budget_days (
  day date PRIMARY KEY,
  spent_micros bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_budget_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_budget_days FROM anon, authenticated;

-- 3) One row per AI request ------------------------------------------------------
-- Keyed per workspace: a request id can be client-supplied (the Quick Page's
-- generationRequestId), so it must never collide with another tenant's.
CREATE TABLE IF NOT EXISTS public.ai_spend_reservations (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  user_id uuid,
  feature text NOT NULL,
  source text NOT NULL,
  model text NOT NULL,
  max_input_tokens int NOT NULL,
  max_output_tokens int NOT NULL,
  max_cost_micros bigint NOT NULL,
  max_credits int NOT NULL DEFAULT 0,
  billing text NOT NULL,
  status text NOT NULL DEFAULT 'held',
  hold_seq int NOT NULL DEFAULT 1,
  budget_day date,
  budget_micros bigint NOT NULL DEFAULT 0,
  quota_units int NOT NULL DEFAULT 0,
  credits_charged int NOT NULL DEFAULT 0,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  provider_called_at timestamptz,
  settled_at timestamptz,
  released_at timestamptz,
  input_tokens int,
  cached_input_tokens int,
  output_tokens int,
  reasoning_tokens int,
  actual_cost_micros bigint,
  close_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, request_id),
  CONSTRAINT ai_spend_feature_check CHECK (feature IN (
    'page_generation','add_meta','fix_thin_page','add_internal_links',
    'seo_coach','page_audit','daily_briefing')),
  CONSTRAINT ai_spend_model_check CHECK (model IN ('gpt-5-nano','gpt-5-mini')),
  CONSTRAINT ai_spend_billing_check CHECK (billing IN ('free_quota','credits','granted','byok','system')),
  CONSTRAINT ai_spend_status_check CHECK (status IN ('held','called','settled','released')),
  CONSTRAINT ai_spend_tokens_check CHECK (
    max_output_tokens BETWEEN 1 AND 6000 AND max_input_tokens BETWEEN 1 AND 272000),
  CONSTRAINT ai_spend_amounts_check CHECK (
    max_cost_micros >= 0 AND max_credits >= 0 AND budget_micros >= 0 AND hold_seq >= 1),
  -- The billing policy, at the schema level: a beta grant covers page
  -- generation only; 'system' is the daily briefing and nothing else; every
  -- customer call names its user.
  CONSTRAINT ai_spend_granted_scope CHECK (billing <> 'granted' OR feature = 'page_generation'),
  CONSTRAINT ai_spend_system_scope CHECK ((billing = 'system') = (feature = 'daily_briefing')),
  CONSTRAINT ai_spend_user_check CHECK (billing = 'system' OR user_id IS NOT NULL),
  -- BYOK never touches the platform ceiling; everything else is charged to a day.
  CONSTRAINT ai_spend_budget_scope CHECK (
    (billing = 'byok' AND budget_day IS NULL AND budget_micros = 0)
    OR (billing <> 'byok' AND budget_day IS NOT NULL)),
  CONSTRAINT ai_spend_quota_scope CHECK (quota_units IN (0,1) AND (billing = 'free_quota' OR quota_units = 0)),
  CONSTRAINT ai_spend_credits_scope CHECK (
    credits_charged >= 0 AND credits_charged <= max_credits
    AND (billing = 'credits' OR credits_charged = 0)
    AND (billing <> 'credits' OR max_credits > 0)),
  -- A released row was never called; a called or settled row was.
  CONSTRAINT ai_spend_release_never_called CHECK (status <> 'released' OR provider_called_at IS NULL),
  CONSTRAINT ai_spend_called_marked CHECK (status NOT IN ('called','settled') OR provider_called_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ai_spend_reservations_ws_reserved_idx
  ON public.ai_spend_reservations (workspace_id, reserved_at DESC);
CREATE INDEX IF NOT EXISTS ai_spend_reservations_open_idx
  ON public.ai_spend_reservations (status, reserved_at)
  WHERE status IN ('held','called');
ALTER TABLE public.ai_spend_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_spend_reservations FROM anon, authenticated;

-- A credits hold and its refund are ledger rows keyed by request + hold
-- sequence: one hold and at most one refund, ever. A double hold or a double
-- refund fails here before a single credit moves.
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_ai_spend_uidx
  ON public.credit_ledger (workspace_id, ref_id, reason)
  WHERE ref_type = 'ai_spend' AND reason IN ('ai_hold','ai_refund');

-- 4) The daily briefing's per-day claim ------------------------------------------
CREATE TABLE IF NOT EXISTS public.coach_briefing_claims (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  briefing_date date NOT NULL,
  claim_token uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, briefing_date)
);
ALTER TABLE public.coach_briefing_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coach_briefing_claims FROM anon, authenticated;

-- 5) Internal helpers (service role only; callers hold the workspace lock) -------

-- The page-generation pause switch as ops set it: JSON true or the string
-- "true" (any case, any padding) pauses; anything else does not.
CREATE OR REPLACE FUNCTION public._ai_generation_paused()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT CASE jsonb_typeof(s.value)
             WHEN 'boolean' THEN s.value = 'true'::jsonb
             WHEN 'string'  THEN lower(btrim(s.value #>> '{}')) = 'true'
             ELSE false
           END
      FROM public.platform_settings s
     WHERE s.key = 'generation_paused'), false);
$$;

-- held → released: the provider was never called, so everything goes back.
-- The refund ledger row is written before the balance moves, so a second
-- refund of the same hold fails on credit_ledger_ai_spend_uidx first.
CREATE OR REPLACE FUNCTION public._ai_release_row(_workspace_id uuid, _request_id uuid, _reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r public.ai_spend_reservations%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.ai_spend_reservations
   WHERE workspace_id = _workspace_id AND request_id = _request_id
   FOR UPDATE;
  IF NOT FOUND OR r.status <> 'held' THEN
    RETURN false;
  END IF;

  IF r.quota_units > 0 THEN
    UPDATE public.workspace_ai_quota
       SET platform_credits_remaining = platform_credits_remaining + r.quota_units,
           lifetime_platform_used = GREATEST(lifetime_platform_used - r.quota_units, 0)
     WHERE workspace_id = _workspace_id;
  END IF;
  IF r.billing = 'credits' AND r.max_credits > 0 THEN
    INSERT INTO public.credit_ledger (workspace_id, delta, reason, ai_model, ref_type, ref_id, metadata)
    VALUES (_workspace_id, r.max_credits, 'ai_refund', r.model, 'ai_spend',
            _request_id::text || '#' || r.hold_seq,
            jsonb_build_object('kind', 'release', 'reason', _reason, 'feature', r.feature));
    UPDATE public.credit_balances
       SET balance = balance + r.max_credits,
           lifetime_spent = GREATEST(lifetime_spent - r.max_credits, 0)
     WHERE workspace_id = _workspace_id;
  END IF;

  UPDATE public.ai_spend_reservations
     SET status = 'released', released_at = now(), close_reason = _reason,
         quota_units = 0, credits_charged = 0, budget_micros = 0, updated_at = now()
   WHERE workspace_id = _workspace_id AND request_id = _request_id;

  IF r.budget_micros > 0 THEN
    UPDATE public.ai_budget_days
       SET spent_micros = spent_micros - r.budget_micros, updated_at = now()
     WHERE day = r.budget_day;
  END IF;
  RETURN true;
END;
$$;

-- called → settled. _cost_micros NULL = the provider's usage is unknown, so
-- the full hold is charged and kept against the ceiling. Otherwise the
-- tenant is charged the actual credits capped at the hold (the rest is
-- refunded) and the ceiling records the actual cost. A call that provably
-- cost nothing (cost 0) gives its free-quota unit back. Writes the one
-- ai_usage_log row for the call; _error is a short failure code, never text.
CREATE OR REPLACE FUNCTION public._ai_settle_row(
  _workspace_id uuid,
  _request_id uuid,
  _input_tokens int,
  _cached_input_tokens int,
  _output_tokens int,
  _reasoning_tokens int,
  _cost_micros bigint,
  _credits int,
  _outcome text,
  _error text,
  _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.ai_spend_reservations%ROWTYPE;
  v_full boolean := _cost_micros IS NULL;
  v_cost bigint;
  v_charge int := 0;
  v_refund int := 0;
  v_quota int;
  v_budget bigint := 0;
BEGIN
  SELECT * INTO r FROM public.ai_spend_reservations
   WHERE workspace_id = _workspace_id AND request_id = _request_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing');
  END IF;
  IF r.status = 'settled' THEN
    RETURN jsonb_build_object('status', 'already_settled', 'billing', r.billing,
                              'credits_charged', r.credits_charged, 'cost_micros', r.actual_cost_micros);
  END IF;
  IF r.status = 'held' THEN
    RETURN jsonb_build_object('status', 'not_called');
  END IF;
  IF r.status <> 'called' THEN
    RETURN jsonb_build_object('status', r.status);
  END IF;

  v_cost := COALESCE(_cost_micros, r.max_cost_micros);
  IF r.billing = 'credits' THEN
    v_charge := CASE WHEN v_full THEN r.max_credits
                     ELSE LEAST(GREATEST(COALESCE(_credits, r.max_credits), 0), r.max_credits) END;
    v_refund := r.max_credits - v_charge;
  END IF;
  v_quota := CASE WHEN r.quota_units > 0 AND NOT v_full AND v_cost = 0 THEN 0 ELSE r.quota_units END;
  IF r.billing <> 'byok' THEN
    v_budget := v_cost;
  END IF;

  IF v_refund > 0 THEN
    INSERT INTO public.credit_ledger (workspace_id, delta, reason, ai_model, ref_type, ref_id, metadata)
    VALUES (_workspace_id, v_refund, 'ai_refund', r.model, 'ai_spend',
            _request_id::text || '#' || r.hold_seq,
            jsonb_build_object('kind', 'settle', 'reason', _reason, 'feature', r.feature,
                               'charged', v_charge));
    UPDATE public.credit_balances
       SET balance = balance + v_refund,
           lifetime_spent = GREATEST(lifetime_spent - v_refund, 0)
     WHERE workspace_id = _workspace_id;
  END IF;
  IF v_quota < r.quota_units THEN
    UPDATE public.workspace_ai_quota
       SET platform_credits_remaining = platform_credits_remaining + (r.quota_units - v_quota),
           lifetime_platform_used = GREATEST(lifetime_platform_used - (r.quota_units - v_quota), 0)
     WHERE workspace_id = _workspace_id;
  END IF;

  UPDATE public.ai_spend_reservations
     SET status = 'settled', settled_at = now(), close_reason = _reason,
         input_tokens = _input_tokens, cached_input_tokens = _cached_input_tokens,
         output_tokens = _output_tokens, reasoning_tokens = _reasoning_tokens,
         actual_cost_micros = v_cost, credits_charged = v_charge, quota_units = v_quota,
         budget_micros = v_budget, updated_at = now()
   WHERE workspace_id = _workspace_id AND request_id = _request_id;

  IF r.billing <> 'byok' AND v_budget <> r.budget_micros THEN
    UPDATE public.ai_budget_days
       SET spent_micros = spent_micros + (v_budget - r.budget_micros), updated_at = now()
     WHERE day = r.budget_day;
  END IF;

  INSERT INTO public.ai_usage_log (workspace_id, user_id, provider, model, feature,
                                   prompt_tokens, completion_tokens, total_tokens,
                                   cost_usd_micros, used_byok, status, error)
  VALUES (_workspace_id, r.user_id, 'openai', r.model, r.source,
          COALESCE(_input_tokens, 0), COALESCE(_output_tokens, 0),
          COALESCE(_input_tokens, 0) + COALESCE(_output_tokens, 0),
          v_cost, r.billing = 'byok', COALESCE(_outcome, 'failed'), _error);

  RETURN jsonb_build_object('status', 'settled', 'billing', r.billing, 'credits_charged', v_charge,
                            'quota_units', v_quota, 'cost_micros', v_cost, 'full_hold', v_full);
END;
$$;

-- Ends this workspace's abandoned holds. The caller holds the workspace lock.
-- Returns {released, settled}.
CREATE OR REPLACE FUNCTION public._ai_expire_workspace(_workspace_id uuid)
RETURNS int[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_released int := 0;
  v_settled int := 0;
BEGIN
  FOR r IN
    SELECT request_id, status FROM public.ai_spend_reservations
     WHERE workspace_id = _workspace_id
       AND ((status = 'held' AND reserved_at < now() - interval '10 minutes')
         OR (status = 'called' AND provider_called_at < now() - interval '30 minutes'))
     ORDER BY request_id
  LOOP
    IF r.status = 'held' THEN
      IF public._ai_release_row(_workspace_id, r.request_id, 'expired_unused') THEN
        v_released := v_released + 1;
      END IF;
    ELSE
      IF (public._ai_settle_row(_workspace_id, r.request_id, NULL, NULL, NULL, NULL, NULL, NULL,
                                'failed', 'expired', 'expired_full_hold') ->> 'status') = 'settled' THEN
        v_settled := v_settled + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN ARRAY[v_released, v_settled];
END;
$$;

-- 6) The four calls every AI request makes -----------------------------------------

-- Reserve the maximum cost of one call, or say why not:
--   reserved         {status, billing, hold_seq} — go ahead (mark, then call)
--   in_progress      this request id is held or called right now
--   done             this request id already settled (no second call)
--   conflict         this request id belongs to another feature
--   rate_limited     the workspace made too many reservations this minute
--   platform_paused  the kill switch is off (non-BYOK)
--   generation_paused  page generation is paused (every key type)
--   budget_exhausted the platform's daily ceiling would be exceeded (non-BYOK)
--   insufficient     no free-quota unit and not enough credits for the hold
-- _billing_class: 'tenant' (free quota, else credits), 'granted' (page
-- generation for a beta-granted workspace: no tenant funds), 'byok' (the
-- workspace's own key: no platform funds at all), 'system' (the daily
-- briefing: the ceiling only). Lock order everywhere: the workspace advisory
-- lock, then reservation rows, then quota/credit rows, then the budget row.
CREATE OR REPLACE FUNCTION public.ai_reserve(
  _workspace_id uuid,
  _request_id uuid,
  _user_id uuid,
  _feature text,
  _source text,
  _model text,
  _max_input_tokens int,
  _max_output_tokens int,
  _max_cost_micros bigint,
  _max_credits int,
  _billing_class text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.ai_spend_reservations%ROWTYPE;
  v_found boolean;
  v_settings public.ai_platform_settings%ROWTYPE;
  v_have_settings boolean;
  v_recent int;
  v_billing text;
  v_seq int := 1;
  v_quota int := 0;
  v_credits int := 0;
  v_budget bigint := 0;
  v_day date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF _workspace_id IS NULL OR _request_id IS NULL OR _feature IS NULL OR _source IS NULL
     OR _model IS NULL OR _billing_class IS NULL THEN
    RAISE EXCEPTION 'ai_reserve: missing argument' USING ERRCODE = '22023';
  END IF;
  IF _feature NOT IN ('page_generation','add_meta','fix_thin_page','add_internal_links',
                      'seo_coach','page_audit','daily_briefing') THEN
    RAISE EXCEPTION 'ai_reserve: unknown feature %', _feature USING ERRCODE = '22023';
  END IF;
  IF _model NOT IN ('gpt-5-nano','gpt-5-mini') THEN
    RAISE EXCEPTION 'ai_reserve: model % is not allowed', _model USING ERRCODE = '22023';
  END IF;
  IF _billing_class NOT IN ('tenant','granted','byok','system') THEN
    RAISE EXCEPTION 'ai_reserve: unknown billing class %', _billing_class USING ERRCODE = '22023';
  END IF;
  IF (_billing_class = 'granted' AND _feature <> 'page_generation')
     OR ((_billing_class = 'system') <> (_feature = 'daily_briefing')) THEN
    RAISE EXCEPTION 'ai_reserve: % is not billable as %', _feature, _billing_class USING ERRCODE = '22023';
  END IF;
  IF _billing_class <> 'system' AND _user_id IS NULL THEN
    RAISE EXCEPTION 'ai_reserve: a customer call must name its user' USING ERRCODE = '22023';
  END IF;
  IF _user_id IS NOT NULL AND NOT public.is_workspace_member(_workspace_id, _user_id) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF _max_output_tokens IS NULL OR _max_output_tokens < 1 OR _max_output_tokens > 6000
     OR _max_input_tokens IS NULL OR _max_input_tokens < 1 OR _max_input_tokens > 272000 THEN
    RAISE EXCEPTION 'ai_reserve: token bounds out of range' USING ERRCODE = '22023';
  END IF;
  IF _max_cost_micros IS NULL OR _max_cost_micros < 1 OR _max_credits IS NULL OR _max_credits < 0
     OR (_billing_class = 'tenant' AND _max_credits < 1) THEN
    RAISE EXCEPTION 'ai_reserve: invalid hold amounts' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('ai_spend:' || _workspace_id::text));

  -- Abandoned holds of this workspace end before anything is counted.
  PERFORM public._ai_expire_workspace(_workspace_id);

  SELECT * INTO v_row FROM public.ai_spend_reservations
   WHERE workspace_id = _workspace_id AND request_id = _request_id
   FOR UPDATE;
  v_found := FOUND;
  IF v_found THEN
    IF v_row.feature <> _feature THEN
      RETURN jsonb_build_object('status', 'conflict');
    END IF;
    IF v_row.status IN ('held','called') THEN
      RETURN jsonb_build_object('status', 'in_progress', 'billing', v_row.billing);
    END IF;
    IF v_row.status = 'settled' THEN
      RETURN jsonb_build_object('status', 'done', 'billing', v_row.billing,
                                'credits_charged', v_row.credits_charged,
                                'close_reason', v_row.close_reason);
    END IF;
    -- released: never called; it may be reserved again under the next hold.
    v_seq := v_row.hold_seq + 1;
  END IF;

  SELECT * INTO v_settings FROM public.ai_platform_settings WHERE id;
  v_have_settings := FOUND;

  SELECT count(*) INTO v_recent FROM public.ai_spend_reservations
   WHERE workspace_id = _workspace_id AND reserved_at > now() - interval '1 minute';
  IF v_recent >= COALESCE(v_settings.workspace_reservations_per_minute, 30) THEN
    RETURN jsonb_build_object('status', 'rate_limited');
  END IF;

  -- The kill switch. A missing settings row fails closed.
  IF _billing_class <> 'byok' AND (NOT v_have_settings OR NOT v_settings.platform_ai_enabled) THEN
    RETURN jsonb_build_object('status', 'platform_paused');
  END IF;
  IF _feature = 'page_generation' AND public._ai_generation_paused() THEN
    RETURN jsonb_build_object('status', 'generation_paused');
  END IF;

  -- The tenant charge: a conditional decrement, undone below if the ceiling
  -- refuses (same transaction, same lock).
  IF _billing_class = 'tenant' THEN
    INSERT INTO public.workspace_ai_quota (workspace_id) VALUES (_workspace_id)
    ON CONFLICT (workspace_id) DO NOTHING;
    UPDATE public.workspace_ai_quota
       SET platform_credits_remaining = platform_credits_remaining - 1,
           lifetime_platform_used = lifetime_platform_used + 1
     WHERE workspace_id = _workspace_id AND platform_credits_remaining > 0;
    IF FOUND THEN
      v_billing := 'free_quota';
      v_quota := 1;
    ELSE
      UPDATE public.credit_balances
         SET balance = balance - _max_credits,
             lifetime_spent = lifetime_spent + _max_credits
       WHERE workspace_id = _workspace_id AND balance >= _max_credits;
      IF FOUND THEN
        v_billing := 'credits';
        v_credits := _max_credits;
      ELSE
        RETURN jsonb_build_object('status', 'insufficient');
      END IF;
    END IF;
  ELSE
    v_billing := _billing_class;
  END IF;

  -- The ceiling: an atomic conditional increment of the shared day row, last
  -- (it is the one lock every workspace shares).
  IF v_billing <> 'byok' THEN
    INSERT INTO public.ai_budget_days (day) VALUES (v_day) ON CONFLICT (day) DO NOTHING;
    UPDATE public.ai_budget_days
       SET spent_micros = spent_micros + _max_cost_micros, updated_at = now()
     WHERE day = v_day
       AND spent_micros + _max_cost_micros <= v_settings.daily_budget_micros;
    IF NOT FOUND THEN
      IF v_quota > 0 THEN
        UPDATE public.workspace_ai_quota
           SET platform_credits_remaining = platform_credits_remaining + v_quota,
               lifetime_platform_used = GREATEST(lifetime_platform_used - v_quota, 0)
         WHERE workspace_id = _workspace_id;
      END IF;
      IF v_credits > 0 THEN
        UPDATE public.credit_balances
           SET balance = balance + v_credits,
               lifetime_spent = GREATEST(lifetime_spent - v_credits, 0)
         WHERE workspace_id = _workspace_id;
      END IF;
      RETURN jsonb_build_object('status', 'budget_exhausted');
    END IF;
    v_budget := _max_cost_micros;
  END IF;

  IF v_found THEN
    UPDATE public.ai_spend_reservations
       SET user_id = _user_id, source = _source, model = _model,
           max_input_tokens = _max_input_tokens, max_output_tokens = _max_output_tokens,
           max_cost_micros = _max_cost_micros,
           max_credits = CASE WHEN v_billing = 'credits' THEN _max_credits ELSE 0 END,
           billing = v_billing, status = 'held', hold_seq = v_seq,
           budget_day = CASE WHEN v_billing = 'byok' THEN NULL ELSE v_day END,
           budget_micros = v_budget, quota_units = v_quota, credits_charged = 0,
           reserved_at = now(), provider_called_at = NULL, settled_at = NULL, released_at = NULL,
           input_tokens = NULL, cached_input_tokens = NULL, output_tokens = NULL,
           reasoning_tokens = NULL, actual_cost_micros = NULL, close_reason = NULL,
           updated_at = now()
     WHERE workspace_id = _workspace_id AND request_id = _request_id;
  ELSE
    INSERT INTO public.ai_spend_reservations (
      workspace_id, request_id, user_id, feature, source, model,
      max_input_tokens, max_output_tokens, max_cost_micros, max_credits,
      billing, status, hold_seq, budget_day, budget_micros, quota_units)
    VALUES (
      _workspace_id, _request_id, _user_id, _feature, _source, _model,
      _max_input_tokens, _max_output_tokens, _max_cost_micros,
      CASE WHEN v_billing = 'credits' THEN _max_credits ELSE 0 END,
      v_billing, 'held', v_seq, CASE WHEN v_billing = 'byok' THEN NULL ELSE v_day END,
      v_budget, v_quota);
  END IF;

  IF v_credits > 0 THEN
    INSERT INTO public.credit_ledger (workspace_id, delta, reason, ai_model, ref_type, ref_id, metadata)
    VALUES (_workspace_id, -v_credits, 'ai_hold', _model, 'ai_spend',
            _request_id::text || '#' || v_seq,
            jsonb_build_object('feature', _feature, 'source', _source, 'max_cost_micros', _max_cost_micros));
  END IF;

  RETURN jsonb_build_object('status', 'reserved', 'billing', v_billing, 'hold_seq', v_seq);
END;
$$;

-- held → called, immediately before the provider request. True only for the
-- call that made the transition; false means another request owns this id's
-- call, the hold was released or expired, or the kill switch (or, for page
-- generation, the pause) went on since the hold was taken — in every case
-- the caller must NOT call the provider (and releases what it holds).
CREATE OR REPLACE FUNCTION public.ai_mark_called(_workspace_id uuid, _request_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.ai_spend_reservations%ROWTYPE;
  v_enabled boolean;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ai_spend:' || _workspace_id::text));
  SELECT * INTO r FROM public.ai_spend_reservations
   WHERE workspace_id = _workspace_id AND request_id = _request_id
   FOR UPDATE;
  IF NOT FOUND OR r.status <> 'held' THEN
    RETURN false;
  END IF;
  IF r.billing <> 'byok' THEN
    SELECT platform_ai_enabled INTO v_enabled FROM public.ai_platform_settings WHERE id;
    IF v_enabled IS DISTINCT FROM true THEN
      RETURN false;
    END IF;
  END IF;
  IF r.feature = 'page_generation' AND public._ai_generation_paused() THEN
    RETURN false;
  END IF;
  UPDATE public.ai_spend_reservations
     SET status = 'called', provider_called_at = now(), updated_at = now()
   WHERE workspace_id = _workspace_id AND request_id = _request_id AND status = 'held';
  RETURN FOUND;
END;
$$;

-- called → settled (see _ai_settle_row). Idempotent: a second settle of the
-- same request returns 'already_settled' and moves nothing.
CREATE OR REPLACE FUNCTION public.ai_settle(
  _workspace_id uuid,
  _request_id uuid,
  _input_tokens int,
  _cached_input_tokens int,
  _output_tokens int,
  _reasoning_tokens int,
  _cost_micros bigint,
  _credits int,
  _outcome text,
  _error text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF _workspace_id IS NULL OR _request_id IS NULL THEN
    RAISE EXCEPTION 'ai_settle: workspace and request id are required' USING ERRCODE = '22023';
  END IF;
  IF _outcome IS NULL OR _outcome NOT IN ('ok','failed') THEN
    RAISE EXCEPTION 'ai_settle: outcome must be ok or failed' USING ERRCODE = '22023';
  END IF;
  IF _error IS NOT NULL AND _error !~ '^[a-z_]{1,40}$' THEN
    RAISE EXCEPTION 'ai_settle: error must be a short failure code' USING ERRCODE = '22023';
  END IF;
  IF (_cost_micros IS NULL) <> (_credits IS NULL) OR _cost_micros < 0 OR _credits < 0
     OR _input_tokens < 0 OR _cached_input_tokens < 0 OR _output_tokens < 0 OR _reasoning_tokens < 0 THEN
    RAISE EXCEPTION 'ai_settle: invalid usage' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ai_spend:' || _workspace_id::text));
  RETURN public._ai_settle_row(_workspace_id, _request_id, _input_tokens, _cached_input_tokens,
                               _output_tokens, _reasoning_tokens, _cost_micros, _credits,
                               _outcome, _error,
                               CASE WHEN _cost_micros IS NULL THEN 'full_hold' ELSE 'provider_usage' END);
END;
$$;

-- held → released (the provider was never called). Idempotent: false for a
-- row that is not held, including one that was called — a called request is
-- settled, never released.
CREATE OR REPLACE FUNCTION public.ai_release(_workspace_id uuid, _request_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ai_spend:' || _workspace_id::text));
  RETURN public._ai_release_row(_workspace_id, _request_id, 'released_before_call');
END;
$$;

-- The reaper. Independent of traffic: pg_cron runs it every 5 minutes, so a
-- hold whose worker died ends within 15 minutes (release, full refund) and a
-- call that was never settled within 35 minutes (full hold). It takes every
-- affected workspace's lock (sorted, before touching any row), so it cannot
-- deadlock with ai_reserve / ai_settle; one reaper at a time.
CREATE OR REPLACE FUNCTION public.ai_reap_stale_reservations()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspaces uuid[];
  v_ws uuid;
  v_counts int[];
  v_released int := 0;
  v_settled int := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('ai_spend:reaper')) THEN
    RETURN jsonb_build_object('skipped', true, 'released', 0, 'settled', 0);
  END IF;
  SELECT COALESCE(array_agg(DISTINCT workspace_id ORDER BY workspace_id), ARRAY[]::uuid[])
    INTO v_workspaces
    FROM public.ai_spend_reservations
   WHERE (status = 'held' AND reserved_at < now() - interval '10 minutes')
      OR (status = 'called' AND provider_called_at < now() - interval '30 minutes');
  FOREACH v_ws IN ARRAY v_workspaces LOOP
    PERFORM pg_advisory_xact_lock(hashtext('ai_spend:' || v_ws::text));
  END LOOP;
  FOREACH v_ws IN ARRAY v_workspaces LOOP
    v_counts := public._ai_expire_workspace(v_ws);
    v_released := v_released + v_counts[1];
    v_settled := v_settled + v_counts[2];
  END LOOP;
  RETURN jsonb_build_object('skipped', false, 'released', v_released, 'settled', v_settled);
END;
$$;

-- 7) The daily briefing's claim ----------------------------------------------------
-- One stored briefing per (workspace, UTC date). 'exists' once stored;
-- 'claimed' for the one run that may generate it; 'in_progress' for every
-- other run while that claim is fresh (3 minutes covers the 60 s AI timeout
-- with room to spare; a claim older than that is taken over). The AI call
-- itself is additionally idempotent through ai_reserve (a deterministic
-- request id per workspace and date), so a takeover can never make a second
-- AI call either.
CREATE OR REPLACE FUNCTION public.coach_briefing_claim(
  _workspace_id uuid,
  _briefing_date date,
  _claim_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE c public.coach_briefing_claims%ROWTYPE;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF _workspace_id IS NULL OR _briefing_date IS NULL OR _claim_token IS NULL THEN
    RAISE EXCEPTION 'coach_briefing_claim: missing argument' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('coach_briefing:' || _workspace_id::text || ':' || _briefing_date::text));
  IF EXISTS (SELECT 1 FROM public.coach_daily_briefings
              WHERE workspace_id = _workspace_id AND briefing_date = _briefing_date) THEN
    RETURN jsonb_build_object('status', 'exists');
  END IF;
  SELECT * INTO c FROM public.coach_briefing_claims
   WHERE workspace_id = _workspace_id AND briefing_date = _briefing_date
   FOR UPDATE;
  IF FOUND THEN
    IF c.claim_token <> _claim_token AND c.claimed_at > now() - interval '3 minutes' THEN
      RETURN jsonb_build_object('status', 'in_progress');
    END IF;
    UPDATE public.coach_briefing_claims
       SET claim_token = _claim_token, claimed_at = now()
     WHERE workspace_id = _workspace_id AND briefing_date = _briefing_date;
  ELSE
    INSERT INTO public.coach_briefing_claims (workspace_id, briefing_date, claim_token)
    VALUES (_workspace_id, _briefing_date, _claim_token);
  END IF;
  RETURN jsonb_build_object('status', 'claimed');
END;
$$;

-- Store the day's briefing — only for the run that holds the claim, and only
-- once (the table is UNIQUE (workspace_id, briefing_date); never overwritten).
CREATE OR REPLACE FUNCTION public.coach_briefing_store(
  _workspace_id uuid,
  _briefing_date date,
  _claim_token uuid,
  _insights jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF _insights IS NULL OR jsonb_typeof(_insights) <> 'array' OR jsonb_array_length(_insights) > 5 THEN
    RAISE EXCEPTION 'coach_briefing_store: insights must be an array of at most 5' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('coach_briefing:' || _workspace_id::text || ':' || _briefing_date::text));
  IF EXISTS (SELECT 1 FROM public.coach_daily_briefings
              WHERE workspace_id = _workspace_id AND briefing_date = _briefing_date) THEN
    RETURN jsonb_build_object('status', 'exists');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.coach_briefing_claims
                  WHERE workspace_id = _workspace_id AND briefing_date = _briefing_date
                    AND claim_token = _claim_token) THEN
    RETURN jsonb_build_object('status', 'lost_claim');
  END IF;
  INSERT INTO public.coach_daily_briefings (workspace_id, briefing_date, insights, generated_at, viewed_at)
  VALUES (_workspace_id, _briefing_date, _insights, now(), NULL)
  ON CONFLICT (workspace_id, briefing_date) DO NOTHING;
  DELETE FROM public.coach_briefing_claims
   WHERE workspace_id = _workspace_id AND briefing_date = _briefing_date;
  RETURN jsonb_build_object('status', 'stored');
END;
$$;

-- 8) Service role only, every one of them -------------------------------------------
DO $$
DECLARE sig text;
BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'public._ai_generation_paused()',
    'public._ai_release_row(uuid,uuid,text)',
    'public._ai_settle_row(uuid,uuid,int,int,int,int,bigint,int,text,text,text)',
    'public._ai_expire_workspace(uuid)',
    'public.ai_reserve(uuid,uuid,uuid,text,text,text,int,int,bigint,int,text)',
    'public.ai_mark_called(uuid,uuid)',
    'public.ai_settle(uuid,uuid,int,int,int,int,bigint,int,text,text)',
    'public.ai_release(uuid,uuid)',
    'public.ai_reap_stale_reservations()',
    'public.coach_briefing_claim(uuid,date,uuid)',
    'public.coach_briefing_store(uuid,date,uuid,jsonb)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
  END LOOP;
END $$;

-- 9) The reaper's schedule: every 5 minutes, pure SQL (no HTTP, no secret) -----------
-- pg_cron is already installed in production (20260825122000, 20260923000200);
-- created here only where it is available but missing. Without the cron
-- schema the schedule below fails loudly — the reaper is not optional.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION pg_cron;
  END IF;
END $$;
DO $$ BEGIN PERFORM cron.unschedule('ai-reap-stale-reservations'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
SELECT cron.schedule(
  'ai-reap-stale-reservations',
  '*/5 * * * *',
  $CRON$ SELECT public.ai_reap_stale_reservations(); $CRON$
);

-- ---------------------------------------------------------------------------
-- Verification — every row should read true.
-- ---------------------------------------------------------------------------
SELECT 'ai_platform_settings: one row, kill switch on, $10.00/day ceiling by default' AS check,
       (SELECT count(*) = 1 FROM public.ai_platform_settings)
       AND EXISTS (SELECT 1 FROM public.ai_platform_settings WHERE id AND daily_budget_micros >= 0) AS ok
UNION ALL SELECT 'ai tables: RLS on, no policies',
       (SELECT bool_and(c.relrowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relname IN ('ai_platform_settings','ai_budget_days','ai_spend_reservations','coach_briefing_claims'))
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                        AND tablename IN ('ai_platform_settings','ai_budget_days','ai_spend_reservations','coach_briefing_claims'))
UNION ALL SELECT 'ai tables: not readable or writable by anon or authenticated',
       NOT has_table_privilege('anon', 'public.ai_spend_reservations', 'SELECT')
       AND NOT has_table_privilege('authenticated', 'public.ai_spend_reservations', 'SELECT')
       AND NOT has_table_privilege('authenticated', 'public.ai_spend_reservations', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.ai_platform_settings', 'SELECT')
       AND NOT has_table_privilege('authenticated', 'public.ai_platform_settings', 'UPDATE')
       AND NOT has_table_privilege('anon', 'public.ai_platform_settings', 'UPDATE')
       AND NOT has_table_privilege('authenticated', 'public.ai_budget_days', 'SELECT')
       AND NOT has_table_privilege('authenticated', 'public.coach_briefing_claims', 'SELECT')
UNION ALL SELECT 'ai functions: service_role only',
       (SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE')
                    AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
                    AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'))
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('_ai_generation_paused','_ai_release_row','_ai_settle_row','_ai_expire_workspace',
                             'ai_reserve','ai_mark_called','ai_settle','ai_release','ai_reap_stale_reservations',
                             'coach_briefing_claim','coach_briefing_store'))
UNION ALL SELECT 'ai functions: all eleven present, SECURITY DEFINER with a pinned search_path',
       (SELECT count(*) = 11 AND bool_and(p.prosecdef)
               AND bool_and(array_to_string(p.proconfig, ',') LIKE '%search_path=public%')
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('_ai_generation_paused','_ai_release_row','_ai_settle_row','_ai_expire_workspace',
                             'ai_reserve','ai_mark_called','ai_settle','ai_release','ai_reap_stale_reservations',
                             'coach_briefing_claim','coach_briefing_store'))
UNION ALL SELECT 'ai_reserve: the workspace lock is taken before anything is counted or charged',
       (SELECT position('pg_advisory_xact_lock' IN prosrc) > 0
           AND position('pg_advisory_xact_lock' IN prosrc) < position('count(*)' IN prosrc)
           AND position('pg_advisory_xact_lock' IN prosrc) < position('UPDATE public.credit_balances' IN prosrc)
          FROM pg_proc WHERE oid = 'public.ai_reserve(uuid,uuid,uuid,text,text,text,int,int,bigint,int,text)'::regprocedure)
UNION ALL SELECT 'ai_reserve: the ceiling is a conditional increment',
       (SELECT prosrc LIKE '%spent_micros + _max_cost_micros <= v_settings.daily_budget_micros%'
          FROM pg_proc WHERE oid = 'public.ai_reserve(uuid,uuid,uuid,text,text,text,int,int,bigint,int,text)'::regprocedure)
UNION ALL SELECT 'ai_reserve: credits are a conditional decrement',
       (SELECT prosrc LIKE '%balance >= _max_credits%'
          FROM pg_proc WHERE oid = 'public.ai_reserve(uuid,uuid,uuid,text,text,text,int,int,bigint,int,text)'::regprocedure)
UNION ALL SELECT 'the ledger makes a double hold or refund impossible',
       EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
                 AND indexname = 'credit_ledger_ai_spend_uidx'
                 AND indexdef LIKE '%(workspace_id, ref_id, reason)%'
                 AND indexdef LIKE '%ai_spend%')
UNION ALL SELECT 'a released reservation can never have been called (schema check)',
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_spend_release_never_called')
UNION ALL SELECT 'the model allowlist is enforced by the schema',
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_spend_model_check')
UNION ALL SELECT 'superseded: settle_generation_free_quota and its index are gone',
       to_regprocedure('public.settle_generation_free_quota(uuid,text,text,text)') IS NULL
       AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'credit_ledger_generation_settlement_uidx')
UNION ALL SELECT 'the reaper is scheduled every 5 minutes',
       EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai-reap-stale-reservations'
                 AND schedule = '*/5 * * * *' AND command LIKE '%ai_reap_stale_reservations%');
