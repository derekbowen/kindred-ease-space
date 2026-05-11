-- Defense-in-depth: synced_listings contains private host home addresses
-- and precise lat/long. The app does not read this table from the browser
-- (listings come directly from Sharetribe at request time); the only reads
-- happen server-side via supabaseAdmin during sync. Drop the public SELECT
-- policy so RLS denies anon/authenticated reads, and revoke table grants.
DROP POLICY IF EXISTS "Public can read published synced listings" ON public.synced_listings;

REVOKE SELECT ON public.synced_listings FROM anon, authenticated;