-- Vault cleanup for Sharetribe disconnect: without this, a disconnected
-- customer's client_secret stays decryptable in Vault forever. Service-role
-- only (called from the owner-gated disconnect server function).
CREATE OR REPLACE FUNCTION public.tenant_delete_integration_secret(_workspace_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
BEGIN
  DELETE FROM vault.secrets
   WHERE name = 'sharetribe_client_secret_' || _workspace_id::text;
END;
$$;

REVOKE ALL ON FUNCTION public.tenant_delete_integration_secret(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_delete_integration_secret(uuid) TO service_role;
