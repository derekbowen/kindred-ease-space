
CREATE TABLE public.site_footer_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  contact_phone TEXT,
  contact_phone_label TEXT,
  contact_phone_hours TEXT,
  contact_email TEXT,
  bottom_text TEXT,
  explore_links JSONB NOT NULL DEFAULT '[]'::jsonb,
  host_links JSONB NOT NULL DEFAULT '[]'::jsonb,
  company_links JSONB NOT NULL DEFAULT '[]'::jsonb,
  popular_markets JSONB NOT NULL DEFAULT '[]'::jsonb,
  socials JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT site_footer_settings_singleton CHECK (id = 1)
);

ALTER TABLE public.site_footer_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view footer settings"
ON public.site_footer_settings FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can insert footer settings"
ON public.site_footer_settings FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update footer settings"
ON public.site_footer_settings FOR UPDATE
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER set_site_footer_settings_updated_at
BEFORE UPDATE ON public.site_footer_settings
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.site_footer_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
