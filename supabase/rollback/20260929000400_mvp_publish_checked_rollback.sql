-- Rollback of 20260929000400_mvp_publish_checked.sql.
-- Removes the checked single-page publish. Published pages stay published;
-- the app's publish then falls back to failing closed (the RPC is missing).
DROP FUNCTION IF EXISTS public.publish_tenant_page_checked(uuid, uuid, integer);

SELECT 'publish_tenant_page_checked removed' AS check_name,
       to_regprocedure('public.publish_tenant_page_checked(uuid,uuid,integer)') IS NULL AS ok;
