-- Sharetribe template store: private storage for the paid template zips.
--
-- PRIVATE bucket. Buyers never read it directly: the template-download edge
-- function verifies a paid Stripe Checkout session and mints a short-lived
-- signed URL with the service role, which bypasses these policies.
--
-- Platform admins (has_role 'admin') may list and upload zips from
-- Admin → Template store. No policy grants anon or other authenticated users
-- any access, so the files cannot be read without a signed URL.
--
-- Rollback:
--   DROP POLICY IF EXISTS "template_downloads_admin_select" ON storage.objects;
--   DROP POLICY IF EXISTS "template_downloads_admin_insert" ON storage.objects;
--   DROP POLICY IF EXISTS "template_downloads_admin_update" ON storage.objects;
--   DROP POLICY IF EXISTS "template_downloads_admin_delete" ON storage.objects;
--   (then empty and delete the bucket from the dashboard)

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'template-downloads',
  'template-downloads',
  false,
  52428800, -- 50 MB per zip
  ARRAY['application/zip', 'application/x-zip-compressed', 'application/octet-stream']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "template_downloads_admin_select" ON storage.objects;
CREATE POLICY "template_downloads_admin_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'template-downloads' AND public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "template_downloads_admin_insert" ON storage.objects;
CREATE POLICY "template_downloads_admin_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'template-downloads' AND public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "template_downloads_admin_update" ON storage.objects;
CREATE POLICY "template_downloads_admin_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'template-downloads' AND public.has_role(auth.uid(), 'admin'))
  WITH CHECK (bucket_id = 'template-downloads' AND public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "template_downloads_admin_delete" ON storage.objects;
CREATE POLICY "template_downloads_admin_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'template-downloads' AND public.has_role(auth.uid(), 'admin'));
