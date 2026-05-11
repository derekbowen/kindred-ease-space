-- ============================================================
-- founders.click — Sharetribe + Page Builder v1
-- ============================================================

-- Vault is enabled by default on Supabase; we use vault.create_secret
-- to encrypt the Sharetribe client_secret per workspace.

-- ---------- tenant_integrations ----------
CREATE TABLE IF NOT EXISTS public.tenant_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'sharetribe',
  marketplace_url text NOT NULL,
  marketplace_id uuid NOT NULL,
  client_id text NOT NULL,
  client_secret_vault_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  last_sync_at timestamptz,
  last_sync_status text,
  last_sync_error text,
  listings_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider)
);

ALTER TABLE public.tenant_integrations ENABLE ROW LEVEL SECURITY;

-- Members can read their own integration row, but client_secret_vault_id
-- is only useful with the service role (vault decryption is service-role only).
CREATE POLICY "members read tenant_integrations"
  ON public.tenant_integrations FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- Writes go through SECURITY DEFINER RPC (which validates membership),
-- so no INSERT/UPDATE/DELETE policies are exposed.

CREATE TRIGGER tenant_integrations_updated_at
  BEFORE UPDATE ON public.tenant_integrations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------- tenant_listings ----------
CREATE TABLE IF NOT EXISTS public.tenant_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  sharetribe_listing_id uuid NOT NULL,
  title text NOT NULL,
  slug text NOT NULL,
  description text,
  price_amount integer,
  price_currency text,
  city text,
  state text,
  country text,
  lat numeric,
  lng numeric,
  category text,
  custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  images jsonb NOT NULL DEFAULT '[]'::jsonb,
  author_id uuid,
  author_name text,
  marketplace_url text NOT NULL,
  structured_data jsonb,
  state_published boolean NOT NULL DEFAULT true,
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, sharetribe_listing_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_listings_workspace_city
  ON public.tenant_listings(workspace_id, city);
CREATE INDEX IF NOT EXISTS idx_tenant_listings_workspace_category
  ON public.tenant_listings(workspace_id, category);
CREATE INDEX IF NOT EXISTS idx_tenant_listings_workspace_published
  ON public.tenant_listings(workspace_id, state_published);

ALTER TABLE public.tenant_listings ENABLE ROW LEVEL SECURITY;

-- Workspace members can read their own listings (admin UI).
CREATE POLICY "members read tenant_listings"
  ON public.tenant_listings FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- Public renderer reads via service-role (server functions). No anon SELECT.

-- ---------- page_templates ----------
CREATE TABLE IF NOT EXISTS public.page_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  description text,
  config_schema jsonb NOT NULL,
  preview_image_url text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.page_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anyone can read page_templates"
  ON public.page_templates FOR SELECT
  USING (true);

-- No write policies. Templates are seeded by migrations / admin only.

-- Seed templates
INSERT INTO public.page_templates (slug, name, description, config_schema, is_active)
VALUES
  ('city_hub', 'City Hub',
   'Programmatic city landing page with listing grid, intro, FAQ and related links.',
   '{
      "variables": {
        "city": {"type": "string", "required": true},
        "state": {"type": "string", "required": true},
        "category_plural": {"type": "string", "default": "listings"}
      },
      "listing_filter": {
        "city": "{{variables.city}}",
        "state": "{{variables.state}}",
        "limit": 24,
        "sort": "newest"
      },
      "sections": ["hero","intro_paragraph","listing_grid","body_content","faq","related_pages"]
    }'::jsonb,
   true),
  ('category_page', 'Category Page',
   'Category-focused landing (placeholder, v2).',
   '{"placeholder": true}'::jsonb, false),
  ('neighborhood', 'Neighborhood',
   'Neighborhood-level landing (placeholder, v2).',
   '{"placeholder": true}'::jsonb, false),
  ('comparison', 'Comparison',
   'Side-by-side comparison page (placeholder, v2).',
   '{"placeholder": true}'::jsonb, false),
  ('resource_article', 'Resource Article',
   'Long-form resource article (placeholder, v2).',
   '{"placeholder": true}'::jsonb, false)
ON CONFLICT (slug) DO NOTHING;

-- ---------- tenant_pages ----------
CREATE TABLE IF NOT EXISTS public.tenant_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES public.page_templates(id),
  slug text NOT NULL,
  title text NOT NULL,
  meta_description text,
  h1 text,
  body_markdown text,
  variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  listing_filter jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_tenant_pages_workspace_status
  ON public.tenant_pages(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_tenant_pages_slug
  ON public.tenant_pages(slug);

ALTER TABLE public.tenant_pages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read tenant_pages"
  ON public.tenant_pages FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "members insert tenant_pages"
  ON public.tenant_pages FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "members update tenant_pages"
  ON public.tenant_pages FOR UPDATE
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "members delete tenant_pages"
  ON public.tenant_pages FOR DELETE
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE TRIGGER tenant_pages_updated_at
  BEFORE UPDATE ON public.tenant_pages
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---------- Vault helpers (SECURITY DEFINER) ----------

-- Save / rotate the Sharetribe client_secret for a workspace.
-- Membership is checked. Returns the vault secret id.
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
  IF NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_name := 'sharetribe_client_secret_' || _workspace_id::text;

  -- Replace previous secret if present so vault doesn't accumulate stale rows.
  DELETE FROM vault.secrets WHERE name = v_name;

  SELECT vault.create_secret(_client_secret, v_name, 'Sharetribe Integration API client_secret') INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.tenant_set_integration_secret(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.tenant_set_integration_secret(uuid, text) TO authenticated;

-- Decrypt the secret. Service-role only.
CREATE OR REPLACE FUNCTION public.tenant_get_integration_secret(_workspace_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'sharetribe_client_secret_' || _workspace_id::text
  LIMIT 1;
  RETURN v_secret;
END;
$$;

REVOKE ALL ON FUNCTION public.tenant_get_integration_secret(uuid) FROM public;
-- Only service_role should be able to decrypt.
GRANT EXECUTE ON FUNCTION public.tenant_get_integration_secret(uuid) TO service_role;
