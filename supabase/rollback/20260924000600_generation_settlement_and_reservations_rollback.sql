-- ROLLBACK for 20260924000600_generation_settlement_and_reservations.sql
-- Drops the tenant_pages pin trigger and its function, the four reservation
-- RPCs (reserve, mark, release, settle), the consumed-count function, the
-- settlement index, the reservations table and the tenant_pages billing-mode
-- column.
--
-- PAIR THIS WITH A CODE ROLLBACK. The build shipped with 000600 calls
-- settle_generation_free_quota, reserve_generation_slot,
-- mark_generation_provider_called, release_generation_slot and
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
-- Pages are never touched. Dropping the reservations table forgets the last
-- 24 hours of daily-cap consumption (every provider call is a reservation
-- row), so each workspace gets a full day's cap back at once. Dropping the
-- pin trigger lets members edit created_at, generation_request_id and
-- generation_billing_mode on their pages again.
--
-- Order matters: the trigger function reads NEW.generation_billing_mode, so
-- the trigger goes before the column (an UPDATE in between would fail).
BEGIN;
DROP TRIGGER IF EXISTS tenant_pages_pin_generation_columns ON public.tenant_pages;
DROP FUNCTION IF EXISTS public.tenant_pages_pin_generation_columns();
DROP FUNCTION IF EXISTS public.release_generation_slot(uuid, uuid);
DROP FUNCTION IF EXISTS public.mark_generation_provider_called(uuid, uuid);
DROP FUNCTION IF EXISTS public.reserve_generation_slot(uuid, uuid, int);
DROP FUNCTION IF EXISTS public.generation_consumed_last_24h(uuid);
-- The (uuid, uuid) signature of an earlier draft of 000600, should a scratch
-- database still carry it. A no-op everywhere else.
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
   AND p.proname IN ('settle_generation_free_quota','reserve_generation_slot','generation_consumed_last_24h',
                     'mark_generation_provider_called','release_generation_slot',
                     'tenant_pages_pin_generation_columns')
UNION ALL
SELECT 'trigger ' || tgname FROM pg_trigger
 WHERE tgname = 'tenant_pages_pin_generation_columns'
UNION ALL
SELECT 'table ' || table_name FROM information_schema.tables
 WHERE table_schema='public' AND table_name='generation_reservations'
UNION ALL
SELECT 'index ' || indexname FROM pg_indexes
 WHERE schemaname='public' AND indexname='credit_ledger_generation_settlement_uidx'
UNION ALL
SELECT 'column ' || column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='tenant_pages' AND column_name='generation_billing_mode';
