-- ============================================================================
-- 20260929000400 — publish ONE validated page, exactly as it was validated
-- ============================================================================
-- The page builder validates a draft (template, filter, inventory, content,
-- domain) and only then flips it live. publish_tenant_pages flips ANY page it
-- is given that is not yet published — an archived or billing-suspended one,
-- or a draft whose text changed after the check. publish_tenant_page_checked
-- flips one page only while it is still a draft at the content_version that
-- was validated, under the same per-workspace lock and the same capacity rule
-- (workspace_capacity) as publish_tenant_pages. It answers with a result code
-- instead of raising, so the caller can tell the owner exactly why:
--   published | already_published | not_found | not_draft | version_conflict
--   | not_entitled | limit_reached
--
-- Service role only. Rollback:
--   supabase/rollback/20260929000400_mvp_publish_checked_rollback.sql
-- ============================================================================

CREATE OR REPLACE FUNCTION public.publish_tenant_page_checked(
  _workspace_id uuid,
  _page_id uuid,
  _expected_version integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_version integer;
  v_limit integer;
  v_publish boolean;
  v_published integer;
BEGIN
  IF _workspace_id IS NULL OR _page_id IS NULL OR _expected_version IS NULL THEN
    RAISE EXCEPTION 'publish_tenant_page_checked: workspace, page and version are required';
  END IF;

  -- The same lock publish_tenant_pages takes: capacity is counted and spent
  -- by one publisher at a time per workspace.
  PERFORM pg_advisory_xact_lock(hashtext('publish:' || _workspace_id::text));

  SELECT status, content_version INTO v_status, v_version
    FROM public.tenant_pages
   WHERE id = _page_id AND workspace_id = _workspace_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF v_status = 'published' THEN
    RETURN jsonb_build_object('result', 'already_published');
  END IF;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RETURN jsonb_build_object('result', 'not_draft', 'status', v_status);
  END IF;
  IF v_version IS DISTINCT FROM _expected_version THEN
    RETURN jsonb_build_object('result', 'version_conflict', 'version', v_version);
  END IF;

  SELECT c.page_limit, c.publish INTO v_limit, v_publish
    FROM public.workspace_capacity(_workspace_id) c;
  IF v_limit IS NULL THEN
    RAISE EXCEPTION 'workspace_not_found';
  END IF;
  IF NOT coalesce(v_publish, false) THEN
    RETURN jsonb_build_object('result', 'not_entitled', 'limit', 0);
  END IF;

  SELECT count(*) INTO v_published
    FROM public.tenant_pages
   WHERE workspace_id = _workspace_id AND status = 'published';
  IF v_published >= v_limit THEN
    RETURN jsonb_build_object('result', 'limit_reached', 'limit', v_limit, 'published', v_published);
  END IF;

  UPDATE public.tenant_pages
     SET status = 'published',
         published_at = COALESCE(published_at, now()),
         updated_at = now()
   WHERE id = _page_id;

  RETURN jsonb_build_object('result', 'published', 'limit', v_limit, 'published', v_published + 1);
END
$$;

REVOKE ALL ON FUNCTION public.publish_tenant_page_checked(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.publish_tenant_page_checked(uuid, uuid, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_tenant_page_checked(uuid, uuid, integer) TO service_role;

-- Verify ---------------------------------------------------------------------
SELECT 'publish_tenant_page_checked exists and only the service role may run it' AS check_name,
       (to_regprocedure('public.publish_tenant_page_checked(uuid,uuid,integer)') IS NOT NULL
        AND has_function_privilege('service_role', 'public.publish_tenant_page_checked(uuid,uuid,integer)', 'EXECUTE')
        AND NOT has_function_privilege('anon', 'public.publish_tenant_page_checked(uuid,uuid,integer)', 'EXECUTE')
        AND NOT has_function_privilege('authenticated', 'public.publish_tenant_page_checked(uuid,uuid,integer)', 'EXECUTE')) AS ok;
