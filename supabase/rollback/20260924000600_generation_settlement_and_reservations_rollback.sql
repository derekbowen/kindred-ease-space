-- ROLLBACK for 20260924000600_generation_settlement_and_reservations.sql
-- Drops the two RPCs, the consumed-count function, the settlement index, the
-- reservations table and the tenant_pages billing-mode column.
--
-- PAIR THIS WITH A CODE ROLLBACK. The build shipped with 000600 calls
-- settle_generation_free_quota, reserve_generation_slot and
-- generation_consumed_last_24h and writes tenant_pages.generation_billing_mode;
-- with this file applied and that build still deployed, every generation fails
-- at the cap check and every draft insert fails on the missing column. Redeploy
-- the previous Worker version FIRST (it ignores all of these objects), then
-- run this file.
--
-- What it forgets: free-quota settlement records. The delta-0 ai_usage rows
-- settle_generation_free_quota wrote are left in credit_ledger (history is
-- kept), but the previous build's findLedgerCharge recognises only delta < 0
-- rows and nothing is unique per page any more — so a retry after rollback can
-- settle a free-quota page a second time (one more free credit consumed, or a
-- credit deduction for a page the quota already covered). Re-applying 000600
-- after such a re-settlement fails on CREATE UNIQUE INDEX; keep the earliest
-- row per (workspace_id, ref_id) by hand before re-applying.
-- Pages are never touched. Dropping the reservations table forgets only the
-- in-flight daily-cap reservations (at most 24 hours of them).
BEGIN;
DROP FUNCTION IF EXISTS public.reserve_generation_slot(uuid, uuid, int);
DROP FUNCTION IF EXISTS public.generation_consumed_last_24h(uuid, uuid);
DROP FUNCTION IF EXISTS public.settle_generation_free_quota(uuid, text, text, text);
DROP TABLE IF EXISTS public.generation_reservations;
DROP INDEX IF EXISTS public.credit_ledger_generation_settlement_uidx;
-- The check constraint goes with the column.
ALTER TABLE public.tenant_pages DROP COLUMN IF EXISTS generation_billing_mode;
COMMIT;
-- VERIFY (rolled back): expect 0 rows
SELECT 'function ' || p.proname AS leftover
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('settle_generation_free_quota','reserve_generation_slot','generation_consumed_last_24h')
UNION ALL
SELECT 'table ' || table_name FROM information_schema.tables
 WHERE table_schema='public' AND table_name='generation_reservations'
UNION ALL
SELECT 'index ' || indexname FROM pg_indexes
 WHERE schemaname='public' AND indexname='credit_ledger_generation_settlement_uidx'
UNION ALL
SELECT 'column ' || column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='tenant_pages' AND column_name='generation_billing_mode';
