-- ROLLBACK for 20260925000930_founder_internal_unlimited.sql
--
-- Revokes the founder / internal unlimited grant: sets revoked_at on THAT
-- grant — the active 'internal' grant of workspace 509e5a42-… recorded by the
-- migration — and on nothing else. Grants are append-only history, so the
-- row stays (revoked); nothing is deleted, no page is unpublished. The
-- workspace falls back to whatever its own billing facts and any other
-- grants give it on the next read (capacity, publishing, the generation cap,
-- AI billing and the per-workspace AI cap all read the grant fresh).
-- Idempotent: a second run finds nothing active and changes nothing.
BEGIN;
UPDATE public.workspace_entitlement_grants
   SET revoked_at = now()
 WHERE workspace_id = '509e5a42-7eb9-4bdb-8b6c-981a15b69dce'
   AND grant_type = 'internal'
   AND revoked_at IS NULL
   AND metadata ->> 'source' = 'migration 20260925000930_founder_internal_unlimited';
COMMIT;

-- VERIFY (rolled back): expect migration_grant_active = 0. still_internal
-- reads false unless an admin has since given this workspace ANOTHER internal
-- grant through the admin screen — that one is not this file's to revoke
-- (revoke it there); active_internal_grants counts every active one.
SELECT (SELECT count(*) FROM public.workspace_entitlement_grants
         WHERE workspace_id = '509e5a42-7eb9-4bdb-8b6c-981a15b69dce'
           AND grant_type = 'internal' AND revoked_at IS NULL
           AND metadata ->> 'source' = 'migration 20260925000930_founder_internal_unlimited') AS migration_grant_active,
       (SELECT count(*) FROM public.workspace_entitlement_grants
         WHERE workspace_id = '509e5a42-7eb9-4bdb-8b6c-981a15b69dce'
           AND grant_type = 'internal' AND revoked_at IS NULL) AS active_internal_grants,
       public.workspace_is_internal_unlimited('509e5a42-7eb9-4bdb-8b6c-981a15b69dce') AS still_internal;
