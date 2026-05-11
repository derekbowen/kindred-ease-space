CREATE TABLE public.seo_fix_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  page_id UUID NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('full','meta_only','title_only')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','done','failed','cancelled')),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  result JSONB,
  error TEXT,
  batch_id UUID,
  enqueued_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_seo_fix_jobs_status ON public.seo_fix_jobs(status, created_at);
CREATE INDEX idx_seo_fix_jobs_batch ON public.seo_fix_jobs(batch_id);
CREATE INDEX idx_seo_fix_jobs_page ON public.seo_fix_jobs(page_id);

ALTER TABLE public.seo_fix_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view jobs" ON public.seo_fix_jobs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can insert jobs" ON public.seo_fix_jobs
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update jobs" ON public.seo_fix_jobs
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_seo_fix_jobs_updated_at
  BEFORE UPDATE ON public.seo_fix_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();