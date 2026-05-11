-- Restrict message board reads to authenticated users so anon visitors can't harvest user_id UUIDs
DROP POLICY IF EXISTS "Anyone can read threads" ON public.mb_threads;
DROP POLICY IF EXISTS "Anyone can read replies" ON public.mb_replies;

CREATE POLICY "Authenticated can read threads"
  ON public.mb_threads
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated can read replies"
  ON public.mb_replies
  FOR SELECT
  TO authenticated
  USING (true);