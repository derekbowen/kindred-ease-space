-- Affiliate marketing add-on (Toppal-style) for founders.click.
-- Lets a Sharetribe marketplace operator run referral/affiliate programs:
-- programs -> affiliates -> referrals -> qualifying transactions -> payouts.
-- All tenant-scoped via workspace_id + RLS (mirrors the rest of the platform).

-- Per-workspace affiliate settings + add-on entitlement.
CREATE TABLE IF NOT EXISTS public.workspace_affiliate_settings (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  addon_tier text CHECK (addon_tier IN ('lite','standard','pro')),
  addon_status text NOT NULL DEFAULT 'inactive' CHECK (addon_status IN ('inactive','trialing','active','canceled')),
  form_slug text,
  marketplace_base_url text,
  currency text NOT NULL DEFAULT 'USD',
  referrer_param text NOT NULL DEFAULT 'referrerID',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Programs: the rules for how affiliates earn.
CREATE TABLE IF NOT EXISTS public.affiliate_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  trigger text NOT NULL DEFAULT 'transaction' CHECK (trigger IN ('signup','transaction')),
  payout_type text NOT NULL DEFAULT 'percentage' CHECK (payout_type IN ('percentage','fixed')),
  payout_value numeric NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT false,
  auto_enroll boolean NOT NULL DEFAULT false,
  max_referrals integer,
  max_txn_per_referral integer,
  min_gmv numeric,
  brand_logo_url text,
  brand_primary_color text,
  brand_secondary_color text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);
CREATE INDEX IF NOT EXISTS affiliate_programs_ws_idx ON public.affiliate_programs(workspace_id, created_at DESC);

-- Affiliates: people promoting the marketplace.
CREATE TABLE IF NOT EXISTS public.affiliates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES public.affiliate_programs(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL,
  referral_code text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deactivated')),
  sharetribe_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, referral_code)
);
CREATE INDEX IF NOT EXISTS affiliates_ws_idx ON public.affiliates(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS affiliates_program_idx ON public.affiliates(program_id);

-- Referrals: a referred user attributed to an affiliate.
CREATE TABLE IF NOT EXISTS public.affiliate_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  affiliate_id uuid NOT NULL REFERENCES public.affiliates(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES public.affiliate_programs(id) ON DELETE CASCADE,
  referred_sharetribe_user_id text,
  referred_email text,
  signed_up_at timestamptz,
  first_converted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, program_id, referred_sharetribe_user_id)
);
CREATE INDEX IF NOT EXISTS affiliate_referrals_affiliate_idx ON public.affiliate_referrals(affiliate_id);

-- Qualifying transactions that generate payout accrual.
CREATE TABLE IF NOT EXISTS public.affiliate_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  affiliate_id uuid NOT NULL REFERENCES public.affiliates(id) ON DELETE CASCADE,
  referral_id uuid REFERENCES public.affiliate_referrals(id) ON DELETE SET NULL,
  program_id uuid NOT NULL REFERENCES public.affiliate_programs(id) ON DELETE CASCADE,
  sharetribe_transaction_id text NOT NULL,
  gmv numeric NOT NULL DEFAULT 0,
  marketplace_revenue numeric NOT NULL DEFAULT 0,
  payout_owed numeric NOT NULL DEFAULT 0,
  event_type text NOT NULL DEFAULT 'transaction' CHECK (event_type IN ('signup','transaction')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, sharetribe_transaction_id)
);
CREATE INDEX IF NOT EXISTS affiliate_transactions_affiliate_idx ON public.affiliate_transactions(affiliate_id, occurred_at DESC);

-- Payout lifecycle: pending -> ready -> paid (or rejected).
CREATE TABLE IF NOT EXISTS public.affiliate_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  affiliate_id uuid NOT NULL REFERENCES public.affiliates(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES public.affiliate_programs(id) ON DELETE CASCADE,
  amount numeric NOT NULL DEFAULT 0,
  event_type text NOT NULL DEFAULT 'transaction',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','paid','rejected')),
  txn_count integer NOT NULL DEFAULT 1,
  notes text,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS affiliate_payouts_ws_idx ON public.affiliate_payouts(workspace_id, status, created_at DESC);

-- Public sign-up applications (before an admin approves them into affiliates).
CREATE TABLE IF NOT EXISTS public.affiliate_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  program_id uuid NOT NULL REFERENCES public.affiliate_programs(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS affiliate_applications_ws_idx ON public.affiliate_applications(workspace_id, status, created_at DESC);

-- updated_at triggers (reuse the platform's standard function).
CREATE TRIGGER trg_waffiliate_settings_updated BEFORE UPDATE ON public.workspace_affiliate_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_affiliate_programs_updated BEFORE UPDATE ON public.affiliate_programs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_affiliates_updated BEFORE UPDATE ON public.affiliates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_affiliate_payouts_updated BEFORE UPDATE ON public.affiliate_payouts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- RLS: workspace members read; service role (server fns) does all writes after
-- asserting membership/ownership in code, consistent with the rest of the app.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspace_affiliate_settings','affiliate_programs','affiliates',
    'affiliate_referrals','affiliate_transactions','affiliate_payouts','affiliate_applications'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format($p$CREATE POLICY "members read %1$s" ON public.%1$I
      FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()));$p$, t);
    EXECUTE format($p$CREATE POLICY "service writes %1$s" ON public.%1$I
      FOR ALL TO public USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');$p$, t);
    EXECUTE format($p$CREATE POLICY "admin escape %1$s" ON public.%1$I
      FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));$p$, t);
  END LOOP;
END $$;
