/**
 * AI CREDIT PACKS ARE NOT FOR SALE. Run: bun tests/credit-pack-withdrawn.test.ts
 *
 * Credits were withdrawn as a customer-facing SKU, but only from the UI. The
 * checkout function kept `mode: "credits"` in its accepted set and would
 * provision a $10/1,000-credit Stripe price for anyone who POSTed it directly —
 * a product we do not sell, purchasable by API, indefinitely.
 *
 * Removing a button is not removing a product. These assertions are about the
 * ENDPOINT, because the endpoint is what a caller reaches.
 *
 * Asserted against source rather than over the wire: the live function needs
 * Stripe credentials and a real workspace, and a test that only runs when
 * someone remembers to deploy first is a test that never runs. The properties
 * here are exactly the ones that made the hole reachable.
 */
import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

const CHECKOUT = resolve(ROOT, "supabase/functions/create-checkout/index.ts");
const CATALOG = resolve(ROOT, "supabase/functions/_shared/stripe-catalog.ts");

console.log("\n=== the checkout endpoint refuses credit packs ===");

// A missing file must fail, never vacuously pass — the same fail-open shape
// that let an inert secrets preflight report success for a Worker missing
// every secret it was meant to check.
t("checkout function source is readable", existsSync(CHECKOUT), CHECKOUT);
if (!existsSync(CHECKOUT)) {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}
const src = readFileSync(CHECKOUT, "utf8");

t(
  '"credits" is not an accepted mode',
  /const validModes\s*=\s*\[(?![^\]]*"credits")[^\]]*\]/.test(src),
  "validModes still lists credits",
);

t(
  "an explicit refusal exists for mode:credits",
  /mode\s*===\s*"credits"/.test(src) && src.includes("credits_unavailable"),
  "no distinguishable refusal — a caller cannot tell withdrawn from malformed",
);

t(
  "the refusal is 410 Gone, not a generic 400",
  /credits_unavailable[\s\S]{0,400}?status:\s*410/.test(src),
  "410 says the product existed and is gone; 400 says the caller typed it wrong",
);

t(
  "the refusal precedes generic mode validation",
  src.indexOf('mode === "credits"') > -1 &&
    src.indexOf('mode === "credits"') < src.indexOf('error: "invalid_mode"'),
  "generic validation would swallow it first and report invalid_mode",
);

t(
  "no reachable call to ensureCreditPackPrice remains",
  !/await\s+ensureCreditPackPrice\s*\(/.test(src),
  "a live code path can still provision the price",
);

t(
  "ensureCreditPackPrice is no longer imported by checkout",
  !/^\s*ensureCreditPackPrice,\s*$/m.test(src),
  "unused import keeps the path one edit from returning",
);

console.log("\n=== historical data and schema are preserved ===");

t("catalog source is readable", existsSync(CATALOG), CATALOG);
const catalog = existsSync(CATALOG) ? readFileSync(CATALOG, "utf8") : "";

t(
  "CREDIT_PACK definition is retained",
  catalog.includes("export const CREDIT_PACK"),
  "deleting it would make deliberate restoration a rewrite rather than a revert",
);

t(
  "ensureCreditPackPrice is retained in the catalog",
  catalog.includes("export async function ensureCreditPackPrice"),
  "same reason — dormant, not destroyed",
);

{
  // Internal metering moved from src/lib/ai-metering.server.ts (deleted with
  // the OpenAI switch) to the one spend path: src/lib/ai/spend.server.ts
  // reserves through ai_reserve and settles through ai_settle, and those
  // hold/refund credit_balances in migration 20260925000800.
  const spend = readFileSync(resolve(ROOT, "src/lib/ai/spend.server.ts"), "utf8");
  const spendSql = readFileSync(
    resolve(ROOT, "supabase/migrations/20260925000800_ai_spend_reservations.sql"),
    "utf8",
  );
  t(
    "internal credit metering is untouched",
    /\.rpc\(\s*"ai_reserve"/.test(spend) &&
      /\.rpc\(\s*"ai_settle"/.test(spend) &&
      /UPDATE public\.credit_balances/.test(spendSql),
    "withdrawing the SKU must not disable internal generation metering",
  );
}

console.log("\n=== the supported checkout modes are unaffected ===");

// Withdrawing one SKU must not narrow the endpoint by accident. These are the
// paths a paying customer still uses; a regression here is a checkout outage.
for (const mode of ["subscription", "addon", "page_addon"]) {
  t(
    `"${mode}" is still an accepted mode`,
    new RegExp(`const validModes\\s*=\\s*\\[[^\\]]*"${mode}"`).test(src),
    `validModes no longer lists ${mode}`,
  );
}

t(
  "the 410 matches credits EXACTLY and cannot catch another mode",
  /mode\s*===\s*"credits"/.test(src) &&
    !/mode\s*\.\s*(startsWith|includes)\s*\(\s*"credit/.test(src),
  "a loose match would refuse modes we still sell",
);

t(
  "subscription still routes to ensureSubscriptionPrice",
  /await\s+ensureSubscriptionPrice\s*\(/.test(src),
  "the plan checkout path is gone",
);
t(
  "addon still routes to ensureAddonPrice",
  /await\s+ensureAddonPrice\s*\(/.test(src),
  "the feature add-on path is gone",
);
t(
  "page_addon still routes to ensurePageAddonPrice",
  /await\s+ensurePageAddonPrice\s*\(/.test(src),
  "the page capacity add-on path is gone",
);

t(
  "per-mode input validation survives (invalid_tier / invalid_addon)",
  src.includes('error: "invalid_tier"') && src.includes('error: "invalid_addon"'),
  "removing a mode must not remove the guards on the others",
);

t(
  "all three remaining modes still bill as Stripe subscriptions",
  /const isSubscription\s*=\s*mode === "subscription" \|\| mode === "addon" \|\| mode === "page_addon"/.test(
    src,
  ),
  "a mode falling out of isSubscription would silently become a one-off payment",
);

t(
  "an unknown mode is still a 400 invalid_mode, not a 410",
  /error: "invalid_mode"[\s\S]{0,200}?status:\s*400/.test(src),
  "410 must mean withdrawn, not merely unrecognised",
);

console.log("\n=== no credit-pack purchase path exists in the UI ===");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

const SRC = resolve(ROOT, "src");
const uiFiles = existsSync(SRC) ? walk(SRC) : [];
t("src tree is readable", uiFiles.length > 0, SRC);

const creditInvokers = uiFiles.filter((f) => {
  const body = readFileSync(f, "utf8");
  if (!/create-checkout|checkout\s*\(/.test(body)) return false;
  return /checkout\s*\(\s*"credits"/.test(body) || /mode:\s*"credits"/.test(body);
});
t(
  "no UI file starts a credit-pack checkout",
  creditInvokers.length === 0,
  creditInvokers.join(", "),
);

const BILLING = resolve(ROOT, "src/routes/_authenticated/app.billing.tsx");
t("billing page source is readable", existsSync(BILLING), BILLING);
const billing = existsSync(BILLING) ? readFileSync(BILLING, "utf8") : "";
t(
  'the checkout helper\'s mode union excludes "credits"',
  /mode:\s*"subscription"\s*\|\s*"page_addon"/.test(billing) && !/\|\s*"credits"/.test(billing),
  "the literal remaining in the union keeps the product one call site from returning",
);

t(
  "no credit-pack pricing copy remains in the UI",
  !uiFiles.some((f) => /per 1,000 generation credits|\$10 per 1,000/.test(readFileSync(f, "utf8"))),
  "the site would advertise a SKU the API refuses",
);

console.log("\n=== no AI refusal promises a purchase that does not exist ===");
{
  // The Coach, the AI proxy and the SEO coach once refused with a purchase
  // that is not for sale ("Top up in Billing", "top up in Settings →
  // Workspace → Usage"). Since the OpenAI switch every AI route refuses an
  // empty allowance through ONE sentence — AI_MESSAGES.outOfFunds in
  // src/lib/ai/customer-error.ts, chosen by refusalMessage("insufficient")
  // in src/lib/ai/spend.server.ts — or page generation's own
  // outOfCreditsMessage(). coach-chat and ai-proxy no longer exist.
  const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");
  const customerErrors = read("src/lib/ai/customer-error.ts");
  const spend = read("src/lib/ai/spend.server.ts");
  const generation = read("src/lib/generation.server.ts");
  const seoCoach = read("src/lib/admin-seo-coach.functions.ts");
  const outOfFunds = customerErrors.match(/outOfFunds:\s*"([^"]+)"/)?.[1] ?? "";
  const generationMsg =
    generation.match(/export function outOfCreditsMessage\(\): string \{\s*return "([^"]+)";/)?.[1] ??
    "";
  t("the shared out-of-allowance refusal was found", outOfFunds.length > 0);
  t("page generation's out-of-credits refusal was found", generationMsg.length > 0);
  t(
    "an 'insufficient' reservation is refused with the shared sentence",
    /case "insufficient":\s*return AI_MESSAGES\.outOfFunds;/.test(spend),
  );
  for (const [label, msg] of [
    ["shared AI refusal", outOfFunds],
    ["page generation refusal", generationMsg],
  ] as const) {
    t(
      `${label} names the included allowance and support`,
      /included AI generation/.test(msg) && /contact support/i.test(msg),
      msg,
    );
    t(
      `${label} has no purchase path`,
      !/top up/i.test(msg) && !/Billing/.test(msg) && !/buy|purchase/i.test(msg),
      msg,
    );
  }
  t(
    "the SEO coach refuses through the shared spend path (no route-specific purchase copy)",
    /runMeteredAiCall/.test(seoCoach) && !/status === 402/.test(seoCoach),
  );
  t(
    "coach-chat and ai-proxy are gone, not merely unreferenced",
    !existsSync(resolve(ROOT, "supabase/functions/coach-chat")) &&
      !existsSync(resolve(ROOT, "supabase/functions/ai-proxy")),
  );
  const aiSources = [
    "src/lib/ai/customer-error.ts",
    "src/lib/ai/spend.server.ts",
    "src/lib/generation.server.ts",
    "src/lib/admin-seo-coach.functions.ts",
    "src/lib/coach-actions.functions.ts",
    "src/lib/admin-page-auditor.functions.ts",
    "supabase/functions/coach-briefing-cron/index.ts",
  ];
  const offering = aiSources.filter((rel) => /top up/i.test(read(rel)));
  t("no AI source still offers a top-up", offering.length === 0, offering.join(", "));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed: " + failed.join(", "));
  process.exit(1);
}
