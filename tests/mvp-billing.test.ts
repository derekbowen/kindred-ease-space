/**
 * THE ORDINARY PAYING CUSTOMER. Run: bun tests/mvp-billing.test.ts
 *
 * What the plans promise and what the code does must agree:
 *   - "AI page generation is included with every plan": a paid plan in good
 *     standing, in its retry window, or on a beta grant generates without
 *     tenant credits (billing 'granted'), bounded by the caps; a trial runs on
 *     its starter allowance; ended states are metered — and the page builder
 *     refuses them outright (tests/page-draft-flow.test.ts: a lapsed plan
 *     cannot draft);
 *   - a cancelled customer can choose a plan again (checkout), not only
 *     "Switch via portal", which can't restart a cancelled subscription;
 *   - the plan follows the price being charged (tests/stripe-webhook.test.ts:
 *     a Billing Portal plan change is honoured) and payment restores pages
 *     only up to the plan's capacity (the same test file).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GENERATION_INCLUDED_STATES, generationIncludedFor } from "../src/lib/generation.server";

let pass = 0,
  fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failed.push(name);
    console.log(`  FAIL  ${name}  ${extra}`);
  }
}
const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

console.log("\n1. Generation is included where the plans say it is");
for (const s of ["active", "grace", "granted"]) t(`${s}: included`, generationIncludedFor(s));
for (const s of ["trialing", "trial_expired", "lapsed", "stale", "unknown", "internal", "", null]) {
  t(
    `${String(s)}: not 'granted' billing (trial allowance, metered, or internal's own class)`,
    !generationIncludedFor(s as string),
  );
}
t("exactly three included states", GENERATION_INCLUDED_STATES.length === 3);
const gen = read("src/lib/generation.server.ts");
t(
  "isGenerationGranted reads the billing state through generationIncludedFor",
  /return generationIncludedFor\(ent\.billingState\);/.test(gen),
);
t(
  "…and a failed read meters (never free)",
  /catch \(e\) \{[\s\S]*?metering normally[\s\S]*?return false;/.test(gen),
);

console.log("\n2. A cancelled customer can subscribe again");
const billing = read("src/routes/_authenticated/app.billing.tsx");
t(
  "cancelled / expired subscriptions don't count as a plan the portal can change",
  /const ENDED_SUBSCRIPTION_STATUSES = \["canceled", "incomplete_expired"\];/.test(billing) &&
    /!ENDED_SUBSCRIPTION_STATUSES\.includes\(String\(ent\.subscriptionStatus\)\)/.test(billing),
);
t(
  "without a live plan the buttons start checkout",
  /onClick=\{\(\) => \(hasPlan \? openPortal\(\) : checkout\("subscription", 1, p\.key\)\)\}/.test(
    billing,
  ),
);
const checkout = read("supabase/functions/create-checkout/index.ts");
t(
  "create-checkout still refuses a second plan beside a live one (active, trialing, past_due)",
  /\.in\("status", \["active", "trialing", "past_due"\]\)[\s\S]*?already_subscribed/.test(checkout),
);

console.log("\n3. The webhook: the price is the plan; reactivation respects capacity");
const hook = read("supabase/functions/stripe-webhook/index.ts");
t(
  "the item price's plan comes first; checkout-time metadata is the last resort",
  hook.indexOf("itemPrice?.metadata?.plan_tier") > 0 &&
    hook.indexOf("itemPrice?.metadata?.plan_tier") <
      hook.indexOf("if (includedPages === 0 && sub.metadata?.plan_tier)"),
);
t(
  "reactivation goes through publish_tenant_pages (the capacity gate)",
  /async function reactivatePages[\s\S]*?admin\.rpc\("publish_tenant_pages"/.test(hook) &&
    !/update\(\{ status: "published" \}/.test(hook),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
