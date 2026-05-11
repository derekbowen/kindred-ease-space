-- Restrict EXECUTE on internal SECURITY DEFINER helpers to prevent direct calls by signed-in users.
-- has_role: only used internally by RLS policies (definer context bypasses grants).
-- handle_new_user: trigger function on auth.users; never called directly.
-- verify_certificate: intentionally public (used by /verify page) — keep EXECUTE for anon/authenticated.

REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
