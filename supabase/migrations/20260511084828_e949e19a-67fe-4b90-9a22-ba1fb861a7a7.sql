
-- BYOK AI infrastructure for tenants
CREATE TABLE IF NOT EXISTS public.tenant_ai_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('openai','anthropic','google','openrouter')),
  vault_secret_id uuid NOT NULL,
  last_four text NOT NULL,
  default_models jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'untested' CHECK (status IN ('untested','valid','invalid')),
  last_tested_at timestamptz,
  last_error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider)
);

ALTER TABLE public.tenant_ai_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owners_read_ai_creds" ON public.tenant_ai_credentials
  FOR SELECT TO authenticated
  USING (public.is_workspace_owner(workspace_id, auth.uid()));

CREATE POLICY "owners_modify_ai_creds" ON public.tenant_ai_credentials
  FOR ALL TO authenticated
  USING (public.is_workspace_owner(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_owner(workspace_id, auth.uid()));

CREATE TRIGGER tenant_ai_credentials_updated_at
  BEFORE UPDATE ON public.tenant_ai_credentials
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- AI usage log
CREATE TABLE IF NOT EXISTS public.ai_usage_log (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid,
  provider text NOT NULL,
  model text NOT NULL,
  feature text,
  prompt_tokens int NOT NULL DEFAULT 0,
  completion_tokens int NOT NULL DEFAULT 0,
  total_tokens int NOT NULL DEFAULT 0,
  cost_usd_micros bigint NOT NULL DEFAULT 0,
  used_byok boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ok',
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_log_ws_created_idx
  ON public.ai_usage_log (workspace_id, created_at DESC);

ALTER TABLE public.ai_usage_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members_read_ai_usage" ON public.ai_usage_log
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- Free-tier platform quota per workspace
CREATE TABLE IF NOT EXISTS public.workspace_ai_quota (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  platform_credits_remaining int NOT NULL DEFAULT 20,
  lifetime_platform_used int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.workspace_ai_quota ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members_read_quota" ON public.workspace_ai_quota
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE TRIGGER workspace_ai_quota_updated_at
  BEFORE UPDATE ON public.workspace_ai_quota
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Vault helpers (security definer; only owner can call)
CREATE OR REPLACE FUNCTION public.tenant_set_ai_credential(
  _workspace_id uuid,
  _provider text,
  _api_key text,
  _last_four text,
  _default_models jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_secret_id uuid;
  v_name text;
  v_existing uuid;
BEGIN
  IF NOT public.is_workspace_owner(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_name := 'ai_credential_' || _workspace_id::text || '_' || _provider;

  -- Replace previous vault entry
  DELETE FROM vault.secrets WHERE name = v_name;
  SELECT vault.create_secret(_api_key, v_name, 'BYOK AI provider key') INTO v_secret_id;

  INSERT INTO public.tenant_ai_credentials
    (workspace_id, provider, vault_secret_id, last_four, default_models, status, created_by)
  VALUES
    (_workspace_id, _provider, v_secret_id, _last_four, _default_models, 'untested', auth.uid())
  ON CONFLICT (workspace_id, provider) DO UPDATE
    SET vault_secret_id = EXCLUDED.vault_secret_id,
        last_four = EXCLUDED.last_four,
        default_models = COALESCE(EXCLUDED.default_models, public.tenant_ai_credentials.default_models),
        status = 'untested',
        last_tested_at = NULL,
        last_error = NULL,
        updated_at = now();
  RETURN v_secret_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.tenant_get_ai_credential(
  _workspace_id uuid,
  _provider text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_name text;
  v_secret text;
BEGIN
  v_name := 'ai_credential_' || _workspace_id::text || '_' || _provider;
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = v_name
  LIMIT 1;
  RETURN v_secret;
END;
$$;

REVOKE ALL ON FUNCTION public.tenant_get_ai_credential(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tenant_delete_ai_credential(
  _workspace_id uuid,
  _provider text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_name text;
BEGIN
  IF NOT public.is_workspace_owner(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_name := 'ai_credential_' || _workspace_id::text || '_' || _provider;
  DELETE FROM vault.secrets WHERE name = v_name;
  DELETE FROM public.tenant_ai_credentials
    WHERE workspace_id = _workspace_id AND provider = _provider;
  RETURN true;
END;
$$;

-- Quota helpers
CREATE OR REPLACE FUNCTION public.consume_platform_ai_credit(_workspace_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_remaining int;
BEGIN
  INSERT INTO public.workspace_ai_quota (workspace_id) VALUES (_workspace_id)
  ON CONFLICT (workspace_id) DO NOTHING;

  UPDATE public.workspace_ai_quota
    SET platform_credits_remaining = platform_credits_remaining - 1,
        lifetime_platform_used = lifetime_platform_used + 1
    WHERE workspace_id = _workspace_id
      AND platform_credits_remaining > 0
    RETURNING platform_credits_remaining INTO v_remaining;

  IF v_remaining IS NULL THEN
    RAISE EXCEPTION 'platform_ai_quota_exhausted' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_remaining;
END;
$$;
