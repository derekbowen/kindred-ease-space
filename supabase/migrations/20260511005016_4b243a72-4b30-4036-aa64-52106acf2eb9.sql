
-- Helper macro pattern: drop the broad "Workspace members manage X" policy
-- and add an owner-scoped equivalent.

-- providers
DROP POLICY IF EXISTS "Workspace members manage providers" ON public.providers;
CREATE POLICY "Workspace owners manage providers"
  ON public.providers FOR ALL TO authenticated
  USING (public.is_workspace_owner(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_owner(workspace_id, auth.uid()));

-- provider_leads
DROP POLICY IF EXISTS "Workspace members manage provider_leads" ON public.provider_leads;
CREATE POLICY "Workspace owners manage provider_leads"
  ON public.provider_leads FOR ALL TO authenticated
  USING (public.is_workspace_owner(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_owner(workspace_id, auth.uid()));

-- provider_claims
DROP POLICY IF EXISTS "Workspace members manage provider_claims" ON public.provider_claims;
CREATE POLICY "Workspace owners manage provider_claims"
  ON public.provider_claims FOR ALL TO authenticated
  USING (public.is_workspace_owner(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_owner(workspace_id, auth.uid()));

-- provider_plan_requests
DROP POLICY IF EXISTS "Workspace members manage provider_plan_requests" ON public.provider_plan_requests;
CREATE POLICY "Workspace owners manage provider_plan_requests"
  ON public.provider_plan_requests FOR ALL TO authenticated
  USING (public.is_workspace_owner(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_owner(workspace_id, auth.uid()));

-- feature_requests
DROP POLICY IF EXISTS "Workspace members manage feature_requests" ON public.feature_requests;
CREATE POLICY "Workspace owners manage feature_requests"
  ON public.feature_requests FOR ALL TO authenticated
  USING (public.is_workspace_owner(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_owner(workspace_id, auth.uid()));

-- pool_waitlist
DROP POLICY IF EXISTS "Workspace members manage pool_waitlist" ON public.pool_waitlist;
CREATE POLICY "Workspace owners manage pool_waitlist"
  ON public.pool_waitlist FOR ALL TO authenticated
  USING (public.is_workspace_owner(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_owner(workspace_id, auth.uid()));

-- suppressed_emails
DROP POLICY IF EXISTS "Workspace members manage suppressed_emails" ON public.suppressed_emails;
CREATE POLICY "Workspace owners manage suppressed_emails"
  ON public.suppressed_emails FOR ALL TO authenticated
  USING (public.is_workspace_owner(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_owner(workspace_id, auth.uid()));

-- email_send_log: drop the broad workspace-member SELECT
DROP POLICY IF EXISTS "Workspace members read email_send_log" ON public.email_send_log;
CREATE POLICY "Workspace owners read email_send_log"
  ON public.email_send_log FOR SELECT TO authenticated
  USING (workspace_id IS NOT NULL AND public.is_workspace_owner(workspace_id, auth.uid()));

-- competitor_host_matches
DROP POLICY IF EXISTS "Workspace members manage competitor_host_matches" ON public.competitor_host_matches;
CREATE POLICY "Workspace owners manage competitor_host_matches"
  ON public.competitor_host_matches FOR ALL TO authenticated
  USING (public.is_workspace_owner(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_owner(workspace_id, auth.uid()));

-- enriched_contacts
DROP POLICY IF EXISTS "Workspace members manage enriched_contacts" ON public.enriched_contacts;
CREATE POLICY "Workspace owners manage enriched_contacts"
  ON public.enriched_contacts FOR ALL TO authenticated
  USING (public.is_workspace_owner(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_owner(workspace_id, auth.uid()));

-- host_match_false_positives
DROP POLICY IF EXISTS "Workspace members manage host_match_false_positives" ON public.host_match_false_positives;
CREATE POLICY "Workspace owners manage host_match_false_positives"
  ON public.host_match_false_positives FOR ALL TO authenticated
  USING (public.is_workspace_owner(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_owner(workspace_id, auth.uid()));

-- billing_config: drop unrestricted authenticated read; keep admin update; allow admin read via Admin escape
DROP POLICY IF EXISTS "anyone authed reads config" ON public.billing_config;
CREATE POLICY "Admins read billing config"
  ON public.billing_config FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));
