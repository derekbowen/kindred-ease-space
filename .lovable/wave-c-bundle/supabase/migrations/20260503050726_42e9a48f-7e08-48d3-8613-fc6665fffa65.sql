-- Explicit admin-only SELECT on internal backfill log
CREATE POLICY "Admins can read hero backfill log"
  ON public.cities_hero_backfill_log
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));