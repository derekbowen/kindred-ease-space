
-- Migrate workspace_secrets to Vault-backed storage.
-- The table currently has 0 rows so we drop the plaintext column safely.

ALTER TABLE public.workspace_secrets
  ADD COLUMN IF NOT EXISTS vault_secret_id uuid,
  ADD COLUMN IF NOT EXISTS last_four text,
  ADD COLUMN IF NOT EXISTS value_length integer;

ALTER TABLE public.workspace_secrets DROP COLUMN IF EXISTS value;

-- Set/replace a workspace secret. Stores the value in vault, keeps only metadata in the table.
CREATE OR REPLACE FUNCTION public.tenant_set_workspace_secret(
  _workspace_id uuid,
  _key_name text,
  _value text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $$
DECLARE
  v_secret_id uuid;
  v_name text;
BEGIN
  IF NOT public.is_workspace_owner(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF _key_name !~ '^[A-Z0-9_]{2,80}$' THEN
    RAISE EXCEPTION 'invalid key_name';
  END IF;

  v_name := 'workspace_secret_' || _workspace_id::text || '_' || _key_name;
  DELETE FROM vault.secrets WHERE name = v_name;
  SELECT vault.create_secret(_value, v_name, 'Workspace BYOK secret') INTO v_secret_id;

  INSERT INTO public.workspace_secrets
    (workspace_id, key_name, vault_secret_id, last_four, value_length, created_by, updated_at)
  VALUES
    (_workspace_id, _key_name, v_secret_id, right(_value, 4), length(_value), auth.uid(), now())
  ON CONFLICT (workspace_id, key_name) DO UPDATE
    SET vault_secret_id = EXCLUDED.vault_secret_id,
        last_four = EXCLUDED.last_four,
        value_length = EXCLUDED.value_length,
        updated_at = now();
  RETURN v_secret_id;
END;
$$;

-- Decrypt and return the secret value. SECURITY DEFINER; only callable by service_role from server fns.
CREATE OR REPLACE FUNCTION public.tenant_get_workspace_secret(
  _workspace_id uuid,
  _key_name text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $$
DECLARE
  v_name text;
  v_secret text;
BEGIN
  v_name := 'workspace_secret_' || _workspace_id::text || '_' || _key_name;
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = v_name
  LIMIT 1;
  RETURN v_secret;
END;
$$;

CREATE OR REPLACE FUNCTION public.tenant_delete_workspace_secret(
  _workspace_id uuid,
  _id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $$
DECLARE
  v_key text;
  v_name text;
BEGIN
  IF NOT public.is_workspace_owner(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  SELECT key_name INTO v_key FROM public.workspace_secrets
    WHERE id = _id AND workspace_id = _workspace_id;
  IF v_key IS NULL THEN RETURN false; END IF;
  v_name := 'workspace_secret_' || _workspace_id::text || '_' || v_key;
  DELETE FROM vault.secrets WHERE name = v_name;
  DELETE FROM public.workspace_secrets WHERE id = _id AND workspace_id = _workspace_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.tenant_get_workspace_secret(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_get_workspace_secret(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.tenant_set_workspace_secret(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tenant_delete_workspace_secret(uuid, uuid) TO authenticated, service_role;
