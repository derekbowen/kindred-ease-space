-- Track the Cloudflare Worker route created alongside each custom hostname.
-- Per-hostname routes (rather than a `*/*` wildcard) keep platform traffic out
-- of the edge Worker entirely; the route id is needed so disconnecting a domain
-- can tear down both halves and never orphan a route.
ALTER TABLE public.workspace_domains
  ADD COLUMN IF NOT EXISTS cloudflare_route_id text;

SELECT 'route id column' AS check,
       EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_name = 'workspace_domains' AND column_name = 'cloudflare_route_id'
       ) AS ok;
