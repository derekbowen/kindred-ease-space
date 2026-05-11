-- ============================================================
-- course_progress: one row per (user, course)
-- ============================================================
CREATE TABLE public.course_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  course_slug text NOT NULL,
  progress_pct integer NOT NULL DEFAULT 0,
  total_seconds_spent integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, course_slug),
  CONSTRAINT course_progress_pct_range CHECK (progress_pct BETWEEN 0 AND 100),
  CONSTRAINT course_progress_seconds_nonneg CHECK (total_seconds_spent >= 0)
);

CREATE INDEX idx_course_progress_user ON public.course_progress (user_id);
CREATE INDEX idx_course_progress_slug ON public.course_progress (course_slug);
CREATE INDEX idx_course_progress_last_activity ON public.course_progress (last_activity_at DESC);

ALTER TABLE public.course_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own progress"
  ON public.course_progress FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own progress"
  ON public.course_progress FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own progress"
  ON public.course_progress FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins manage progress"
  ON public.course_progress FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER trg_course_progress_updated_at
  BEFORE UPDATE ON public.course_progress
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- course_progress_events: append-only milestone log
-- ============================================================
CREATE TABLE public.course_progress_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  course_slug text NOT NULL,
  event_type text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT course_progress_events_type_check
    CHECK (event_type IN (
      'started',
      'heartbeat',
      'progress_updated',
      'mark_complete_clicked',
      'completed',
      'certificate_downloaded',
      'certificate_verified',
      'resumed'
    ))
);

CREATE INDEX idx_cpe_user ON public.course_progress_events (user_id);
CREATE INDEX idx_cpe_slug ON public.course_progress_events (course_slug);
CREATE INDEX idx_cpe_user_slug_time ON public.course_progress_events (user_id, course_slug, created_at DESC);

ALTER TABLE public.course_progress_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own progress events"
  ON public.course_progress_events FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own progress events"
  ON public.course_progress_events FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins manage progress events"
  ON public.course_progress_events FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
