/**
 * Fair-use limits quoted in customer-facing copy. The enforced value lives in
 * platform_settings (generation_daily_cap, seeded by migration 20260923000300)
 * so ops can lower it without a deploy; this is the seeded default the copy
 * promises. Keep the two in step.
 *
 * Because ops can move the knob, prose that quotes this constant (/beta, the
 * billing page, the homepage FAQ) says "currently N", never a flat N. The
 * page builder (app.pages.new.tsx) does not quote it at all: the live value
 * is enforced by reserve_generation_slot on every draft, and a refusal names
 * the number actually in force for that workspace (dailyCapMessage).
 */
export const GENERATION_DAILY_CAP = 50;
