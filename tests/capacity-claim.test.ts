/**
 * "ADD CAPACITY IN BLOCKS OF 1,000" SAYS WHERE, AND IS TRUE. Run: bun tests/capacity-claim.test.ts
 *
 * The homepage promised "Add capacity in blocks of 1,000 from your dashboard".
 * The add-on exists, but not on the dashboard: it is the "Need more pages
 * without changing plans?" card on Billing & Plans, shown once a paid plan is
 * active. This suite pins both halves: the copy names the real place and the
 * paid-plan condition, and the purchase path it points at really exists
 * (billing card → create-checkout page_addon → Stripe catalog → webhook).
 * Offline: reads source files, including the edge functions (read only).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PAGE_ADDON } from "../src/lib/plan-catalog";

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

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const collapse = (s: string) => s.replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
console.log("\nthe public copy says where");

const home = collapse(read("src/routes/index.tsx"));
const beta = collapse(read("src/routes/beta.tsx"));
t('homepage no longer says "from your dashboard"', !/from your dashboard/i.test(home));
t(
  "homepage names Billing & Plans and the paid-plan condition",
  /On any paid plan, add capacity in blocks of\{" "\} \{PAGE_ADDON\.pagesPerUnit\.toLocaleString\(\)\} pages/.test(home) &&
    /under Billing &amp; Plans in the app/.test(home),
);
t("homepage quotes the catalog price", /\(\$\{PAGE_ADDON\.monthlyPrice\}\/month per block\)/.test(home));
t(
  "/beta says any PAID plan and where to add it",
  /on top of any paid plan\. Add it under Billing &amp; Plans in the app once your plan is active\./.test(beta),
);
t("the sidebar label the copy names exists", /label: "Billing & Plans"/.test(read("src/lib/app-nav.ts")));

// ---------------------------------------------------------------------------
console.log("\nthe purchase path exists");

const billing = read("src/routes/_authenticated/app.billing.tsx");
t(
  'Billing & Plans has the "Need more pages without changing plans?" card',
  billing.includes("Need more pages without changing plans?"),
);
t("that card is shown with a paid plan", /\{hasPlan && \(\s*<Card>\s*<CardHeader>\s*<CardTitle className="text-base">Need more pages/.test(billing));
t("it starts a page_addon checkout", /checkout\("page_addon", addonQty\)/.test(billing));
t("it sells whole blocks of the catalog size", /addonQty \* PAGE_ADDON\.pagesPerUnit/.test(billing));

const checkout = read("supabase/functions/create-checkout/index.ts");
t("create-checkout accepts page_addon", /const validModes = \["subscription", "addon", "page_addon"\]/.test(checkout));
t("create-checkout requires a base plan first", /plan_required/.test(checkout) && /extra page capacity stacks on top of a base plan/.test(checkout));
t("create-checkout prices it from the catalog", /mode === "page_addon"\s*\?\s*await ensurePageAddonPrice\(stripe\)/.test(checkout));

const catalog = read("supabase/functions/_shared/stripe-catalog.ts");
const cents = Number(catalog.match(/monthlyPriceCents: (\d+),\s*pagesPerUnit: \d+/)?.[1]);
const perUnit = Number(catalog.match(/monthlyPriceCents: \d+,\s*pagesPerUnit: (\d+)/)?.[1]);
t(
  "the Stripe catalog block matches the app catalog (1,000 pages, $50)",
  perUnit === PAGE_ADDON.pagesPerUnit && cents === PAGE_ADDON.monthlyPrice * 100,
  `stripe ${perUnit} pages / ${cents}c; app ${PAGE_ADDON.pagesPerUnit} / $${PAGE_ADDON.monthlyPrice}`,
);

const webhook = read("supabase/functions/stripe-webhook/index.ts");
t(
  "the webhook grants quantity × block size",
  /sub\.metadata\?\.page_addon === "1"/.test(webhook) &&
    /qty \* PAGE_ADDON\.pagesPerUnit/.test(webhook) &&
    /page_limit_addon: addonPages/.test(webhook),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
