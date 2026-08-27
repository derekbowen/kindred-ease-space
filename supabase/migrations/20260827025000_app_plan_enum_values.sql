-- Must run (and COMMIT) before 20260827030000_page_entitlements.sql:
-- Postgres forbids reading a new enum value in the transaction that adds it
-- (error 55P04), and the entitlement migration's verification block reads
-- enum_range(). Keeping the ADD VALUEs in their own migration guarantees the
-- commit boundary regardless of how migrations are applied.
ALTER TYPE public.app_plan ADD VALUE IF NOT EXISTS 'pro';
ALTER TYPE public.app_plan ADD VALUE IF NOT EXISTS 'agency';
