-- Force RLS so service role is the only bypass
ALTER TABLE public.providers FORCE ROW LEVEL SECURITY;

-- Revoke broad column access from anon/authenticated on sensitive submission fields.
REVOKE SELECT (submitter_email, submission_notes, listing_paid_until, plan, claim_status, submission_status, claimed_by, claimed_at)
  ON public.providers FROM anon, authenticated;