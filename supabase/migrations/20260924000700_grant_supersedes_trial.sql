-- ============================================================================
-- A GRANT SUPERSEDES A TRIAL. It never supersedes a paid subscription.
--
-- workspace_capacity() (20260918000000) reported the Stripe state whenever
-- Stripe alone would let the workspace publish, and fell back to 'granted'
-- only when Stripe refused. A live trial publishes, and every workspace is
-- provisioned as a 14-day trial, so a marketplace accepted into the beta spent
-- its first fortnight in state 'trialing': a Trial badge, a countdown to
-- "pick a plan", "Free trial" on the billing page, no beta banner — and,
-- because generation is included only for billingState 'granted'
-- (isGenerationGranted in src/lib/generation.server.ts), METERED generation,
-- the opposite of what /beta promises. The same two weeks also added the
-- trial's 25-page base to the grant, so a 50-page grant read as 75.
--
-- A trial is not a paid entitlement. When a grant is active and the only
-- Stripe entitlement is a trial, the state is 'granted' and the grant is the
-- whole allowance. An active paid subscription is untouched: the state stays
-- commercial and the grant still adds pages, exactly as before.
--
-- The application half is the same one-condition change in decideCapacity()
-- (src/lib/billing-capacity.ts); tests/entitlement-grants.test.ts holds the
-- table both halves must satisfy and checks this file's text against it.
--
-- THE RULE, both layers:
--   grantPages = sum(page_limit) over grants active now
--   granted    = grantPages > 0 AND (NOT stripe_publish OR stripe_state = trialing)
--   paidPages  = stripe_publish AND NOT granted ? base + addon + bonus : 0
--   effective  = paidPages + grantPages        -- additive, never greater-of
--   publish    = stripe_publish OR grantPages > 0
--   serve      = stripe_serve   OR grantPages > 0
-- and, before all of it:
--   internal   = an active grant_type 'internal' grant exists
--                → state 'internal', serve, publish, no page limit
--
-- No backfill: verified 2026-09-24 there are 0 active grants and 0 trialing
-- workspaces holding one, so no stored value changes meaning; the function is
-- evaluated at read time and stores nothing. The body below is the
-- 20260918000000 body verbatim except for two blocks: the internal branch
-- right after the workspace lookup (below) and the final block. The grants
-- are restated so this file is correct on its own.
--
-- ALSO HERE (2026-09-25, owner request): THE FOUNDER / INTERNAL UNLIMITED
-- ENTITLEMENT, built on the same grants table instead of a side channel:
--
--   grant_type 'internal' ("Founder / Internal Unlimited") — per workspace,
--   written by the service role only (the table has no write privilege for
--   anon/authenticated), append-only, reason mandatory, like every grant. An
--   ACTIVE internal grant (not revoked, started, not expired; expires_at NULL
--   = permanent) makes the workspace INTERNAL UNLIMITED. Nothing is derived
--   from an email address, a platform role or anything the client sends.
--
--   workspace_is_internal_unlimited(uuid) — THE predicate (service role
--   only), read fresh by every server-side usage check: workspace_capacity
--   below, ai_reserve (20260925000800: no tenant funds on any route, exempt
--   from the per-workspace daily AI cost cap, still under the kill switch,
--   the platform ceiling and the rate limit), and the application's
--   isInternalUnlimited (src/lib/entitlement-grants.server.ts).
--
--   workspace_capacity: an internal workspace reads state 'internal', serve
--   and publish true, page_limit 2147483647 (no limit), whatever Stripe says —
--   evaluated first, before any other rule. decideCapacity() in
--   src/lib/billing-capacity.ts is the same rule; tests/entitlement-grants
--   runs both against one table.
--
--   An internal grant always carries page_limit 1000000 (the CHECK maximum),
--   so every reader that only SUMS grants (the public page gate, the tenant
--   sitemap) serves the workspace too.
--
-- Rollback: supabase/rollback/20260924000700_grant_supersedes_trial_rollback.sql
-- ============================================================================

-- 1) The 'internal' grant type ------------------------------------------------
-- The 20260918 column CHECK is replaced (found by definition, whatever its
-- name), then restated with 'internal' plus the rule that an internal grant
-- is the maximum page grant. Re-running drops and re-adds both.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.workspace_entitlement_grants'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%grant_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.workspace_entitlement_grants DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.workspace_entitlement_grants
  ADD CONSTRAINT workspace_entitlement_grants_grant_type_check
  CHECK (grant_type IN ('trial','beta','promotional','manual','internal'));
ALTER TABLE public.workspace_entitlement_grants
  ADD CONSTRAINT workspace_entitlement_grants_internal_page_limit
  CHECK (grant_type <> 'internal' OR page_limit = 1000000);

-- 2) THE predicate ---------------------------------------------------------------
-- Same active-grant rule as workspace_granted_pages (20260918): a timestamp
-- comparison at read time, so revoking or expiring the grant takes effect on
-- the next read with nothing to sweep.
CREATE OR REPLACE FUNCTION public.workspace_is_internal_unlimited(_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.workspace_entitlement_grants
     WHERE workspace_id = _workspace_id
       AND grant_type = 'internal'
       AND revoked_at IS NULL
       AND starts_at <= now()
       AND (expires_at IS NULL OR expires_at > now()));
$$;

REVOKE ALL ON FUNCTION public.workspace_is_internal_unlimited(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_is_internal_unlimited(uuid) TO service_role;

-- 3) workspace_capacity ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.workspace_capacity(_workspace_id uuid)
RETURNS TABLE (state text, serve boolean, publish boolean, page_limit int)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w              record;
  v_status       text;
  v_granted      int;
  v_stripe_serve boolean := false;
  v_stripe_pub   boolean := false;
  v_state        text;
  v_paid         int := 0;
  v_deadline     timestamptz;
  PAST_DUE_GRACE CONSTANT int := 7;
  STALE_PERIOD   CONSTANT int := 45;
BEGIN
  SELECT subscription_status, trial_ends_at, current_period_end,
         page_limit_base, page_limit_addon, page_limit_bonus, page_bonus_expires_at
    INTO w
    FROM public.workspaces WHERE id = _workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace_not_found';
  END IF;

  -- The founder / internal unlimited entitlement: first and alone, so no
  -- Stripe state can narrow it. No page limit (int4 max), always serves and
  -- publishes. Mirrors decideCapacity()'s internalUnlimited branch.
  IF public.workspace_is_internal_unlimited(_workspace_id) THEN
    RETURN QUERY SELECT 'internal'::text, true, true, 2147483647;
    RETURN;
  END IF;

  v_status  := lower(btrim(COALESCE(w.subscription_status::text, '')));
  v_granted := public.workspace_granted_pages(_workspace_id);

  -- The Stripe half, mirroring decideCapacity()'s switch exactly.
  IF v_status = 'active' THEN
    IF w.current_period_end IS NOT NULL
       AND now() - w.current_period_end > (STALE_PERIOD || ' days')::interval THEN
      v_state := 'stale';                       -- serve=false, publish=false
    ELSE
      v_state := 'active';  v_stripe_serve := true;  v_stripe_pub := true;
    END IF;

  ELSIF v_status = 'trialing' THEN
    IF w.trial_ends_at IS NULL THEN
      v_state := 'unknown'; v_stripe_serve := true;  -- serve, do not publish
    ELSIF now() >= w.trial_ends_at THEN
      v_state := 'trial_expired';
    ELSE
      v_state := 'trialing'; v_stripe_serve := true; v_stripe_pub := true;
    END IF;

  ELSIF v_status = 'past_due' THEN
    v_deadline := COALESCE(w.current_period_end, now()) + (PAST_DUE_GRACE || ' days')::interval;
    IF now() < v_deadline THEN
      v_state := 'grace';   v_stripe_serve := true;
    ELSE
      v_state := 'lapsed';
    END IF;

  ELSIF v_status IN ('canceled','cancelled') THEN
    IF w.current_period_end IS NOT NULL AND now() < w.current_period_end THEN
      v_state := 'grace';   v_stripe_serve := true;
    ELSE
      v_state := 'lapsed';
    END IF;

  ELSIF v_status IN ('unpaid','incomplete','incomplete_expired','paused') THEN
    v_state := 'lapsed';

  ELSE
    -- '' (no status recorded) and anything unrecognised: fail OPEN on serving,
    -- closed on publishing. We have evidence of silence, not of non-payment.
    v_state := 'unknown';   v_stripe_serve := true;
  END IF;

  -- Paid capacity counts only while Stripe says the workspace may publish.
  -- A lapsed plan contributes nothing, whatever page_limit_base still says —
  -- that is what stops a missed webhook reading as a permanent grant.
  IF v_stripe_pub THEN
    v_paid := w.page_limit_base + w.page_limit_addon
              + CASE WHEN w.page_bonus_expires_at IS NOT NULL
                      AND w.page_bonus_expires_at > now()
                     THEN w.page_limit_bonus ELSE 0 END;
  END IF;

  -- An active grant supersedes a workspace Stripe would refuse AND one whose
  -- only Stripe entitlement is a trial, reporting the distinct 'granted' state
  -- so the UI says "Beta access" rather than "Trial" or "Subscription active".
  -- Paid capacity is zeroed with it: the grant is the whole allowance, which
  -- mirrors effectivePageLimit() counting paid pages only outside 'granted'.
  -- An active paid subscription never reaches this branch.
  IF v_granted > 0 AND (NOT v_stripe_pub OR v_state = 'trialing') THEN
    v_state := 'granted';
    v_paid := 0;
  END IF;

  RETURN QUERY SELECT
    v_state,
    (v_stripe_serve OR v_granted > 0),
    (v_stripe_pub   OR v_granted > 0),
    (v_paid + v_granted);
END;
$$;

REVOKE ALL ON FUNCTION public.workspace_capacity(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_capacity(uuid) TO service_role;

-- Verification: every row should say true.
SELECT 'workspace_capacity: a grant supersedes a trial' AS check,
       (SELECT prosrc LIKE '%IF v_granted > 0 AND (NOT v_stripe_pub OR v_state = ''trialing'') THEN%'
          FROM pg_proc WHERE oid = 'public.workspace_capacity(uuid)'::regprocedure) AS ok
UNION ALL SELECT 'workspace_capacity: the granted state zeroes paid capacity',
       (SELECT prosrc LIKE '%v_paid := 0;%'
          FROM pg_proc WHERE oid = 'public.workspace_capacity(uuid)'::regprocedure)
UNION ALL SELECT 'workspace_capacity: still SECURITY DEFINER',
       (SELECT prosecdef FROM pg_proc WHERE oid = 'public.workspace_capacity(uuid)'::regprocedure)
UNION ALL SELECT 'workspace_capacity: anon cannot execute',
       NOT has_function_privilege('anon', 'public.workspace_capacity(uuid)', 'EXECUTE')
UNION ALL SELECT 'workspace_capacity: authenticated cannot execute',
       NOT has_function_privilege('authenticated', 'public.workspace_capacity(uuid)', 'EXECUTE')
UNION ALL SELECT 'workspace_capacity: service_role can execute',
       has_function_privilege('service_role', 'public.workspace_capacity(uuid)', 'EXECUTE')
UNION ALL SELECT 'workspace_capacity: an internal grant is unlimited, checked first',
       (SELECT prosrc LIKE '%IF public.workspace_is_internal_unlimited(_workspace_id) THEN%'
               AND position('workspace_is_internal_unlimited' IN prosrc) < position('v_granted := public.workspace_granted_pages' IN prosrc)
          FROM pg_proc WHERE oid = 'public.workspace_capacity(uuid)'::regprocedure)
UNION ALL SELECT 'grant types: trial, beta, promotional, manual and internal',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.workspace_entitlement_grants'::regclass
                  AND conname = 'workspace_entitlement_grants_grant_type_check'
                  AND pg_get_constraintdef(oid) LIKE '%internal%')
UNION ALL SELECT 'an internal grant is the maximum page grant (1000000)',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.workspace_entitlement_grants'::regclass
                  AND conname = 'workspace_entitlement_grants_internal_page_limit')
UNION ALL SELECT 'workspace_is_internal_unlimited: SECURITY DEFINER, pinned search_path, service role only',
       (SELECT p.prosecdef AND array_to_string(p.proconfig, ',') LIKE '%search_path=public%'
               AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
               AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
               AND has_function_privilege('service_role', p.oid, 'EXECUTE')
          FROM pg_proc p WHERE p.oid = 'public.workspace_is_internal_unlimited(uuid)'::regprocedure)
UNION ALL SELECT 'grants are still not writable by anon or authenticated',
       NOT has_table_privilege('authenticated', 'public.workspace_entitlement_grants', 'INSERT')
       AND NOT has_table_privilege('authenticated', 'public.workspace_entitlement_grants', 'UPDATE')
       AND NOT has_table_privilege('anon', 'public.workspace_entitlement_grants', 'INSERT')
UNION ALL SELECT 'publish gate still derives its limit from workspace_capacity',
       (SELECT prosrc LIKE '%workspace_capacity%' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'publish_tenant_pages');
