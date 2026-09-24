-- ROLLBACK for 20260923000100_marketplace_api_connection.sql
-- REFUSES to run while any row has auth_mode = 'marketplace': those are live
-- customer connections (Client ID only, NULL client_secret_vault_id) and the
-- restored NOT NULL cannot hold them. The guard below raises inside the
-- transaction, so the script stops with nothing changed and names how many
-- rows are in the way. Migrate each of them first — reconnect the marketplace
-- in Integration API mode (Client ID + secret) or disconnect it from the app —
-- then re-run. Check ahead of time:
--   SELECT count(*) FROM public.tenant_integrations WHERE auth_mode = 'marketplace';
-- Forward repair (preferred): leave the columns in place; they are additive and
-- unused by the previous application build.
-- Dropping the (provider, marketplace_id) UNIQUE constraint re-opens the
-- audited hole (any workspace can connect a marketplace another one already
-- has); the previous build tolerates the constraint, so consider leaving it.
BEGIN;
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.tenant_integrations WHERE auth_mode = 'marketplace';
  IF n > 0 THEN
    RAISE EXCEPTION 'rollback refused: % marketplace-mode connections exist; migrate them first', n;
  END IF;
END $$;
ALTER TABLE public.tenant_integrations DROP CONSTRAINT IF EXISTS tenant_integrations_provider_marketplace_id_key;
ALTER TABLE public.tenant_integrations ALTER COLUMN client_secret_vault_id SET NOT NULL;
ALTER TABLE public.tenant_integrations DROP CONSTRAINT IF EXISTS tenant_integrations_auth_mode_check;
ALTER TABLE public.tenant_integrations DROP COLUMN IF EXISTS auth_mode;
ALTER TABLE public.tenant_integrations DROP COLUMN IF EXISTS marketplace_name;
COMMIT;
-- VERIFY (rolled back): expect 0 rows from each
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='tenant_integrations' AND column_name IN ('auth_mode','marketplace_name');
SELECT conname FROM pg_constraint WHERE conname = 'tenant_integrations_provider_marketplace_id_key';
