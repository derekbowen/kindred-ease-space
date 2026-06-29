-- Host resolution: match marketplace_domain and verified custom domains.
CREATE OR REPLACE FUNCTION public.current_workspace_id_by_host(_host text)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH normalized AS (
    SELECT lower(regexp_replace(regexp_replace(_host, ':\d+$', ''), '^www\.', '')) AS h
  )
  SELECT id
    FROM (
      SELECT w.id
        FROM public.workspaces w, normalized n
       WHERE w.marketplace_domain = n.h
      UNION ALL
      SELECT wd.workspace_id AS id
        FROM public.workspace_domains wd, normalized n
       WHERE wd.verified = true
         AND lower(wd.hostname) = n.h
    ) matches
   LIMIT 1;
$$;

-- Backward-compatible alias used by generated types.
CREATE OR REPLACE FUNCTION public.workspace_for_host(_host text)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.current_workspace_id_by_host(_host);
$$;

-- Integration secrets: owners only (members could rotate via direct RPC).
CREATE OR REPLACE FUNCTION public.tenant_set_integration_secret(
  _workspace_id uuid,
  _client_secret text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_id uuid;
  v_name text;
BEGIN
  IF NOT public.is_workspace_owner(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_name := 'sharetribe_client_secret_' || _workspace_id::text;

  DELETE FROM vault.secrets WHERE name = v_name;

  SELECT vault.create_secret(_client_secret, v_name, 'Sharetribe Integration API client_secret') INTO v_id;
  RETURN v_id;
END;
$$;