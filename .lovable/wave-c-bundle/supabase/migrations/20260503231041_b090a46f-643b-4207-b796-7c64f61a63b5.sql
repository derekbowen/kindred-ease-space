
CREATE TABLE public.content_plan (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source_type TEXT NOT NULL DEFAULT 'city',
  priority_tier TEXT,
  priority_score BIGINT,
  city TEXT,
  state TEXT,
  state_code TEXT,
  population_2024 BIGINT,
  warm_climate BOOLEAN,
  slug TEXT NOT NULL UNIQUE,
  h1 TEXT,
  meta_title TEXT,
  meta_description TEXT,
  primary_keyword TEXT,
  supporting_keywords TEXT,
  uniqueness_angle TEXT,
  internal_links TEXT,
  schema_suggestions TEXT,
  notes TEXT,
  search_intent TEXT,
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  generated_page_slug TEXT,
  generated_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_content_plan_status ON public.content_plan (status);
CREATE INDEX idx_content_plan_tier ON public.content_plan (priority_tier);
CREATE INDEX idx_content_plan_state ON public.content_plan (state_code);
CREATE INDEX idx_content_plan_priority ON public.content_plan (priority_score DESC NULLS LAST);

ALTER TABLE public.content_plan ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage content plan"
  ON public.content_plan
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_content_plan_updated_at
  BEFORE UPDATE ON public.content_plan
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
