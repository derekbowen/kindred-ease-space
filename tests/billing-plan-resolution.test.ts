/**
 * Plan resolution and catalog agreement.
 * Run: bun tests/billing-plan-resolution.test.ts
 *
 * Two failure modes are covered, both of which end with a paying customer
 * holding less than they bought:
 *
 *   1. A Stripe price with no `plan_tier` metadata resolved to "unknown",
 *      which gave 0 pages, which made the webhook skip the entitlement update
 *      silently. The customer was charged and stayed on trial capacity.
 *   2. The plan catalog is hand-mirrored between the edge function (which
 *      drives Stripe and the webhook) and the app (which drives the UI). They
 *      had already drifted once. If they disagree, the price a customer is
 *      shown is not the price they are charged.
 */
import {
  PAGE_PLANS as EDGE_PLANS,
  pagesForTier,
  tierByMonthlyPrice,
  type PlanTier,
} from "../supabase/functions/_shared/stripe-catalog.ts";
import { PAGE_PLANS as APP_PLANS } from "../src/lib/plan-catalog";

let pass = 0, fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL  ${name}  ${extra}`); }
}

console.log("\n=== recovering a plan from what the customer is charged ===");
{
  for (const tier of Object.keys(EDGE_PLANS) as PlanTier[]) {
    const cents = EDGE_PLANS[tier].monthlyPriceCents;
    t(`$${cents / 100} resolves to "${tier}"`, tierByMonthlyPrice(cents) === tier,
      String(tierByMonthlyPrice(cents)));
  }
}

console.log("\n=== recovery refuses to guess ===");
{
  t("an amount matching no plan returns null", tierByMonthlyPrice(7700) === null);
  t("zero returns null", tierByMonthlyPrice(0) === null);
  t("negative returns null", tierByMonthlyPrice(-2900) === null);
  t("null returns null", tierByMonthlyPrice(null) === null);
  t("undefined returns null", tierByMonthlyPrice(undefined) === null);
  t("a non-number returns null", tierByMonthlyPrice("2900" as unknown as number) === null);

  // The guard that matters: if two plans ever share a price, the amount stops
  // being evidence and recovery must decline rather than pick one.
  const prices = (Object.keys(EDGE_PLANS) as PlanTier[]).map((k) => EDGE_PLANS[k].monthlyPriceCents);
  t("no two plans share a price, so recovery is unambiguous",
    new Set(prices).size === prices.length, prices.join(","));
}

console.log("\n=== every sellable plan grants capacity ===");
{
  // This is the invariant whose violation caused the silent skip: a tier the
  // catalog sells must never resolve to zero pages.
  for (const tier of Object.keys(EDGE_PLANS) as PlanTier[]) {
    t(`"${tier}" grants pages`, pagesForTier(tier) > 0, String(pagesForTier(tier)));
  }
  t('an unknown tier still yields 0 (caller must escalate)', pagesForTier("unknown") === 0);
  t("null tier yields 0", pagesForTier(null) === 0);
}

console.log("\n=== the two hand-mirrored catalogs agree ===");
{
  const appByKey = new Map(APP_PLANS.map((p) => [p.key, p]));
  const edgeKeys = Object.keys(EDGE_PLANS) as PlanTier[];

  t("same number of plans", APP_PLANS.length === edgeKeys.length,
    `app ${APP_PLANS.length} vs edge ${edgeKeys.length}`);

  for (const tier of edgeKeys) {
    const app = appByKey.get(tier as string);
    t(`app catalog has "${tier}"`, !!app);
    if (!app) continue;
    t(
      `"${tier}" price agrees (app $${app.monthlyPrice} vs edge ${EDGE_PLANS[tier].monthlyPriceCents}c)`,
      app.monthlyPrice * 100 === EDGE_PLANS[tier].monthlyPriceCents,
    );
    t(
      `"${tier}" page capacity agrees (app ${app.includedPages} vs edge ${EDGE_PLANS[tier].includedPages})`,
      app.includedPages === EDGE_PLANS[tier].includedPages,
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("Failed: " + failed.join(", ")); process.exit(1); }
