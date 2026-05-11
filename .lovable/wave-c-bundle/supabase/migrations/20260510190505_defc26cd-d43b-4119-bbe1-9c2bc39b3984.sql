INSERT INTO storage.buckets (id, name, public) VALUES ('course-covers', 'course-covers', true) ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Public can read course covers"
ON storage.objects FOR SELECT
USING (bucket_id = 'course-covers');

CREATE POLICY "Admins can upload course covers"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'course-covers' AND has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update course covers"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'course-covers' AND has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can delete course covers"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'course-covers' AND has_role(auth.uid(), 'admin'::app_role));