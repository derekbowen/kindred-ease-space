-- ============================================================================
-- Automatic domain publishing: connection state machine on workspace_domains.
-- The Founders edge (Cloudflare Worker) routes {domain}/a/* to Founders and
-- everything else back to the customer's stored origin. Explicit states —
-- no boolean soup. `verified` stays for backward compatibility and is kept in
-- sync by the app.
-- ============================================================================

ALTER TABLE public.workspace_domains
  ADD COLUMN IF NOT EXISTS connection_type text NOT NULL DEFAULT 'full_proxy',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'verification_required',
  ADD COLUMN IF NOT EXISTS customer_origin text,
  ADD COLUMN IF NOT EXISTS route_prefix text NOT NULL DEFAULT '/a/',
  ADD COLUMN IF NOT EXISTS edge_hostname text,
  ADD COLUMN IF NOT EXISTS dns_provider text,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS last_health_check timestamptz,
  ADD COLUMN IF NOT EXISTS health_status text,
  ADD COLUMN IF NOT EXISTS activated_at timestamptz;

ALTER TABLE public.workspace_domains
  DROP CONSTRAINT IF EXISTS workspace_domains_connection_type_check;
ALTER TABLE public.workspace_domains
  ADD CONSTRAINT workspace_domains_connection_type_check
  CHECK (connection_type IN ('full_proxy', 'subdomain', 'customer_proxy'));

ALTER TABLE public.workspace_domains
  DROP CONSTRAINT IF EXISTS workspace_domains_status_check;
ALTER TABLE public.workspace_domains
  ADD CONSTRAINT workspace_domains_status_check
  CHECK (status IN (
    'pending', 'verification_required', 'verified',
    'dns_configuration_required', 'provisioning', 'ssl_pending',
    'active', 'error', 'disconnected'
  ));

-- Existing rows: map the old boolean onto the state machine.
UPDATE public.workspace_domains
   SET status = CASE WHEN verified THEN 'verified' ELSE 'verification_required' END
 WHERE status IN ('pending', 'verification_required');

-- Verification: every row should say true.
SELECT 'domain state columns' AS check,
       (SELECT count(*) = 10 FROM information_schema.columns
         WHERE table_name = 'workspace_domains' AND column_name IN
           ('connection_type','status','customer_origin','route_prefix','edge_hostname',
            'dns_provider','last_error','last_health_check','health_status','activated_at')) AS ok
UNION ALL SELECT 'status constraint',
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_domains_status_check');
