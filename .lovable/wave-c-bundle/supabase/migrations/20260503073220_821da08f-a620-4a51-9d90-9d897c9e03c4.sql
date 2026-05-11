REVOKE ALL ON TABLE public.content_pages FROM anon, authenticated;

COMMENT ON TABLE public.content_pages IS
  'Server-only access. Reads MUST go through supabaseAdmin (service role) in server functions. No public SELECT RLS policy exists; anon/authenticated table grants are revoked as defense-in-depth. See src/server/content-pages.functions.ts.';