ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS long_form_content jsonb,
  ADD COLUMN IF NOT EXISTS tier text;

CREATE INDEX IF NOT EXISTS idx_courses_tier ON public.courses(tier);
CREATE INDEX IF NOT EXISTS idx_courses_category ON public.courses(category);