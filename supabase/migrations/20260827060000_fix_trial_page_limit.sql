-- ============================================================================
-- Corrective: 20260827030000's grandfather clause included 'trialing', which
-- handed every existing free-trial workspace 1,000 published pages instead of
-- the 25-page trial allowance. Paid statuses ('active', 'past_due') keep their
-- grandfathered capacity; trials go back to the trial limit — but never below
-- what a workspace already has published, so nobody's live pages are
-- retroactively pushed over their limit.
-- ============================================================================

UPDATE public.workspaces w
   SET page_limit_base = GREATEST(
         25,
         (SELECT count(*) FROM public.tenant_pages tp
           WHERE tp.workspace_id = w.id AND tp.status = 'published')
       )
 WHERE w.subscription_status = 'trialing'
   AND w.is_internal = false
   AND w.page_limit_base > 25;

-- Verification: no non-internal trial workspace should exceed 25 unless it
-- already had that many pages published.
SELECT 'trial limits corrected' AS check,
       NOT EXISTS (
         SELECT 1 FROM public.workspaces w
          WHERE w.subscription_status = 'trialing'
            AND w.is_internal = false
            AND w.page_limit_base > GREATEST(25, (
                  SELECT count(*) FROM public.tenant_pages tp
                   WHERE tp.workspace_id = w.id AND tp.status = 'published'))
       ) AS ok;
