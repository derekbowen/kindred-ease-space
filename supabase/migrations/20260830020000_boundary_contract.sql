-- ============================================================================
-- BOUNDARY CONTRACT — P0-1 kill switch + edge health, P0-2 marketplace adapter.
--
-- The permanent rule this encodes:
--   A founders.click failure may break /a/*.
--   It must NEVER break the customer's existing marketplace.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- P0-1: per-host emergency disable.
--
-- Distinct from status='disconnected'. Disconnect removes the domain and makes
-- domain-config 404 — which in full_proxy is exactly the whole-domain outage we
-- are escaping. `founders_disabled` keeps the row, keeps the origin, and tells
-- the edge to pass 100% of traffic (including /a/*) to the customer while all
-- pages and configuration stay intact for re-enabling.
-- ---------------------------------------------------------------------------
ALTER TABLE public.workspace_domains
  ADD COLUMN IF NOT EXISTS founders_disabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS disabled_reason text,
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

-- Edge-reported health. The edge tells us it is running on stale config before
-- a customer has to tell us their site is broken.
CREATE TABLE IF NOT EXISTS public.edge_health_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname text NOT NULL,
  state text NOT NULL,
  stale_age_s int,
  detail text,
  reported_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT edge_health_state_check
    CHECK (state IN ('HEALTHY','CONTROL_PLANE_DEGRADED','STALE_CONFIG','BROKEN'))
);
CREATE INDEX IF NOT EXISTS edge_health_host_idx
  ON public.edge_health_events(hostname, reported_at DESC);
ALTER TABLE public.edge_health_events ENABLE ROW LEVEL SECURITY;
-- Service-role only: this is ops telemetry, not customer data.
REVOKE INSERT, UPDATE, DELETE, SELECT ON public.edge_health_events FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- P0-2: marketplace routing profile + certification.
--
-- Listing URLs were hard-coded to `/l/{slug}/{id}` inline in the sync mapper —
-- the Sharetribe Web Template default. Any marketplace with a customised or
-- localised frontend got wrong URLs on every card, and because the URL was
-- persisted into marketplace_url AND structured_data at sync time, fixing it
-- meant re-syncing every listing. Routes now live in configuration and URLs are
-- derived at render.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenant_integrations
  ADD COLUMN IF NOT EXISTS adapter_type text NOT NULL DEFAULT 'sharetribe',
  ADD COLUMN IF NOT EXISTS adapter_version int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS route_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS certification_status text NOT NULL DEFAULT 'UNCERTIFIED',
  ADD COLUMN IF NOT EXISTS certified_at timestamptz,
  ADD COLUMN IF NOT EXISTS certification_error text,
  ADD COLUMN IF NOT EXISTS certification_detail jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.tenant_integrations
  DROP CONSTRAINT IF EXISTS tenant_integrations_certification_check;
ALTER TABLE public.tenant_integrations
  ADD CONSTRAINT tenant_integrations_certification_check
  CHECK (certification_status IN ('UNCERTIFIED','CERTIFYING','CERTIFIED','DEGRADED','FAILED'));

-- ---------------------------------------------------------------------------
-- Verification — every row should read true.
-- ---------------------------------------------------------------------------
SELECT 'kill switch columns' AS check,
       (SELECT count(*) = 3 FROM information_schema.columns
         WHERE table_name = 'workspace_domains'
           AND column_name IN ('founders_disabled','disabled_reason','disabled_at')) AS ok
UNION ALL SELECT 'edge_health_events', to_regclass('public.edge_health_events') IS NOT NULL
UNION ALL SELECT 'edge_health not readable by authenticated',
       NOT has_table_privilege('authenticated','public.edge_health_events','SELECT')
UNION ALL SELECT 'adapter columns',
       (SELECT count(*) = 7 FROM information_schema.columns
         WHERE table_name = 'tenant_integrations'
           AND column_name IN ('adapter_type','adapter_version','route_config',
                               'certification_status','certified_at',
                               'certification_error','certification_detail'))
UNION ALL SELECT 'certification constraint',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'tenant_integrations_certification_check');
