-- ============================================================================
-- ADMIN ENTITLEMENT GRANTS — free beta/test accounts without Stripe.
--
-- Two things, deliberately in one migration because they touch the same gate:
--
--   1. workspace_entitlement_grants: append-only record of capacity granted by
--      a platform admin. No Stripe object is created; no $0 subscription.
--
--   2. THE DIVERGENCE FIX. publish_tenant_pages() summed
--      base + addon + bonus and never consulted subscription_status, while the
--      application's decideCapacity() returned 0 pages for the same workspace.
--      Today every customer workspace is an EXPIRED TRIAL, so the app reported
--      "0 pages" while this function would have published 25. Two enforcement
--      layers disagreeing about authorization is the bug; adding grants to only
--      one of them would have doubled it.
--
-- After this migration both layers derive from the same rule, expressed once in
-- SQL as workspace_capacity() and once in TypeScript as decideCapacity(). They
-- are two implementations on purpose — the app needs a pure function it can
-- evaluate without a round trip — so tests/entitlement-grants.test.ts asserts
-- they agree across every entitlement state.
--
-- THE RULE, both layers:
--   paidPages  = stripe_publish ? base + addon + bonus : 0
--   grantPages = sum(page_limit) over grants active now
--   effective  = paidPages + grantPages        -- additive, never greater-of
--   publish    = stripe_publish OR grantPages > 0
--   serve      = stripe_serve   OR grantPages > 0
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The grant table.
--
-- APPEND-ONLY BY DESIGN. Editing a grant is revoke + replace, never an in-place
-- rewrite, so the record of what was granted and by whom cannot be altered
-- after the fact. That is also why there is no updated_at: a row that can be
-- edited is not an audit record. `revoked_at` is the single exception and is
-- the only column any later statement may set.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.workspace_entitlement_grants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  grant_type   text NOT NULL CHECK (grant_type IN ('trial','beta','promotional','manual')),
  page_limit   int  NOT NULL CHECK (page_limit >= 0 AND page_limit <= 1000000),
  starts_at    timestamptz NOT NULL DEFAULT now(),
  -- NULL means NEVER EXPIRES. This is the opposite of page_limit_bonus, whose
  -- gate required `page_bonus_expires_at IS NOT NULL AND > now()` — there a
  -- NULL expiry silently disabled the bonus, so a permanent grant was
  -- impossible to express. Here NULL is the permanent case, checked explicitly.
  expires_at   timestamptz,
  revoked_at   timestamptz,
  granted_by   uuid NOT NULL REFERENCES auth.users(id),
  -- Mandatory and non-empty. An entitlement override with no stated reason is
  -- unreviewable three months later, which is exactly when it gets reviewed.
  reason       text NOT NULL CHECK (length(btrim(reason)) > 0),
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grant_window_valid CHECK (expires_at IS NULL OR expires_at > starts_at)
);

-- The hot path is "active grants for this workspace", evaluated on every
-- entitlement read and every publish.
CREATE INDEX IF NOT EXISTS weg_active_idx
  ON public.workspace_entitlement_grants (workspace_id, starts_at, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS weg_workspace_created_idx
  ON public.workspace_entitlement_grants (workspace_id, created_at DESC);

ALTER TABLE public.workspace_entitlement_grants ENABLE ROW LEVEL SECURITY;

-- Members may SEE that their workspace has a grant — the UI has to be able to
-- say "Beta access, 50 pages, until 17 Oct". They may not see who granted it or
-- why; those are operator notes, surfaced only through the admin path which
-- reads with the service role.
CREATE POLICY "members read own workspace grants"
  ON public.workspace_entitlement_grants
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- PRIVILEGES ARE STATED EXPLICITLY, in both directions. Found during branch
-- validation, and worth spelling out because the first version of this file got
-- it wrong in a way that only a rebuild reveals:
--
--   * Supabase's ALTER DEFAULT PRIVILEGES grants SELECT on new public tables to
--     BOTH anon and authenticated. On production that made the read policy below
--     work by accident — and silently handed `anon` a read privilege this design
--     never intended. Only RLS was standing in front of it.
--   * A preview branch does not carry those default privileges. There,
--     `authenticated` had no SELECT at all, so the policy below was dead code and
--     a member could not see their own grant.
--
-- The same file therefore behaved differently in two environments, in opposite
-- directions. Neither is acceptable for an entitlement table, so nothing here is
-- left to a default.
GRANT SELECT ON public.workspace_entitlement_grants TO authenticated;

-- WRITES ARE TABLE-PRIVILEGE DENIED, not merely policy-denied. This is the
-- lesson of 20260830010000_lock_entitlement_writes.sql: a permissive USING
-- clause scoped by workspace still lets a member write ANY column of a row they
-- can see, so a workspace owner could have granted themselves capacity. RLS
-- alone is the wrong mechanism for this; the privilege is.
REVOKE INSERT, UPDATE, DELETE ON public.workspace_entitlement_grants FROM authenticated, anon;

-- `anon` gets nothing at all. Who has been given free capacity, and why, is not
-- public. Relying on RLS to return zero rows to an unauthenticated caller would
-- work, but it makes a disclosure boundary depend on a policy staying correct
-- rather than on the privilege never being there.
REVOKE ALL ON public.workspace_entitlement_grants FROM anon;

-- ---------------------------------------------------------------------------
-- 2. Active-grant capacity. One definition, used by every caller.
--
-- Expiry and activation are TIMESTAMP COMPARISONS AT READ TIME. Nothing has to
-- sweep expired grants for expiry to take effect — a cron that must run for an
-- entitlement to lapse is a cron whose failure silently hands out free capacity.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.workspace_granted_pages(_workspace_id uuid)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(sum(page_limit), 0)::int
    FROM public.workspace_entitlement_grants
   WHERE workspace_id = _workspace_id
     AND revoked_at IS NULL
     AND starts_at <= now()
     AND (expires_at IS NULL OR expires_at > now());
$$;

REVOKE ALL ON FUNCTION public.workspace_granted_pages(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_granted_pages(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. workspace_capacity() — the SQL half of the shared rule.
--
-- Mirrors src/lib/billing-capacity.ts decideCapacity() case for case, including
-- its two constants: PAST_DUE_GRACE_DAYS = 7, STALE_PERIOD_DAYS = 45. If either
-- file changes, the parity test in tests/entitlement-grants.test.ts fails.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 4. The publish gate, now deriving its limit from the shared rule.
--
-- Unchanged: the advisory lock, the oldest-first partial publish, the return
-- shape. Changed: v_limit comes from workspace_capacity(), so an expired trial
-- or a revoked grant can no longer publish through the RPC while the
-- application reports zero capacity.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.publish_tenant_pages(
  _workspace_id uuid,
  _page_ids uuid[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int;
  v_publish boolean;
  v_published int;
  v_remaining int;
  v_requested int;
  v_to_publish uuid[];
  v_count int := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('publish:' || _workspace_id::text));

  SELECT c.page_limit, c.publish INTO v_limit, v_publish
    FROM public.workspace_capacity(_workspace_id) c;
  IF v_limit IS NULL THEN
    RAISE EXCEPTION 'workspace_not_found';
  END IF;
  -- Belt and braces: page_limit is already 0 when publish is false, but an
  -- explicit refusal keeps the two from ever drifting apart again.
  IF NOT v_publish THEN
    v_limit := 0;
  END IF;

  SELECT count(*) INTO v_published
    FROM public.tenant_pages
   WHERE workspace_id = _workspace_id AND status = 'published';

  v_remaining := GREATEST(v_limit - v_published, 0);

  SELECT count(*) INTO v_requested
    FROM public.tenant_pages
   WHERE workspace_id = _workspace_id
     AND id = ANY(_page_ids)
     AND status <> 'published';

  IF v_remaining > 0 AND v_requested > 0 THEN
    SELECT array_agg(id) INTO v_to_publish FROM (
      SELECT id FROM public.tenant_pages
       WHERE workspace_id = _workspace_id
         AND id = ANY(_page_ids)
         AND status <> 'published'
       ORDER BY created_at
       LIMIT v_remaining
    ) s;
    IF v_to_publish IS NOT NULL THEN
      UPDATE public.tenant_pages
         SET status = 'published',
             published_at = COALESCE(published_at, now())
       WHERE id = ANY(v_to_publish);
      GET DIAGNOSTICS v_count = ROW_COUNT;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'published', v_count,
    'denied', v_requested - v_count,
    'limit', v_limit,
    'published_total', v_published + v_count,
    'remaining', GREATEST(v_limit - v_published - v_count, 0)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Verification. Every row must read true.
-- ---------------------------------------------------------------------------
SELECT 'grants table exists' AS check,
       to_regclass('public.workspace_entitlement_grants') IS NOT NULL AS ok
UNION ALL SELECT 'grants not writable by authenticated',
       NOT has_table_privilege('authenticated', 'public.workspace_entitlement_grants', 'INSERT')
UNION ALL SELECT 'grants not updatable by authenticated',
       NOT has_table_privilege('authenticated', 'public.workspace_entitlement_grants', 'UPDATE')
UNION ALL SELECT 'grants not deletable by authenticated',
       NOT has_table_privilege('authenticated', 'public.workspace_entitlement_grants', 'DELETE')
UNION ALL SELECT 'grants not writable by anon',
       NOT has_table_privilege('anon', 'public.workspace_entitlement_grants', 'INSERT')
UNION ALL SELECT 'grants readable by authenticated (RLS-scoped)',
       has_table_privilege('authenticated', 'public.workspace_entitlement_grants', 'SELECT')
UNION ALL SELECT 'grants NOT readable by anon',
       NOT has_table_privilege('anon', 'public.workspace_entitlement_grants', 'SELECT')
UNION ALL SELECT 'RLS enabled on grants',
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.workspace_entitlement_grants'::regclass)
UNION ALL SELECT 'workspace_capacity not executable by anon',
       NOT has_function_privilege('anon', 'public.workspace_capacity(uuid)', 'EXECUTE')
UNION ALL SELECT 'workspace_capacity not executable by authenticated',
       NOT has_function_privilege('authenticated', 'public.workspace_capacity(uuid)', 'EXECUTE')
UNION ALL SELECT 'workspace_granted_pages not executable by authenticated',
       NOT has_function_privilege('authenticated', 'public.workspace_granted_pages(uuid)', 'EXECUTE')
UNION ALL SELECT 'publish gate still SECURITY DEFINER',
       (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'publish_tenant_pages')
UNION ALL SELECT 'publish gate no longer reads columns directly',
       (SELECT prosrc LIKE '%workspace_capacity%' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'publish_tenant_pages');

-- ROLLBACK (verified safe: nothing read this table before this migration):
--   DROP FUNCTION IF EXISTS public.workspace_capacity(uuid);
--   DROP FUNCTION IF EXISTS public.workspace_granted_pages(uuid);
--   DROP TABLE IF EXISTS public.workspace_entitlement_grants;
--   then restore publish_tenant_pages from 20260827030000_page_entitlements.sql.
-- Dropping the table alone is NOT sufficient — publish_tenant_pages would then
-- reference a missing function and every publish would fail closed. Restore the
-- old function body in the same transaction.
