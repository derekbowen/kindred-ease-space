-- Replace the public "Anyone can verify a certificate" select policy with a function that looks up by certificate UID without exposing all rows.
DROP POLICY IF EXISTS "Anyone can verify a certificate" ON public.course_completions;

CREATE POLICY "Users can view their own completions"
ON public.course_completions
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

-- Public verification via SECURITY DEFINER function (returns only the matching record)
CREATE OR REPLACE FUNCTION public.verify_certificate(_uid text)
RETURNS TABLE (
  certificate_uid text,
  course_slug text,
  course_title text,
  learner_name text,
  completed_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT certificate_uid, course_slug, course_title, learner_name,
         completed_at, revoked_at, revoke_reason
  FROM public.course_completions
  WHERE certificate_uid = _uid
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.verify_certificate(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_certificate(text) TO anon, authenticated;