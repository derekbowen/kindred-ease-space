-- ============================================================================
-- CRITICAL: close direct-write privilege escalation on entitlement tables.
--
-- Found while auditing the Opportunity Engine migration. An authenticated
-- workspace member could PATCH /rest/v1/workspaces directly (public anon key +
-- their own JWT) and set:
--
--     page_limit_base      -> 999999   (unlimited free pages: total billing bypass)
--     subscription_status  -> 'active' (paid features without paying)
--     plan                 -> 'agency' (raises the per-plan domain allowance)
--     is_internal          -> true     (platform-admin navigation)
--
-- All four were verified writable against production. This defeats the atomic
-- publish gate completely: the gate faithfully enforces a limit that the
-- customer themselves can rewrite. Fixing tenant_pages.status earlier stopped
-- members forging the *published state*; this stops them forging the *limit*.
--
-- workspace_members.role was likewise writable, letting an invited editor
-- self-promote to owner and reach billing, checkout and domain management.
--
-- FIX: these tables are written exclusively by server functions using the
-- service-role client, which bypasses RLS. No browser code writes them (grep
-- across src/ confirms zero client-side write sites), so removing the
-- privilege from `authenticated` entirely has no application impact.
--
-- RLS policies alone are insufficient here: a permissive USING clause scoped
-- by workspace still allows the member to write ANY column of their own row.
-- Table privileges are the correct mechanism.
-- ============================================================================

-- Reads stay exactly as they are; only write privileges are withdrawn.
REVOKE INSERT, UPDATE, DELETE ON public.workspaces FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.workspace_members FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.subscriptions FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.credit_balances FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.credit_ledger FROM authenticated, anon;

-- The service role is unaffected (it bypasses RLS and holds its own grants),
-- so every existing server function keeps working.

-- ---------------------------------------------------------------------------
-- Verification. Every row must read true.
-- ---------------------------------------------------------------------------
SELECT 'workspaces not writable by authenticated' AS check,
       NOT has_table_privilege('authenticated', 'public.workspaces', 'UPDATE') AS ok
UNION ALL SELECT 'workspaces not insertable',
       NOT has_table_privilege('authenticated', 'public.workspaces', 'INSERT')
UNION ALL SELECT 'workspace_members not writable',
       NOT has_table_privilege('authenticated', 'public.workspace_members', 'UPDATE')
UNION ALL SELECT 'subscriptions not writable',
       NOT has_table_privilege('authenticated', 'public.subscriptions', 'UPDATE')
UNION ALL SELECT 'credit_balances not writable',
       NOT has_table_privilege('authenticated', 'public.credit_balances', 'UPDATE')
UNION ALL SELECT 'workspaces still READABLE',
       has_table_privilege('authenticated', 'public.workspaces', 'SELECT')
UNION ALL SELECT 'workspace_members still READABLE',
       has_table_privilege('authenticated', 'public.workspace_members', 'SELECT');
