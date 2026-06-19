-- Make grant_credits idempotent on (reason, ref_type, ref_id).
--
-- Stripe redelivers webhook events (and may deliver the same event more than
-- once). The previous grant_credits was purely additive, so every redelivery
-- of `checkout.session.completed` (topup) or `invoice.paid` (monthly grant)
-- granted the credits again, over-crediting the workspace. Guarding on the
-- ledger's reference makes repeated grants for the same Stripe object a no-op.

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
  existing_balance integer;
BEGIN
  IF _amount <= 0 THEN
    RAISE EXCEPTION 'grant_credits: amount must be positive';
  END IF;

  -- Idempotency guard: if a positive ledger entry already exists for this exact
  -- (reason, ref_type, ref_id), the grant has already been applied. Return the
  -- current balance without granting again.
  IF _ref_id IS NOT NULL AND _ref_type IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.credit_ledger
       WHERE ref_type = _ref_type
         AND ref_id = _ref_id
         AND reason = _reason
         AND delta > 0
    ) THEN
      SELECT balance INTO existing_balance
        FROM public.credit_balances
       WHERE workspace_id = _workspace_id;
      RETURN COALESCE(existing_balance, 0);
    END IF;
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

REVOKE EXECUTE ON FUNCTION public.grant_credits(uuid, integer, text, text, text, jsonb) FROM anon, authenticated, public;
