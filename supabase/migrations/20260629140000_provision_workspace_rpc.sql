-- Atomic workspace provisioning that bypasses RLS via SECURITY DEFINER.
-- Fixes dev/prod cases where server-side inserts hit workspaces RLS because
-- the runtime service-role key is missing or misconfigured.

CREATE OR REPLACE FUNCTION public.provision_workspace_for_user(
  _name text DEFAULT 'My Marketplace',
  _marketplace_domain text DEFAULT NULL,
  _slug_hint text DEFAULT NULL,
  _if_exists_return boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_existing_ws uuid;
  v_existing_slug text;
  v_ws_id uuid;
  v_slug text;
  v_had_owner boolean;
  v_trial_amount int := 250;
BEGIN
  v_user := auth.uid();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT wm.workspace_id, w.slug
    INTO v_existing_ws, v_existing_slug
    FROM public.workspace_members wm
    JOIN public.workspaces w ON w.id = wm.workspace_id
   WHERE wm.user_id = v_user AND wm.role = 'owner'
   LIMIT 1;

  IF v_existing_ws IS NOT NULL AND _if_exists_return THEN
    RETURN jsonb_build_object(
      'workspace_id', v_existing_ws,
      'created', false,
      'slug', v_existing_slug
    );
  END IF;

  v_had_owner := v_existing_ws IS NOT NULL;

  v_slug := COALESCE(
    NULLIF(trim(_slug_hint), ''),
    'ws-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)
  );

  INSERT INTO public.workspaces (
    slug, name, marketplace_domain, owner_user_id,
    plan, subscription_status, trial_ends_at
  ) VALUES (
    v_slug,
    _name,
    NULLIF(trim(_marketplace_domain), ''),
    v_user,
    'starter',
    'trialing',
    now() + interval '14 days'
  )
  RETURNING id INTO v_ws_id;

  BEGIN
    INSERT INTO public.workspace_members (workspace_id, user_id, role)
    VALUES (v_ws_id, v_user, 'owner');
  EXCEPTION WHEN unique_violation THEN
    DELETE FROM public.workspaces WHERE id = v_ws_id;
    SELECT wm.workspace_id, w.slug
      INTO v_existing_ws, v_existing_slug
      FROM public.workspace_members wm
      JOIN public.workspaces w ON w.id = wm.workspace_id
     WHERE wm.user_id = v_user AND wm.role = 'owner'
     LIMIT 1;
    IF v_existing_ws IS NULL THEN
      RAISE;
    END IF;
    RETURN jsonb_build_object(
      'workspace_id', v_existing_ws,
      'created', false,
      'slug', v_existing_slug
    );
  END;

  IF NOT v_had_owner THEN
    PERFORM public.grant_credits(
      v_ws_id,
      v_trial_amount,
      'trial_grant',
      'trial',
      v_ws_id::text,
      jsonb_build_object('source', CASE WHEN _if_exists_return THEN 'auto_provision' ELSE 'onboarding' END)
    );
  END IF;

  RETURN jsonb_build_object(
    'workspace_id', v_ws_id,
    'created', true,
    'slug', v_slug
  );
END;
$$;

REVOKE ALL ON FUNCTION public.provision_workspace_for_user(text, text, text, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.provision_workspace_for_user(text, text, text, boolean) TO authenticated;

-- Belt-and-suspenders INSERT policies when RLS is already enabled on these tables.
DROP POLICY IF EXISTS "authenticated insert own workspace" ON public.workspaces;
CREATE POLICY "authenticated insert own workspace"
  ON public.workspaces FOR INSERT TO authenticated
  WITH CHECK (owner_user_id = auth.uid());

DROP POLICY IF EXISTS "authenticated insert own membership" ON public.workspace_members;
CREATE POLICY "authenticated insert own membership"
  ON public.workspace_members FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());