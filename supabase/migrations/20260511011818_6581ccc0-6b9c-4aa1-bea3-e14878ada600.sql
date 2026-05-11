
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS logo_url text,
  ADD COLUMN IF NOT EXISTS brand_name text,
  ADD COLUMN IF NOT EXISTS brand_color text;

INSERT INTO storage.buckets (id, name, public)
VALUES ('workspace-logos', 'workspace-logos', true)
ON CONFLICT (id) DO NOTHING;

-- Public read (logos are shown to end-users)
DROP POLICY IF EXISTS "workspace_logos_public_read" ON storage.objects;
CREATE POLICY "workspace_logos_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'workspace-logos');

-- Only workspace owners can write to their {workspace_id}/* prefix
DROP POLICY IF EXISTS "workspace_logos_owner_insert" ON storage.objects;
CREATE POLICY "workspace_logos_owner_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'workspace-logos'
    AND public.is_workspace_owner(((storage.foldername(name))[1])::uuid, auth.uid())
  );

DROP POLICY IF EXISTS "workspace_logos_owner_update" ON storage.objects;
CREATE POLICY "workspace_logos_owner_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'workspace-logos'
    AND public.is_workspace_owner(((storage.foldername(name))[1])::uuid, auth.uid())
  );

DROP POLICY IF EXISTS "workspace_logos_owner_delete" ON storage.objects;
CREATE POLICY "workspace_logos_owner_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'workspace-logos'
    AND public.is_workspace_owner(((storage.foldername(name))[1])::uuid, auth.uid())
  );
