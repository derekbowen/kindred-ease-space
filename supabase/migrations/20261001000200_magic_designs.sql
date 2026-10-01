-- Magic Designs by founders.click: custom Sharetribe marketplace designs paid
-- for with design tokens.
--
-- Design tokens are their own product. They are NOT the SaaS's internal AI
-- credits (credit_balances / credit_ledger), which stay internal metering.
--
-- Write model, the same as billing elsewhere in this schema:
--   * Every write goes through the service role (server functions and the
--     design-token edge functions). `anon` and `authenticated` get SELECT on
--     their own rows and nothing else — no INSERT/UPDATE/DELETE grant at all,
--     so RLS is not the only thing standing between a user and their balance.
--   * The ledger is append-only. A balance is the sum of a user's ledger rows.
--   * (reason, ref) is unique, so a retried purchase claim or a retried spend
--     can never grant or charge twice.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.spend_design_tokens(uuid, integer, text, text);
--   DROP FUNCTION IF EXISTS public.design_token_balance(uuid);
--   DROP TABLE IF EXISTS public.magic_design_requests;
--   DROP TABLE IF EXISTS public.magic_designs;
--   DROP TABLE IF EXISTS public.design_token_ledger;

CREATE TABLE IF NOT EXISTS public.design_token_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  delta integer NOT NULL CHECK (delta <> 0),
  reason text NOT NULL CHECK (reason IN ('purchase', 'design_create', 'design_change', 'refund', 'admin_grant')),
  ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT design_token_ledger_reason_ref_key UNIQUE (reason, ref)
);
CREATE INDEX IF NOT EXISTS design_token_ledger_user_idx ON public.design_token_ledger (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.magic_designs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  base_template text NOT NULL,
  brief jsonb NOT NULL,
  provider_design_id text,
  preview_url text,
  status text NOT NULL DEFAULT 'generating' CHECK (status IN ('generating', 'ready', 'failed')),
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS magic_designs_user_idx ON public.magic_designs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.magic_design_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  design_id uuid NOT NULL REFERENCES public.magic_designs (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('create', 'change')),
  summary text NOT NULL,
  tokens integer NOT NULL CHECK (tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS magic_design_requests_design_idx ON public.magic_design_requests (design_id, created_at);

ALTER TABLE public.design_token_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.magic_designs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.magic_design_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.design_token_ledger FROM anon, authenticated;
REVOKE ALL ON public.magic_designs FROM anon, authenticated;
REVOKE ALL ON public.magic_design_requests FROM anon, authenticated;
GRANT SELECT ON public.design_token_ledger TO authenticated;
GRANT SELECT ON public.magic_designs TO authenticated;
GRANT SELECT ON public.magic_design_requests TO authenticated;

DROP POLICY IF EXISTS "design_token_ledger_own_read" ON public.design_token_ledger;
CREATE POLICY "design_token_ledger_own_read" ON public.design_token_ledger
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "magic_designs_own_read" ON public.magic_designs;
CREATE POLICY "magic_designs_own_read" ON public.magic_designs
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "magic_design_requests_own_read" ON public.magic_design_requests;
CREATE POLICY "magic_design_requests_own_read" ON public.magic_design_requests
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- A user's balance: the sum of their ledger.
CREATE OR REPLACE FUNCTION public.design_token_balance(_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(delta), 0)::integer FROM public.design_token_ledger WHERE user_id = _user_id;
$$;

-- Spend tokens atomically. Returns true when charged, false when the balance
-- is short (nothing written). Serialised per user with an advisory lock so two
-- concurrent spends cannot both pass the balance check. Idempotent on
-- (reason, ref): a retry of a spend that already happened returns true again
-- without charging twice.
CREATE OR REPLACE FUNCTION public.spend_design_tokens(
  _user_id uuid,
  _amount integer,
  _reason text,
  _ref text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _balance integer;
BEGIN
  IF _amount <= 0 THEN
    RAISE EXCEPTION 'amount must be positive';
  END IF;
  IF _reason NOT IN ('design_create', 'design_change') THEN
    RAISE EXCEPTION 'not a spend reason: %', _reason;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('design_tokens:' || _user_id::text, 0));

  IF EXISTS (SELECT 1 FROM public.design_token_ledger WHERE reason = _reason AND ref = _ref) THEN
    RETURN true;
  END IF;

  SELECT COALESCE(SUM(delta), 0) INTO _balance FROM public.design_token_ledger WHERE user_id = _user_id;
  IF _balance < _amount THEN
    RETURN false;
  END IF;

  INSERT INTO public.design_token_ledger (user_id, delta, reason, ref)
  VALUES (_user_id, -_amount, _reason, _ref);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.design_token_balance(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.spend_design_tokens(uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.design_token_balance(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.spend_design_tokens(uuid, integer, text, text) TO service_role;

-- Verify (each row should read true):
--   SELECT relrowsecurity FROM pg_class WHERE oid IN ('public.design_token_ledger'::regclass, 'public.magic_designs'::regclass, 'public.magic_design_requests'::regclass);
--   SELECT NOT has_function_privilege('authenticated', 'public.spend_design_tokens(uuid,integer,text,text)', 'EXECUTE');
--   SELECT NOT has_table_privilege('authenticated', 'public.design_token_ledger', 'INSERT');
