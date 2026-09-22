/**
 * Fair-use limits quoted in customer-facing copy. The enforced value lives in
 * platform_settings (generation_daily_cap, seeded by migration 20260923000300)
 * so ops can lower it without a deploy; this is the seeded default the copy
 * promises. Keep the two in step.
 */
export const GENERATION_DAILY_CAP = 50;
