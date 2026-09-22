-- ============================================================================
-- BATCH GENERATION ("Generate Content")
--
-- A job is one customer click: "generate N drafts". Each item is one target
-- (a city with enough published listings and no page yet). Items are the unit
-- of work the browser drives one at a time, and they are idempotent by
-- (workspace_id, target_key) — NOT by slug, which gets suffixed on collision.
-- A done item is never regenerated and never charged twice.
--
-- platform_settings holds the two platform-wide knobs ops can flip without a
-- deploy: a pause switch and a per-workspace daily cap. Nobody but the
-- service role can read them; the app reads them server-side.
--
-- Nothing here touches the publishing core: generated pages are ordinary
-- tenant_pages drafts and go live only through the existing atomic gate.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.generation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  requested_by uuid,
  status text NOT NULL DEFAULT 'queued',
  model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT generation_jobs_status_check
    CHECK (status IN ('queued','running','done','failed','cancelled'))
);
CREATE INDEX IF NOT EXISTS generation_jobs_ws_idx
  ON public.generation_jobs(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.generation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.generation_jobs(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- e.g. 'city:austin|tx'. See buildTargetKey() in src/lib/generation.server.ts.
  target_key text NOT NULL,
  target jsonb NOT NULL,
  slug text,
  page_id uuid REFERENCES public.tenant_pages(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  error text,
  attempts int NOT NULL DEFAULT 0,
  prompt_tokens int,
  completion_tokens int,
  credits_charged int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generation_items_status_check
    CHECK (status IN ('pending','running','done','failed','skipped')),
  -- The idempotency key: one row per target per workspace, ever.
  CONSTRAINT generation_items_workspace_target_key UNIQUE (workspace_id, target_key)
);
CREATE INDEX IF NOT EXISTS generation_items_job_idx ON public.generation_items(job_id);
-- The daily cap counts items done in the last 24h per workspace.
CREATE INDEX IF NOT EXISTS generation_items_ws_status_updated_idx
  ON public.generation_items(workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.platform_settings (key, value) VALUES
  ('generation_paused', 'false'::jsonb),
  ('generation_daily_cap', '50'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- updated_at maintenance (function already exists from the initial schema).
DROP TRIGGER IF EXISTS generation_jobs_updated_at ON public.generation_jobs;
CREATE TRIGGER generation_jobs_updated_at
  BEFORE UPDATE ON public.generation_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS generation_items_updated_at ON public.generation_items;
CREATE TRIGGER generation_items_updated_at
  BEFORE UPDATE ON public.generation_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS platform_settings_updated_at ON public.platform_settings;
CREATE TRIGGER platform_settings_updated_at
  BEFORE UPDATE ON public.platform_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------------------------------------------------------------------------
-- RLS — members read their workspace's jobs and items; all writes are
-- service-role (the server functions run the pipeline). platform_settings is
-- readable by nobody but the service role.
-- ---------------------------------------------------------------------------
ALTER TABLE public.generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read generation_jobs" ON public.generation_jobs;
CREATE POLICY "members read generation_jobs" ON public.generation_jobs
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "members read generation_items" ON public.generation_items;
CREATE POLICY "members read generation_items" ON public.generation_items
  FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()));

-- Writes are service-role only. RLS with no write policy already denies these,
-- but the privilege is withdrawn explicitly too — defence in depth, and it
-- makes the intent unambiguous to anyone reading the schema later.
REVOKE INSERT, UPDATE, DELETE ON public.generation_jobs FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.generation_items FROM authenticated, anon;
REVOKE ALL ON public.platform_settings FROM authenticated, anon;

-- ---------------------------------------------------------------------------
-- Verification — every row should read true.
-- ---------------------------------------------------------------------------
SELECT 'generation_jobs' AS check, to_regclass('public.generation_jobs') IS NOT NULL AS ok
UNION ALL SELECT 'generation_items', to_regclass('public.generation_items') IS NOT NULL
UNION ALL SELECT 'platform_settings', to_regclass('public.platform_settings') IS NOT NULL
UNION ALL SELECT 'items unique per (workspace_id, target_key)',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'generation_items_workspace_target_key' AND contype = 'u')
UNION ALL SELECT 'item page_id nulls on page delete',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.generation_items'::regclass
                  AND contype = 'f' AND confdeltype = 'n'
                  AND confrelid = 'public.tenant_pages'::regclass)
UNION ALL SELECT 'generation_paused seeded',
       EXISTS (SELECT 1 FROM public.platform_settings WHERE key = 'generation_paused')
UNION ALL SELECT 'generation_daily_cap seeded',
       EXISTS (SELECT 1 FROM public.platform_settings WHERE key = 'generation_daily_cap')
UNION ALL SELECT 'jobs readable by authenticated',
       has_table_privilege('authenticated', 'public.generation_jobs', 'SELECT')
UNION ALL SELECT 'items not writable by authenticated',
       NOT has_table_privilege('authenticated', 'public.generation_items', 'INSERT')
UNION ALL SELECT 'platform_settings not readable by authenticated',
       NOT has_table_privilege('authenticated', 'public.platform_settings', 'SELECT')
UNION ALL SELECT 'platform_settings not readable by anon',
       NOT has_table_privilege('anon', 'public.platform_settings', 'SELECT')
UNION ALL SELECT 'RLS enabled on all 3 new tables',
       (SELECT count(*) = 3 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relrowsecurity
           AND c.relname IN ('generation_jobs','generation_items','platform_settings'));
