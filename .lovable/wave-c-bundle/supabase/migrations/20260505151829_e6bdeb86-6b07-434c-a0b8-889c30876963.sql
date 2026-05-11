
CREATE TABLE IF NOT EXISTS public.email_branding (
  id INTEGER PRIMARY KEY DEFAULT 1,
  site_name TEXT NOT NULL DEFAULT 'fresh-web',
  sender_name TEXT NOT NULL DEFAULT 'fresh-web',
  logo_url TEXT,
  primary_color TEXT NOT NULL DEFAULT '#000000',
  primary_text_color TEXT NOT NULL DEFAULT '#ffffff',
  footer_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT email_branding_singleton CHECK (id = 1)
);

ALTER TABLE public.email_branding ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view email branding"
  ON public.email_branding FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can insert email branding"
  ON public.email_branding FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update email branding"
  ON public.email_branding FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_email_branding_updated_at
  BEFORE UPDATE ON public.email_branding
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.email_branding (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
