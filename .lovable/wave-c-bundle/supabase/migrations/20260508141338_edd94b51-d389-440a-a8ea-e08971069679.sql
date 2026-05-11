-- Public bucket for AI-generated city hero images.
INSERT INTO storage.buckets (id, name, public)
VALUES ('city-heroes', 'city-heroes', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Public can read.
DROP POLICY IF EXISTS "Public read city-heroes" ON storage.objects;
CREATE POLICY "Public read city-heroes"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'city-heroes');

-- Admins can manage (uploads happen server-side via service role anyway,
-- but this lets admins manually overwrite from the dashboard if needed).
DROP POLICY IF EXISTS "Admins manage city-heroes" ON storage.objects;
CREATE POLICY "Admins manage city-heroes"
  ON storage.objects FOR ALL
  TO authenticated
  USING (bucket_id = 'city-heroes' AND has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (bucket_id = 'city-heroes' AND has_role(auth.uid(), 'admin'::app_role));