CREATE TABLE public.canonical_audit_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  total_pages INTEGER NOT NULL DEFAULT 0,
  pages_with_failures INTEGER NOT NULL DEFAULT 0,
  pages_with_warnings INTEGER NOT NULL DEFAULT 0,
  totals JSONB NOT NULL DEFAULT '{}'::jsonb,
  pages JSONB NOT NULL DEFAULT '[]'::jsonb,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_canonical_audit_runs_started_at
  ON public.canonical_audit_runs (started_at DESC);

ALTER TABLE public.canonical_audit_runs ENABLE ROW LEVEL SECURITY;

-- Only platform admins can read audit runs from the client. All writes happen
-- server-side via the service-role key (admin server fn + cron hook), so no
-- INSERT/UPDATE/DELETE policy is needed for end-users.
CREATE POLICY "Admins can read canonical audit runs"
  ON public.canonical_audit_runs
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));