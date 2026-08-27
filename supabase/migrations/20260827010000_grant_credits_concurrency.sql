-- Make grant_credits idempotent under CONCURRENT webhook delivery.
--
-- The existing guard is an EXISTS check on credit_ledger: two transactions
-- processing the same Stripe event at the same time both pass the check, both
-- increment the balance, and the workspace is double-credited. Fix in two
-- parts:
--   1) a partial UNIQUE index on (reason, ref_type, ref_id) for positive
--      grants, so the second concurrent insert fails instead of duplicating;
--   2) reorder grant_credits to insert the ledger row FIRST and catch
--      unique_violation — the loser of the race returns the current balance
--      without touching it.

-- Existing duplicate positive grants would block the index; keep the earliest.
-- (Expected to delete zero rows: the webhook was only just brought online.)
DELETE FROM public.credit_ledger a
 USING public.credit_ledger b
 WHERE a.delta > 0 AND b.delta > 0
   AND a.reason = b.reason
   AND a.ref_type = b.ref_type AND a.ref_id = b.ref_id
   AND a.ref_type IS NOT NULL AND a.ref_id IS NOT NULL
   AND a.ctid > b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_grant_ref_unique
  ON public.credit_ledger (reason, ref_type, ref_id)
  WHERE delta > 0 AND ref_type IS NOT NULL AND ref_id IS NOT NULL;

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

  -- Ledger first: the partial unique index makes this the atomic idempotency
  -- gate. A concurrent duplicate loses here and returns the current balance.
  IF _ref_id IS NOT NULL AND _ref_type IS NOT NULL THEN
    BEGIN
      INSERT INTO public.credit_ledger (workspace_id, delta, reason, ref_type, ref_id, metadata)
      VALUES (_workspace_id, _amount, _reason, _ref_type, _ref_id, _metadata);
    EXCEPTION WHEN unique_violation THEN
      SELECT balance INTO existing_balance
        FROM public.credit_balances
       WHERE workspace_id = _workspace_id;
      RETURN COALESCE(existing_balance, 0);
    END;
  ELSE
    -- Un-referenced grants (no idempotency key) are always applied.
    INSERT INTO public.credit_ledger (workspace_id, delta, reason, ref_type, ref_id, metadata)
    VALUES (_workspace_id, _amount, _reason, _ref_type, _ref_id, _metadata);
  END IF;

  INSERT INTO public.credit_balances (workspace_id, balance, lifetime_granted)
  VALUES (_workspace_id, _amount, _amount)
  ON CONFLICT (workspace_id) DO UPDATE
    SET balance = credit_balances.balance + EXCLUDED.balance,
        lifetime_granted = credit_balances.lifetime_granted + EXCLUDED.lifetime_granted
  RETURNING balance INTO new_balance;

  RETURN new_balance;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.grant_credits(uuid, integer, text, text, text, jsonb) FROM anon, authenticated, public;
