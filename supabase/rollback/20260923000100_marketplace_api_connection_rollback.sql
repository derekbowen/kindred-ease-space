-- ROLLBACK for 20260923000100_marketplace_api_connection.sql
-- Safe only while no row has auth_mode = 'marketplace' (those rows have a NULL
-- client_secret_vault_id and would violate the restored NOT NULL). Check first:
--   SELECT count(*) FROM public.tenant_integrations WHERE auth_mode = 'marketplace';
-- Forward repair (preferred): leave the columns in place; they are additive and
-- unused by the previous application build.
-- Dropping the (provider, marketplace_id) UNIQUE constraint re-opens the
-- audited hole (any workspace can connect a marketplace another one already
-- has); the previous build tolerates the constraint, so consider leaving it.
BEGIN;
ALTER TABLE public.tenant_integrations DROP CONSTRAINT IF EXISTS tenant_integrations_provider_marketplace_id_key;
DELETE FROM public.tenant_integrations WHERE auth_mode = 'marketplace' AND client_secret_vault_id IS NULL;
ALTER TABLE public.tenant_integrations ALTER COLUMN client_secret_vault_id SET NOT NULL;
ALTER TABLE public.tenant_integrations DROP CONSTRAINT IF EXISTS tenant_integrations_auth_mode_check;
ALTER TABLE public.tenant_integrations DROP COLUMN IF EXISTS auth_mode;
ALTER TABLE public.tenant_integrations DROP COLUMN IF EXISTS marketplace_name;
COMMIT;
-- VERIFY (rolled back): expect 0 rows from each
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='tenant_integrations' AND column_name IN ('auth_mode','marketplace_name');
SELECT conname FROM pg_constraint WHERE conname = 'tenant_integrations_provider_marketplace_id_key';
