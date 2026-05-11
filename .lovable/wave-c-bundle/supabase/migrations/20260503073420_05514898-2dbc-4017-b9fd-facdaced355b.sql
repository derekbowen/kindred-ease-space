-- Remove user-facing INSERT path; completions are now created exclusively
-- by the markCourseComplete server function via the service role.
DROP POLICY IF EXISTS "Users can create their own completions" ON public.course_completions;