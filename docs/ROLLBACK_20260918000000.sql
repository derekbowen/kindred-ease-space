-- ============================================================================
-- ROLLBACK for 20260918000000_entitlement_grants.sql
--
-- Captured from PRODUCTION immediately before the migration was applied on
-- 2026-09-18. The publish gate body below is the verbatim pre-migration
-- definition (normalized md5 9a7b2ec0260fb6730bc9c19b4bc6112a, length 1752),
-- not a reconstruction.
--
-- RUN AS ONE TRANSACTION. Dropping the grants table alone is NOT sufficient:
-- publish_tenant_pages() would then reference a function that no longer exists
-- and EVERY publish would fail closed. The old gate has to come back in the
-- same transaction that removes the new objects.
--
-- This rollback does not touch data. It removes objects the migration created
-- and restores one function body. No page, workspace or subscription is
-- altered by running it.
-- ============================================================================

BEGIN;

-- 1. Restore the pre-migration publish gate FIRST, so there is no window in
--    which it references a dropped function.
CREATE OR REPLACE FUNCTION public.publish_tenant_pages(_workspace_id uuid, _page_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_limit int;
  v_published int;
  v_remaining int;
  v_requested int;
  v_to_publish uuid[];
  v_count int := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('publish:' || _workspace_id::text));

  SELECT page_limit_base + page_limit_addon
         + CASE WHEN page_bonus_expires_at IS NOT NULL AND page_bonus_expires_at > now()
                THEN page_limit_bonus ELSE 0 END
    INTO v_limit
    FROM public.workspaces WHERE id = _workspace_id;
  IF v_limit IS NULL THEN
    RAISE EXCEPTION 'workspace_not_found';
  END IF;

  SELECT count(*) INTO v_published
    FROM public.tenant_pages
   WHERE workspace_id = _workspace_id AND status = 'published';

  v_remaining := GREATEST(v_limit - v_published, 0);

  SELECT count(*) INTO v_requested
    FROM public.tenant_pages
   WHERE workspace_id = _workspace_id
     AND id = ANY(_page_ids)
     AND status <> 'published';

  IF v_remaining > 0 AND v_requested > 0 THEN
    SELECT array_agg(id) INTO v_to_publish FROM (
      SELECT id FROM public.tenant_pages
       WHERE workspace_id = _workspace_id
         AND id = ANY(_page_ids)
         AND status <> 'published'
       ORDER BY created_at
       LIMIT v_remaining
    ) s;
    IF v_to_publish IS NOT NULL THEN
      UPDATE public.tenant_pages
         SET status = 'published',
             published_at = COALESCE(published_at, now())
       WHERE id = ANY(v_to_publish);
      GET DIAGNOSTICS v_count = ROW_COUNT;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'published', v_count,
    'denied', v_requested - v_count,
    'limit', v_limit,
    'published_total', v_published + v_count,
    'remaining', GREATEST(v_limit - v_published - v_count, 0)
  );
END;
$function$;

-- 2. Now the new objects can go. CASCADE is deliberately NOT used: if anything
--    unexpected depends on these, this rollback should fail loudly rather than
--    silently drop it.
DROP FUNCTION IF EXISTS public.workspace_capacity(uuid);
DROP FUNCTION IF EXISTS public.workspace_granted_pages(uuid);
DROP TABLE IF EXISTS public.workspace_entitlement_grants;

-- 3. Prove the rollback landed before committing.
DO $$
BEGIN
  IF to_regclass('public.workspace_entitlement_grants') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback incomplete: grants table still present';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'workspace_capacity') THEN
    RAISE EXCEPTION 'rollback incomplete: workspace_capacity still present';
  END IF;
  IF (SELECT prosrc ILIKE '%workspace_capacity%' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'publish_tenant_pages') THEN
    RAISE EXCEPTION 'rollback incomplete: publish gate still references workspace_capacity';
  END IF;
END $$;

COMMIT;

-- AFTER ROLLBACK, the application on this branch becomes inconsistent with the
-- database: readEntitlement() calls workspace_granted_pages() and will throw.
-- Roll the application back to a commit before f5e4720 at the same time, or the
-- entitlement read fails closed for every workspace.
