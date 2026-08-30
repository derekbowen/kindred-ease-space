-- ============================================================================
-- OPPORTUNITY ENGINE V1
--
-- Turns founders.click from "customer decides what pages to build" into
-- "the system decides, from evidence, which pages deserve to exist".
--
-- Nothing here touches the publishing core: tenant_pages states, the atomic
-- publish gate, RLS publish restrictions, domains, canonical or sitemap are
-- all untouched. This is the strategist that sits IN FRONT of that machine.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Analysis domain is NOT the publishing domain.
-- A customer types their website in at onboarding and we scan it immediately —
-- no DNS change, no verification, no Cloudflare. Publishing-domain connection
-- (workspace_domains) happens later, once they have approved something worth
-- publishing.
-- ---------------------------------------------------------------------------
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS analysis_domain text,
  -- Gate thresholds are per-workspace, never global constants. Marketplace
  -- verticals have different inventory economics: 3 listings may be plenty for
  -- boat charters and nowhere near enough for parking spaces.
  ADD COLUMN IF NOT EXISTS opportunity_gate_config jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- SITE INTELLIGENCE
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.site_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  domain text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  urls_discovered int NOT NULL DEFAULT 0,
  pages_fetched int NOT NULL DEFAULT 0,
  sitemap_found boolean NOT NULL DEFAULT false,
  -- Derived understanding of the business, kept small and structured.
  inferred_categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  inferred_locations jsonb NOT NULL DEFAULT '[]'::jsonb,
  url_patterns jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  CONSTRAINT site_scans_status_check
    CHECK (status IN ('running','complete','error'))
);
CREATE INDEX IF NOT EXISTS site_scans_ws_idx ON public.site_scans(workspace_id, started_at DESC);

-- Structured features per URL. We deliberately do NOT store raw HTML — the
-- taxonomy is what matters, and raw pages would balloon storage for no gain.
CREATE TABLE IF NOT EXISTS public.site_scan_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id uuid NOT NULL REFERENCES public.site_scans(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  url text NOT NULL,
  canonical_url text,
  title text,
  h1 text,
  meta_description text,
  page_type text,
  inferred_category text,
  inferred_geo text,
  word_count int NOT NULL DEFAULT 0,
  indexable boolean NOT NULL DEFAULT true,
  content_fingerprint text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_scan_pages_scan_idx ON public.site_scan_pages(scan_id);
CREATE INDEX IF NOT EXISTS site_scan_pages_ws_intent_idx
  ON public.site_scan_pages(workspace_id, inferred_geo, inferred_category);

-- ---------------------------------------------------------------------------
-- INVENTORY INTELLIGENCE
-- Rolled up once per sync. Evaluating thousands of candidates against raw
-- tenant_listings would mean thousands of aggregate scans.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inventory_aggregates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  geo_key text NOT NULL,           -- normalized "riverside-ca"
  city text,
  state text,
  category_key text NOT NULL,      -- normalized category, '' = any
  listing_count int NOT NULL DEFAULT 0,
  provider_count int NOT NULL DEFAULT 0,
  price_min numeric,
  price_max numeric,
  price_median numeric,
  currency text,
  freshest_at timestamptz,
  with_image_count int NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, geo_key, category_key)
);
CREATE INDEX IF NOT EXISTS inventory_aggregates_ws_idx
  ON public.inventory_aggregates(workspace_id, listing_count DESC);

-- ---------------------------------------------------------------------------
-- OPPORTUNITIES — the core new entity
--
-- Decision history is preserved from day one: recommendation, score,
-- confidence, gate outcomes and the evidence snapshot all persist, so we can
-- later answer "do HIGH opportunities actually outperform MEDIUM ones?".
-- That feedback loop is the proprietary asset.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.seo_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- Intent cluster (an explicit concept, not just a slug)
  intent_key text NOT NULL,        -- "pool-rental::riverside-ca"
  intent_label text NOT NULL,      -- "Pool Rentals in Riverside, CA"
  normalized_category text,
  normalized_geo text,
  geo_city text,
  geo_state text,
  query_variants jsonb NOT NULL DEFAULT '[]'::jsonb,
  ranking_urls jsonb NOT NULL DEFAULT '[]'::jsonb,

  proposed_slug text,
  proposed_title text,

  -- Decision
  recommendation text NOT NULL DEFAULT 'PENDING',
  band text,                       -- HIGH | MEDIUM | LOW (customer-facing)
  opportunity_score numeric,       -- INTERNAL ONLY — never rendered
  confidence text,                 -- strong | moderate | weak
  score_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  gate_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  explanation jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Collision context
  nearest_page_kind text,          -- tenant_page | site_scan_page | opportunity
  nearest_page_ref text,
  nearest_page_similarity numeric,

  -- Lifecycle
  status text NOT NULL DEFAULT 'discovered',
  source text NOT NULL DEFAULT 'gsc_gap',
  tenant_page_id uuid REFERENCES public.tenant_pages(id) ON DELETE SET NULL,
  page_brief jsonb,

  discovered_at timestamptz NOT NULL DEFAULT now(),
  recommended_at timestamptz,
  approved_at timestamptz,
  generated_at timestamptz,
  customer_action text,
  scan_id uuid REFERENCES public.site_scans(id) ON DELETE SET NULL,

  UNIQUE (workspace_id, intent_key),
  CONSTRAINT seo_opportunities_recommendation_check
    CHECK (recommendation IN ('PENDING','BUILD_NEW_PAGE','IMPROVE_EXISTING','WAIT_FOR_INVENTORY','DO_NOT_BUILD')),
  CONSTRAINT seo_opportunities_status_check
    CHECK (status IN ('discovered','evaluating','recommended','approved','generating','draft_ready','published','rejected','blocked','deferred','obsolete'))
);
CREATE INDEX IF NOT EXISTS seo_opportunities_ws_rank_idx
  ON public.seo_opportunities(workspace_id, recommendation, opportunity_score DESC);
CREATE INDEX IF NOT EXISTS seo_opportunities_ws_status_idx
  ON public.seo_opportunities(workspace_id, status);

-- Evidence is per-signal and queryable so the UI can explain itself and so a
-- recommendation stays auditable after the underlying data has moved on.
CREATE TABLE IF NOT EXISTS public.opportunity_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id uuid NOT NULL REFERENCES public.seo_opportunities(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- SITE_COVERAGE and BUSINESS_COVERAGE are deliberately distinct from
  -- INVENTORY: a location missing from the customer's site is NOT evidence
  -- they don't serve it — that absence is often the whole opportunity.
  source text NOT NULL,
  metric text NOT NULL,
  value_num numeric,
  value_text text,
  weight numeric,
  detail text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opportunity_evidence_source_check
    CHECK (source IN ('GSC','SITE_COVERAGE','BUSINESS_COVERAGE','INVENTORY','INFERRED','SERP','COMPETITOR'))
);
CREATE INDEX IF NOT EXISTS opportunity_evidence_opp_idx
  ON public.opportunity_evidence(opportunity_id);

-- A published page remembers why it exists.
ALTER TABLE public.tenant_pages
  ADD COLUMN IF NOT EXISTS opportunity_id uuid REFERENCES public.seo_opportunities(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Cross-tenant linkage guard.
--
-- A plain FK on tenant_page_id would let a service-role bug link workspace A's
-- opportunity to workspace B's page. Composite foreign keys make that
-- impossible at the database level: the referenced row must carry the SAME
-- workspace_id. Tenant isolation must not depend on application code.
-- ---------------------------------------------------------------------------
ALTER TABLE public.tenant_pages
  DROP CONSTRAINT IF EXISTS tenant_pages_id_workspace_uk;
ALTER TABLE public.tenant_pages
  ADD CONSTRAINT tenant_pages_id_workspace_uk UNIQUE (id, workspace_id);

ALTER TABLE public.seo_opportunities
  DROP CONSTRAINT IF EXISTS seo_opportunities_id_workspace_uk;
ALTER TABLE public.seo_opportunities
  ADD CONSTRAINT seo_opportunities_id_workspace_uk UNIQUE (id, workspace_id);

ALTER TABLE public.seo_opportunities
  DROP CONSTRAINT IF EXISTS seo_opportunities_page_same_workspace_fk;
ALTER TABLE public.seo_opportunities
  ADD CONSTRAINT seo_opportunities_page_same_workspace_fk
  FOREIGN KEY (tenant_page_id, workspace_id)
  REFERENCES public.tenant_pages(id, workspace_id) ON DELETE SET NULL;

ALTER TABLE public.tenant_pages
  DROP CONSTRAINT IF EXISTS tenant_pages_opportunity_same_workspace_fk;
ALTER TABLE public.tenant_pages
  ADD CONSTRAINT tenant_pages_opportunity_same_workspace_fk
  FOREIGN KEY (opportunity_id, workspace_id)
  REFERENCES public.seo_opportunities(id, workspace_id) ON DELETE SET NULL;

-- Same guard for scan pages: a scan_id from another workspace cannot be paired
-- with this workspace_id.
ALTER TABLE public.site_scans
  DROP CONSTRAINT IF EXISTS site_scans_id_workspace_uk;
ALTER TABLE public.site_scans
  ADD CONSTRAINT site_scans_id_workspace_uk UNIQUE (id, workspace_id);

ALTER TABLE public.site_scan_pages
  DROP CONSTRAINT IF EXISTS site_scan_pages_scan_same_workspace_fk;
ALTER TABLE public.site_scan_pages
  ADD CONSTRAINT site_scan_pages_scan_same_workspace_fk
  FOREIGN KEY (scan_id, workspace_id)
  REFERENCES public.site_scans(id, workspace_id) ON DELETE CASCADE;

ALTER TABLE public.opportunity_evidence
  DROP CONSTRAINT IF EXISTS opportunity_evidence_opp_same_workspace_fk;
ALTER TABLE public.opportunity_evidence
  ADD CONSTRAINT opportunity_evidence_opp_same_workspace_fk
  FOREIGN KEY (opportunity_id, workspace_id)
  REFERENCES public.seo_opportunities(id, workspace_id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- RLS — members read their workspace's intelligence; all writes are
-- service-role (the engine runs server-side), matching the publishing model.
-- ---------------------------------------------------------------------------
ALTER TABLE public.site_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_scan_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seo_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opportunity_evidence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read site_scans" ON public.site_scans;
CREATE POLICY "members read site_scans" ON public.site_scans
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "members read site_scan_pages" ON public.site_scan_pages;
CREATE POLICY "members read site_scan_pages" ON public.site_scan_pages
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "members read inventory_aggregates" ON public.inventory_aggregates;
CREATE POLICY "members read inventory_aggregates" ON public.inventory_aggregates
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "members read opportunities" ON public.seo_opportunities;
CREATE POLICY "members read opportunities" ON public.seo_opportunities
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "members read opportunity_evidence" ON public.opportunity_evidence;
CREATE POLICY "members read opportunity_evidence" ON public.opportunity_evidence
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()));

-- Writes are service-role only. RLS with no write policy already denies these,
-- but the privilege is withdrawn explicitly too — defence in depth, and it
-- makes the intent unambiguous to anyone reading the schema later.
REVOKE INSERT, UPDATE, DELETE ON public.site_scans FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.site_scan_pages FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.inventory_aggregates FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.seo_opportunities FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.opportunity_evidence FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- Workspace-scoped rollout. The environment flag is a master kill switch; a
-- workspace must ALSO be explicitly enrolled before it sees the engine, so an
-- unvalidated recommendation engine can never reach every customer at once.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.feature_enrollments (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  feature text NOT NULL,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  note text,
  PRIMARY KEY (workspace_id, feature)
);
ALTER TABLE public.feature_enrollments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "members read enrollments" ON public.feature_enrollments;
CREATE POLICY "members read enrollments" ON public.feature_enrollments
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()));
REVOKE INSERT, UPDATE, DELETE ON public.feature_enrollments FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- Verification — every row should read true.
-- ---------------------------------------------------------------------------
SELECT 'analysis_domain + gate_config' AS check,
       (SELECT count(*) = 2 FROM information_schema.columns
         WHERE table_name = 'workspaces'
           AND column_name IN ('analysis_domain','opportunity_gate_config')) AS ok
UNION ALL SELECT 'site_scans', to_regclass('public.site_scans') IS NOT NULL
UNION ALL SELECT 'site_scan_pages', to_regclass('public.site_scan_pages') IS NOT NULL
UNION ALL SELECT 'inventory_aggregates', to_regclass('public.inventory_aggregates') IS NOT NULL
UNION ALL SELECT 'seo_opportunities', to_regclass('public.seo_opportunities') IS NOT NULL
UNION ALL SELECT 'opportunity_evidence', to_regclass('public.opportunity_evidence') IS NOT NULL
UNION ALL SELECT 'tenant_pages.opportunity_id',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'tenant_pages' AND column_name = 'opportunity_id')
UNION ALL SELECT 'feature_enrollments', to_regclass('public.feature_enrollments') IS NOT NULL
UNION ALL SELECT 'cross-workspace FK guards (4)',
       (SELECT count(*) = 4 FROM pg_constraint WHERE conname IN (
          'seo_opportunities_page_same_workspace_fk',
          'tenant_pages_opportunity_same_workspace_fk',
          'site_scan_pages_scan_same_workspace_fk',
          'opportunity_evidence_opp_same_workspace_fk'))
UNION ALL SELECT 'opportunities not writable by authenticated',
       NOT has_table_privilege('authenticated', 'public.seo_opportunities', 'UPDATE')
UNION ALL SELECT 'opportunities readable by authenticated',
       has_table_privilege('authenticated', 'public.seo_opportunities', 'SELECT')
UNION ALL SELECT 'RLS enabled on all 6 new tables',
       (SELECT count(*) = 6 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relrowsecurity
           AND c.relname IN ('site_scans','site_scan_pages','inventory_aggregates',
                             'seo_opportunities','opportunity_evidence','feature_enrollments'));
