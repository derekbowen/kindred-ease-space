CREATE TABLE public.city_link_clicks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_city_slug text,
  to_city_slug text NOT NULL,
  referrer_path text,
  user_agent text,
  visitor_hash text,
  country text,
  region text,
  clicked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_city_link_clicks_to_slug ON public.city_link_clicks(to_city_slug);
CREATE INDEX idx_city_link_clicks_clicked_at ON public.city_link_clicks(clicked_at DESC);

ALTER TABLE public.city_link_clicks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can insert click events"
  ON public.city_link_clicks
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Admins can read click events"
  ON public.city_link_clicks
  FOR SELECT
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can manage click events"
  ON public.city_link_clicks
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));