-- ============================================================================
-- Billing rebuild: PAGE ENTITLEMENTS.
-- The product is published-page capacity (Webflow-style hosting subscription);
-- AI credits stay as internal metering only. This migration adds:
--   * entitlement columns on workspaces (base + addon + support bonus)
--   * stripe_webhook_events (webhook idempotency + audit)
--   * billing_events (every billing change traceable)
--   * publish_tenant_pages(): the ATOMIC, concurrency-safe publish gate —
--     survives 1,000 parallel publish requests via an advisory lock.
-- NOTE: the two ALTER TYPE statements must run before anything uses the new
-- enum values; run this file top-to-bottom as-is.
-- ============================================================================

ALTER TYPE public.app_plan ADD VALUE IF NOT EXISTS 'pro';
ALTER TYPE public.app_plan ADD VALUE IF NOT EXISTS 'agency';

-- ---------------------------------------------------------------------------
-- Entitlement columns. Default 25 = free-trial allowance for new workspaces.
-- page_limit_bonus/expiry = admin support override without touching Stripe.
-- ---------------------------------------------------------------------------
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS page_limit_base int NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS page_limit_addon int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS page_limit_bonus int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS page_bonus_expires_at timestamptz;

-- Internal dogfood workspace gets effectively unlimited capacity.
UPDATE public.workspaces SET page_limit_base = 1000000 WHERE is_internal = true;

-- ---------------------------------------------------------------------------
-- Webhook idempotency: Stripe may deliver an event five times; the business
-- action runs once. Service-role only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  stripe_event_id text PRIMARY KEY,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_status text NOT NULL DEFAULT 'processing',
  error text
);
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Billing audit log: reconstruct exactly what happened for any account.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  stripe_event_id text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_events_ws_idx
  ON public.billing_events(workspace_id, created_at DESC);
ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read billing events" ON public.billing_events
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()));

-- ---------------------------------------------------------------------------
-- THE atomic publish gate. All publishing flows call this (via service role):
-- it locks the workspace, computes the effective limit, and flips at most
-- `remaining` of the requested pages to published — no check-then-write race.
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
  v_published int;
  v_remaining int;
  v_requested int;
  v_to_publish uuid[];
  v_count int := 0;
BEGIN
  -- Serialize concurrent publishes for this workspace.
  PERFORM pg_advisory_xact_lock(hashtext('publish:' || _workspace_id::text));

  SELECT page_limit_base + page_limit_addon
         + CASE WHEN page_bonus_expires_at IS NOT NULL AND page_bonus_expires_at > now()
                THEN page_limit_bonus ELSE 0 END
    INTO v_limit
    FROM public.workspaces WHERE id = _workspace_id;
  IF v_limit IS NULL THEN
    RAISE EXCEPTION 'workspace_not_found';
  END IF;

  SELECT count(*) INTO v_published
    FROM public.tenant_pages
   WHERE workspace_id = _workspace_id AND status = 'published';

  v_remaining := GREATEST(v_limit - v_published, 0);

  -- Only pages in this workspace that are not already published count against
  -- the remaining slots. Oldest first for deterministic partial publishes.
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

REVOKE ALL ON FUNCTION public.publish_tenant_pages(uuid, uuid[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_tenant_pages(uuid, uuid[]) TO service_role;
