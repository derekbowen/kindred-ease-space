-- Prevent duplicate unresolved 404 rows per workspace + path.
CREATE UNIQUE INDEX IF NOT EXISTS content_404_log_workspace_url_unresolved
  ON public.content_404_log (workspace_id, url_path)
  WHERE resolved_at IS NULL;