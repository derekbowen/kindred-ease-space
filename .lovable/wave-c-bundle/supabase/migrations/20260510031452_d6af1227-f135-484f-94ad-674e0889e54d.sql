CREATE TABLE IF NOT EXISTS public.prnm_200_keep_slugs (
  slug text PRIMARY KEY
);
ALTER TABLE public.prnm_200_keep_slugs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage keep slugs" ON public.prnm_200_keep_slugs FOR ALL TO authenticated
USING (has_role(auth.uid(),'admin'::app_role)) WITH CHECK (has_role(auth.uid(),'admin'::app_role));

CREATE TABLE IF NOT EXISTS public.prnm_200_build_new (
  slug text PRIMARY KEY,
  city text NOT NULL,
  state text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  generated_at timestamptz,
  last_error text,
  attempt_count int NOT NULL DEFAULT 0
);
ALTER TABLE public.prnm_200_build_new ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage build new" ON public.prnm_200_build_new FOR ALL TO authenticated
USING (has_role(auth.uid(),'admin'::app_role)) WITH CHECK (has_role(auth.uid(),'admin'::app_role));