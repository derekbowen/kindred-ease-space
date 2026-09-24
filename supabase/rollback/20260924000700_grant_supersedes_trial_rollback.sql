-- ROLLBACK for 20260924000700_grant_supersedes_trial.sql
-- Restores the 20260918000000 body of workspace_capacity verbatim: a grant
-- rescues only a workspace Stripe would refuse, so a beta tenant still inside
-- its 14-day trial reads as 'trialing' again — Trial badge, "pick a plan"
-- countdown, metered generation, and the trial's 25-page base added on top
-- of the grant. That is the audited defect, so roll back only to unblock a
-- broken build, then re-apply. The service_role-only grants are kept. No data
-- changes are involved either way: the function is evaluated at read time and
-- stores nothing. The application half (decideCapacity in
-- src/lib/billing-capacity.ts) is not restored by this file; redeploy the
-- previous Worker version if the two must agree during the rollback window.
BEGIN;
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

  -- An active grant rescues a workspace Stripe would refuse, and reports the
  -- distinct 'granted' state so the UI can say "Beta access" rather than
  -- "Subscription active".
  IF v_granted > 0 AND NOT v_stripe_pub THEN
    v_state := 'granted';
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
COMMIT;
-- VERIFY (rolled back): expect supersedes_trial = false, zeroes_paid = false,
-- service_role_only = true
SELECT prosrc LIKE '%OR v_state = ''trialing''%' AS supersedes_trial,
       prosrc LIKE '%v_paid := 0;%' AS zeroes_paid,
       NOT has_function_privilege('anon', oid, 'EXECUTE')
         AND has_function_privilege('service_role', oid, 'EXECUTE') AS service_role_only
  FROM pg_proc WHERE oid = 'public.workspace_capacity(uuid)'::regprocedure;
