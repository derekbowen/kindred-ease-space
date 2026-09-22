-- Least-privilege Sharetribe connection.
--
-- Until now a Sharetribe connection required an Integration API Client ID +
-- Secret. That secret grants full read/write access to the customer's whole
-- marketplace, which is far more than a listings import needs. The app now
-- defaults to the Sharetribe Marketplace API with a public-read
-- client_credentials grant: it needs only a Client ID, returns only the
-- published listings the marketplace already shows every visitor, and cannot
-- write anything. There is no secret to store, so client_secret_vault_id is
-- NULL for those rows. The Integration API remains available as an advanced
-- mode for customers who need it (e.g. the affiliate transaction sync).
--
-- marketplace_id stays NOT NULL: it is filled from marketplace/show by the
-- connect flow instead of being typed by the owner.

ALTER TABLE public.tenant_integrations
  ADD COLUMN IF NOT EXISTS auth_mode text NOT NULL DEFAULT 'integration',
  ADD COLUMN IF NOT EXISTS marketplace_name text;

ALTER TABLE public.tenant_integrations
  DROP CONSTRAINT IF EXISTS tenant_integrations_auth_mode_check;
ALTER TABLE public.tenant_integrations
  ADD CONSTRAINT tenant_integrations_auth_mode_check
  CHECK (auth_mode IN ('marketplace', 'integration'));

-- Marketplace API connections authenticate with the Client ID alone.
ALTER TABLE public.tenant_integrations
  ALTER COLUMN client_secret_vault_id DROP NOT NULL;

COMMENT ON COLUMN public.tenant_integrations.auth_mode IS
  'marketplace = Sharetribe Marketplace API, public-read client_credentials (Client ID only, published listings only, no writes). integration = Integration API (Client ID + Vault-stored secret, full marketplace access).';
COMMENT ON COLUMN public.tenant_integrations.client_secret_vault_id IS
  'vault.secrets id of the Integration API client_secret. NULL for auth_mode = marketplace: the Marketplace API public-read grant needs no secret, so none is ever stored.';
COMMENT ON COLUMN public.tenant_integrations.marketplace_name IS
  'Display name reported by marketplace/show at connect time.';

-- One marketplace, one workspace. The Marketplace API connect flow proves
-- possession of a working Client ID, not ownership of the marketplace, so
-- without this any workspace could connect a marketplace another workspace
-- had already connected and publish pages against its listings. The
-- constraint is the minimal guard: a second connection of the same
-- (provider, marketplace_id) is refused by the database, and
-- connectSharetribe turns the resulting 23505 into a message that names no
-- other workspace. An ownership challenge is separate work.
--
-- Guarded so the file re-runs cleanly. If production already holds two
-- workspaces on one marketplace the ALTER fails with the duplicated key —
-- the right outcome: resolve the duplicate by hand, then re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tenant_integrations_provider_marketplace_id_key'
       AND conrelid = 'public.tenant_integrations'::regclass
  ) THEN
    ALTER TABLE public.tenant_integrations
      ADD CONSTRAINT tenant_integrations_provider_marketplace_id_key
      UNIQUE (provider, marketplace_id);
  END IF;
END $$;

COMMENT ON CONSTRAINT tenant_integrations_provider_marketplace_id_key ON public.tenant_integrations IS
  'A marketplace can be connected to one founders.click workspace at a time. connectSharetribe maps the violation to a message that names no other workspace.';

-- Verification: every row should say true.
SELECT 'auth_mode column' AS check,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'tenant_integrations'
                  AND column_name = 'auth_mode' AND is_nullable = 'NO') AS ok
UNION ALL SELECT 'auth_mode check constraint',
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_integrations_auth_mode_check')
UNION ALL SELECT 'client_secret_vault_id nullable',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'tenant_integrations'
                  AND column_name = 'client_secret_vault_id' AND is_nullable = 'YES')
UNION ALL SELECT 'marketplace_id still required',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'tenant_integrations'
                  AND column_name = 'marketplace_id' AND is_nullable = 'NO')
UNION ALL SELECT 'marketplace_name column',
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'tenant_integrations'
                  AND column_name = 'marketplace_name')
UNION ALL SELECT 'one workspace per (provider, marketplace_id)',
       EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'tenant_integrations_provider_marketplace_id_key'
                  AND conrelid = 'public.tenant_integrations'::regclass
                  AND contype = 'u');
