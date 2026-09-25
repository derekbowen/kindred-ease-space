-- ============================================================================
-- THE FOUNDER / INTERNAL UNLIMITED GRANT (data only; owner request 2026-09-25)
--
-- One row in workspace_entitlement_grants: an ACTIVE, PERMANENT grant of type
-- 'internal' (20260924000700) for the founder's own test workspace, so it
-- works end to end with no page, publishing, generation or AI usage limit —
-- through the same entitlement architecture as every other grant, never
-- through an email address, a platform role or the client.
--
--   workspace   509e5a42-7eb9-4bdb-8b6c-981a15b69dce  "My Marketplace"
--               (test.poolrentalnearme.com)
--   owner       auth user 7b3618d3-4d54-4974-8daf-2845777ccc28
--   granted_by  26c3147d-89eb-4491-9882-f7da344657fc (the platform admin)
--
-- GUARDED. The row is written only when ALL of these hold, and otherwise
-- nothing is written (a NOTICE says which guard stopped it and the
-- verification row below reads false):
--   1. the workspace exists;
--   2. its owner in workspace_members is exactly that user — the only
--      owner row of the workspace;
--   3. the granting account exists and holds the platform 'admin' role
--      (has_role — the same check the admin grant screen enforces);
--   4. the workspace holds no active internal grant yet (idempotent: a
--      second run writes nothing).
-- Every other workspace — including any other workspace owned by an admin —
-- is untouched: the grant names this workspace and nothing is derived from
-- who owns it.
--
-- Requires 20260924000700 (the 'internal' grant type). Rollback:
-- supabase/rollback/20260925000930_founder_internal_unlimited_rollback.sql
-- (revokes this grant: sets revoked_at on it and on nothing else).
-- ============================================================================

DO $$
DECLARE
  c_workspace CONSTANT uuid := '509e5a42-7eb9-4bdb-8b6c-981a15b69dce';
  c_owner     CONSTANT uuid := '7b3618d3-4d54-4974-8daf-2845777ccc28';
  c_granter   CONSTANT uuid := '26c3147d-89eb-4491-9882-f7da344657fc';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = c_workspace) THEN
    RAISE NOTICE 'founder grant NOT written: workspace % does not exist', c_workspace;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspace_members
                  WHERE workspace_id = c_workspace AND user_id = c_owner AND role = 'owner')
     OR EXISTS (SELECT 1 FROM public.workspace_members
                 WHERE workspace_id = c_workspace AND role = 'owner' AND user_id <> c_owner) THEN
    RAISE NOTICE 'founder grant NOT written: the owner of % is not (only) %', c_workspace, c_owner;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = c_granter)
     OR NOT public.has_role(c_granter, 'admin') THEN
    RAISE NOTICE 'founder grant NOT written: % is not a platform admin', c_granter;
    RETURN;
  END IF;
  IF public.workspace_is_internal_unlimited(c_workspace) THEN
    RAISE NOTICE 'founder grant already active for %: nothing written', c_workspace;
    RETURN;
  END IF;

  INSERT INTO public.workspace_entitlement_grants
    (workspace_id, grant_type, page_limit, starts_at, expires_at, granted_by, reason, metadata)
  VALUES
    (c_workspace, 'internal', 1000000, now(), NULL, c_granter,
     'Founder internal unlimited account for end-to-end product testing (owner request 2026-09-25)',
     jsonb_build_object('source', 'migration 20260925000930_founder_internal_unlimited',
                        'label', 'Founder / Internal Unlimited'));
END $$;

-- Verification: every row should read true.
SELECT 'founder workspace holds exactly one active, permanent internal grant' AS check,
       (SELECT count(*) = 1
          FROM public.workspace_entitlement_grants
         WHERE workspace_id = '509e5a42-7eb9-4bdb-8b6c-981a15b69dce'
           AND grant_type = 'internal' AND revoked_at IS NULL AND expires_at IS NULL
           AND starts_at <= now() AND page_limit = 1000000
           AND granted_by = '26c3147d-89eb-4491-9882-f7da344657fc') AS ok
UNION ALL SELECT 'the predicate says the founder workspace is internal unlimited',
       public.workspace_is_internal_unlimited('509e5a42-7eb9-4bdb-8b6c-981a15b69dce')
UNION ALL SELECT 'no other workspace holds an active internal grant',
       NOT EXISTS (SELECT 1 FROM public.workspace_entitlement_grants
                    WHERE grant_type = 'internal' AND revoked_at IS NULL
                      AND (expires_at IS NULL OR expires_at > now())
                      AND workspace_id <> '509e5a42-7eb9-4bdb-8b6c-981a15b69dce')
UNION ALL SELECT 'capacity reads internal: serve, publish, no page limit',
       CASE WHEN EXISTS (SELECT 1 FROM public.workspaces WHERE id = '509e5a42-7eb9-4bdb-8b6c-981a15b69dce')
            THEN EXISTS (SELECT 1 FROM public.workspace_capacity('509e5a42-7eb9-4bdb-8b6c-981a15b69dce') c
                          WHERE c.state = 'internal' AND c.serve AND c.publish AND c.page_limit = 2147483647)
            ELSE false END;
