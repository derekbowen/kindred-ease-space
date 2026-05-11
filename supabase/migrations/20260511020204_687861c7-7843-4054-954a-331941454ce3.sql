
-- workspace_secrets: BYOK storage for per-workspace API keys
CREATE TABLE public.workspace_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  key_name text NOT NULL,
  value text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, key_name)
);

ALTER TABLE public.workspace_secrets ENABLE ROW LEVEL SECURITY;

-- Only workspace owners can read/write secrets via direct SQL. All app access
-- goes through server functions using the service role.
CREATE POLICY "Owners can view workspace secrets"
  ON public.workspace_secrets FOR SELECT
  TO authenticated
  USING (public.is_workspace_owner(workspace_id, auth.uid()));

CREATE POLICY "Owners can insert workspace secrets"
  ON public.workspace_secrets FOR INSERT
  TO authenticated
  WITH CHECK (public.is_workspace_owner(workspace_id, auth.uid()));

CREATE POLICY "Owners can update workspace secrets"
  ON public.workspace_secrets FOR UPDATE
  TO authenticated
  USING (public.is_workspace_owner(workspace_id, auth.uid()));

CREATE POLICY "Owners can delete workspace secrets"
  ON public.workspace_secrets FOR DELETE
  TO authenticated
  USING (public.is_workspace_owner(workspace_id, auth.uid()));

CREATE TRIGGER trg_workspace_secrets_updated_at
  BEFORE UPDATE ON public.workspace_secrets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- external_api_queue: rate-limited job queue for SERPAPI / Firecrawl / GSC etc.
CREATE TYPE public.external_api_queue_status AS ENUM ('pending','processing','done','error','cancelled');

CREATE TABLE public.external_api_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  endpoint text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status public.external_api_queue_status NOT NULL DEFAULT 'pending',
  priority int NOT NULL DEFAULT 0,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  response jsonb,
  error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_external_api_queue_status_scheduled
  ON public.external_api_queue (status, scheduled_at)
  WHERE status IN ('pending','processing');

CREATE INDEX idx_external_api_queue_workspace
  ON public.external_api_queue (workspace_id, created_at DESC);

ALTER TABLE public.external_api_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view queue rows"
  ON public.external_api_queue FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Members can enqueue jobs"
  ON public.external_api_queue FOR INSERT
  TO authenticated
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Owners can cancel jobs"
  ON public.external_api_queue FOR UPDATE
  TO authenticated
  USING (public.is_workspace_owner(workspace_id, auth.uid()));

CREATE TRIGGER trg_external_api_queue_updated_at
  BEFORE UPDATE ON public.external_api_queue
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
