DROP POLICY IF EXISTS "Anyone can insert click events" ON public.city_link_clicks;
CREATE POLICY "Anyone can insert click events"
  ON public.city_link_clicks
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (workspace_id IN (SELECT id FROM public.workspaces));

DROP POLICY IF EXISTS "Anyone can submit a feature request" ON public.feature_requests;
CREATE POLICY "Anyone can submit a feature request"
  ON public.feature_requests
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (workspace_id IN (SELECT id FROM public.workspaces) AND status = 'new');