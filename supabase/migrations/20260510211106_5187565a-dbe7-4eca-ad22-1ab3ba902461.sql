
-- Credit balance per workspace (1:1)
CREATE TABLE public.credit_balances (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  balance integer NOT NULL DEFAULT 0,
  monthly_allowance integer NOT NULL DEFAULT 0,
  cycle_resets_at timestamptz,
  lifetime_granted integer NOT NULL DEFAULT 0,
  lifetime_spent integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.credit_balances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members read credit_balances" ON public.credit_balances
  FOR SELECT TO authenticated USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Service role manages credit_balances" ON public.credit_balances
  FOR ALL TO public USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "Admin escape credit_balances" ON public.credit_balances
  FOR ALL TO authenticated USING (has_role(auth.uid(),'admin')) WITH CHECK (has_role(auth.uid(),'admin'));

CREATE TRIGGER trg_credit_balances_updated_at
  BEFORE UPDATE ON public.credit_balances
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Append-only credit ledger
CREATE TABLE public.credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  delta integer NOT NULL,                  -- positive = grant/topup, negative = spend
  reason text NOT NULL,                    -- 'plan_grant' | 'topup' | 'spend' | 'adjustment' | 'refund'
  ai_model text,                           -- e.g. 'google/gemini-3-flash-preview'
  ref_type text,                           -- e.g. 'content_pages' | 'stripe_invoice' | 'page_audits'
  ref_id text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX credit_ledger_workspace_id_created_at_idx ON public.credit_ledger(workspace_id, created_at DESC);

ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members read credit_ledger" ON public.credit_ledger
  FOR SELECT TO authenticated USING (is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "Service role writes credit_ledger" ON public.credit_ledger
  FOR ALL TO public USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
CREATE POLICY "Admin escape credit_ledger" ON public.credit_ledger
  FOR ALL TO authenticated USING (has_role(auth.uid(),'admin')) WITH CHECK (has_role(auth.uid(),'admin'));

-- Atomic credit deduction helper (used by edge functions before AI calls)
CREATE OR REPLACE FUNCTION public.deduct_credits(
  _workspace_id uuid,
  _amount integer,
  _reason text,
  _ai_model text DEFAULT NULL,
  _ref_type text DEFAULT NULL,
  _ref_id text DEFAULT NULL,
  _metadata jsonb DEFAULT '{}'::jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_balance integer;
BEGIN
  IF _amount <= 0 THEN
    RAISE EXCEPTION 'deduct_credits: amount must be positive';
  END IF;

  UPDATE public.credit_balances
     SET balance = balance - _amount,
         lifetime_spent = lifetime_spent + _amount
   WHERE workspace_id = _workspace_id
     AND balance >= _amount
   RETURNING balance INTO new_balance;

  IF new_balance IS NULL THEN
    RAISE EXCEPTION 'insufficient_credits' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.credit_ledger (workspace_id, delta, reason, ai_model, ref_type, ref_id, metadata)
  VALUES (_workspace_id, -_amount, _reason, _ai_model, _ref_type, _ref_id, _metadata);

  RETURN new_balance;
END;
$$;

-- Grant credits (plan refresh, topup, refund, manual adjustment)
CREATE OR REPLACE FUNCTION public.grant_credits(
  _workspace_id uuid,
  _amount integer,
  _reason text,
  _ref_type text DEFAULT NULL,
  _ref_id text DEFAULT NULL,
  _metadata jsonb DEFAULT '{}'::jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_balance integer;
BEGIN
  IF _amount <= 0 THEN
    RAISE EXCEPTION 'grant_credits: amount must be positive';
  END IF;

  INSERT INTO public.credit_balances (workspace_id, balance, lifetime_granted)
  VALUES (_workspace_id, _amount, _amount)
  ON CONFLICT (workspace_id) DO UPDATE
    SET balance = credit_balances.balance + EXCLUDED.balance,
        lifetime_granted = credit_balances.lifetime_granted + EXCLUDED.lifetime_granted
  RETURNING balance INTO new_balance;

  INSERT INTO public.credit_ledger (workspace_id, delta, reason, ref_type, ref_id, metadata)
  VALUES (_workspace_id, _amount, _reason, _ref_type, _ref_id, _metadata);

  RETURN new_balance;
END;
$$;

-- Seed the internal workspace with a starter balance so admin tools keep working
INSERT INTO public.credit_balances (workspace_id, balance, monthly_allowance, lifetime_granted)
VALUES ('6501e018-473c-4c09-a834-a0bdb59aa0ee', 100000, 100000, 100000)
ON CONFLICT (workspace_id) DO NOTHING;
