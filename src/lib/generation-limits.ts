/**
 * Fair-use limits quoted in customer-facing copy. The enforced value lives in
 * platform_settings (generation_daily_cap, seeded by migration 20260923000300)
 * so ops can lower it without a deploy; this is the seeded default the copy
 * promises. Keep the two in step.
 *
 * Because ops can move the knob, prose that quotes this constant (/beta, the
 * billing page, the homepage FAQ) says "currently N", never a flat N. The
 * generate page (app.content.generate.tsx) does not quote it at all: it shows
 * the live value from the overview read (`overview.dailyCap`), which is the
 * number actually enforced against that workspace today.
 */
export const GENERATION_DAILY_CAP = 50;
