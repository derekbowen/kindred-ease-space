/**
 * MAGIC DESIGNS. Run: bun tests/magic-designs.test.ts
 *
 * Custom Sharetribe marketplace designs paid for with design tokens. The
 * properties that keep the money and the product honest:
 *
 *   1. one price list: packs shown == packs charged, from the server catalog;
 *   2. tokens are spent before the engine works and refunded if it refuses,
 *      atomically and idempotently, and only the server can write them;
 *   3. a purchase is granted only for a paid design-token session of THAT
 *      user, once;
 *   4. the engine key and engine ids never reach the browser;
 *   5. every prompt and the developer handoff speak Sharetribe: the brief's
 *      transaction flow maps to a real process + unit type, and the download
 *      ships SHARETRIBE_SETUP.md with the matching listingTypes entry.
 *
 * Asserted against source plus the pure helpers, like the store's tests: the
 * live functions need Stripe and the design engine.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  CHANGE_PRESETS,
  DESIGN_TOKEN_COSTS,
  DESIGN_TOKEN_PACKS,
  MAGIC_DESIGN_BASES,
  TRANSACTION_TYPES,
  buildChangePrompt,
  buildCreatePrompt,
  buildSharetribeSetup,
  type MagicDesignBrief,
} from "../src/lib/magic-designs";
import { DESIGN_TOKEN_PACKS as SERVER_PACKS } from "../supabase/functions/_shared/design-tokens";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

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

console.log("\n=== 1. one price list ===");
const shown = DESIGN_TOKEN_PACKS.map((p) => `${p.key}:${p.tokens}:${p.priceCents}`).join();
const charged = SERVER_PACKS.map((p) => `${p.key}:${p.tokens}:${p.priceCents}`).join();
t("packs shown are the packs charged", shown === charged, `${shown} vs ${charged}`);
t(
  "a design costs more than a change, both positive",
  DESIGN_TOKEN_COSTS.create > DESIGN_TOKEN_COSTS.change && DESIGN_TOKEN_COSTS.change > 0,
);
t(
  "the smallest pack buys at least one design",
  Math.min(...SERVER_PACKS.map((p) => p.tokens)) >= DESIGN_TOKEN_COSTS.create,
);
const checkout = read("supabase/functions/design-token-checkout/index.ts");
t(
  "checkout prices from the catalog",
  /findDesignTokenPack\(body\.pack\)/.test(checkout) &&
    /unit_amount: pack\.priceCents/.test(checkout),
);
t(
  "checkout reads nothing but the pack from the request",
  !/body\.(price|amount|tokens|unit_amount|user_id)/.test(checkout),
);
t(
  "checkout requires a signed-in user",
  /auth\.getUser\(\)/.test(checkout) && /unauthorized/.test(checkout),
);
t(
  "checkout session carries no workspace_id (SaaS billing ignores it)",
  !/workspace_id:/.test(checkout),
);

console.log("\n=== 2. tokens: spend first, refund on failure, server-only ===");
const fns = read("src/lib/magic-designs.functions.ts");
const createBlock = fns.slice(
  fns.indexOf("export const createMagicDesign"),
  fns.indexOf("// ── Poll"),
);
t(
  "create: spend → engine → refund on engine failure",
  createBlock.indexOf("await spend(") < createBlock.indexOf("createEngineDesign(") &&
    /catch \(e\) \{\s*(await markFailed\(\);\s*)?await refund\(context\.userId, cost, id\);/.test(
      createBlock,
    ),
);
t(
  "create: refuses before spending when the engine is not configured",
  createBlock.indexOf("MAGIC_PATTERNS_API_KEY") < createBlock.indexOf("await spend("),
);
const changeBlock = fns.slice(
  fns.indexOf("export const requestMagicDesignChange"),
  fns.indexOf("// ── Download"),
);
t(
  "change: spend → engine → refund on engine failure",
  changeBlock.indexOf("await spend(") < changeBlock.indexOf("sendEnginePrompt(") &&
    /catch \(e\) \{\s*await refund\(context\.userId, cost, requestId\);/.test(changeBlock),
);
t(
  "change: refused while a design is still generating",
  /status === "generating"/.test(changeBlock),
);
t(
  "every handler requires a signed-in user",
  (fns.match(/createServerFn\(/g) ?? []).length ===
    (fns.match(/\.middleware\(\[requireSupabaseAuth\]\)/g) ?? []).length,
);
t("designs are always read scoped to their owner", /\.eq\("user_id", userId\)/.test(fns));
t("the engine is polled at most about once a minute", /MIN_POLL_MS = 55_000/.test(fns));

const mig = read("supabase/migrations/20261001000200_magic_designs.sql");
t("RLS on all three tables", (mig.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length === 3);
t(
  "clients get SELECT only",
  (mig.match(/GRANT SELECT ON public\.\w+ TO authenticated/g) ?? []).length === 3 &&
    !/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*TO (anon|authenticated)/i.test(mig),
);
t("own-rows read policies", (mig.match(/USING \(user_id = auth\.uid\(\)\)/g) ?? []).length === 3);
t("ledger is idempotent on (reason, ref)", /UNIQUE \(reason, ref\)/.test(mig));
t(
  "spend is serialised per user and idempotent",
  /pg_advisory_xact_lock/.test(mig) &&
    /IF EXISTS \(SELECT 1 FROM public\.design_token_ledger WHERE reason = _reason AND ref = _ref\)/.test(
      mig,
    ),
);
t("spend never goes below zero", /IF _balance < _amount THEN\s*RETURN false;/.test(mig));
t(
  "token functions are service_role only",
  /REVOKE ALL ON FUNCTION public\.spend_design_tokens[^;]*FROM PUBLIC, anon, authenticated/.test(
    mig,
  ) &&
    /REVOKE ALL ON FUNCTION public\.design_token_balance[^;]*FROM PUBLIC, anon, authenticated/.test(
      mig,
    ),
);
const migSql = mig.replace(/--.*$/gm, "");
t(
  "design tokens are separate from the SaaS AI credits",
  !/credit_balances|credit_ledger|grant_credits/.test(migSql) &&
    !/from\("credit_|rpc\("grant_credits/.test(fns),
);

console.log("\n=== 3. purchases are granted once, to the buyer ===");
const claim = read("supabase/functions/design-token-claim/index.ts");
t(
  "claim re-reads the session from Stripe",
  /stripe\.checkout\.sessions\.retrieve\(sessionId\)/.test(claim),
);
t(
  "claim requires complete + paid + design_tokens kind",
  /session\.status === "complete" && session\.payment_status === "paid"/.test(claim) &&
    /DESIGN_TOKENS_KIND/.test(claim),
);
t(
  "claim requires the session to belong to the signed-in user",
  /session\.metadata\?\.user_id !== user\.id/.test(claim),
);
t(
  "claim grants the catalog amount, keyed by the session id",
  /delta: pack\.tokens,\s*reason: "purchase",\s*ref: session\.id/.test(claim),
);
t("a second claim grants nothing (unique violation tolerated)", /23505/.test(claim));
const config = read("supabase/config.toml");
t(
  "token functions keep gateway JWT verification on",
  /\[functions\.design-token-checkout\]\s*\nverify_jwt = true/.test(config) &&
    /\[functions\.design-token-claim\]\s*\nverify_jwt = true/.test(config),
);

console.log("\n=== 4. the engine stays server-side ===");
function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}
const clientFiles = [
  ...walk(join(ROOT, "src/routes")),
  ...walk(join(ROOT, "src/components")),
].filter((f) => /\.tsx?$/.test(f));
t(
  "no route or component imports the engine client directly",
  clientFiles.every(
    (f) => !/magic-designs\/(provider|package)\.server/.test(readFileSync(f, "utf8")),
  ),
);
t(
  "no engine id appears outside the server client",
  clientFiles.every(
    (f) => !/nutacczofe7ear6bsbrwe6|api\.magicpatterns\.com/.test(readFileSync(f, "utf8")),
  ),
);
const provider = read("src/lib/magic-designs/provider.server.ts");
t(
  "the engine key comes only from the Worker secret",
  /process\.env\.MAGIC_PATTERNS_API_KEY/.test(provider) && !/x-mp-api-key":\s*"/.test(provider),
);
t(
  "every base template has an engine design",
  MAGIC_DESIGN_BASES.every((b) => new RegExp(`${b.slug}: "[a-z0-9]+"`).test(provider)),
);
t(
  "every base template has a thumbnail",
  MAGIC_DESIGN_BASES.every((b) =>
    existsSync(join(ROOT, "public/template-thumbnails", `${b.slug}.jpg`)),
  ),
);
const secrets = read("scripts/required-secrets.txt");
t(
  "MAGIC_PATTERNS_API_KEY is in the secrets manifest (recommended)",
  /\[recommended\][\s\S]*MAGIC_PATTERNS_API_KEY/.test(secrets),
);

console.log("\n=== 5. Sharetribe-shaped prompts and handoff ===");
const brief: MagicDesignBrief = {
  marketplaceName: "Pedal Share",
  whatIsListed: "e-bikes",
  providers: "bike shops",
  customers: "tourists",
  transactionType: "booking-hour",
  multipleSeats: true,
  priceVariations: true,
  searchLayout: "map",
  listingLayout: "coverPhoto",
  brandColor: "#22AA88",
  vibe: "bold",
  listingFields: "frame size, motor power, range",
  notes: "",
};
const prompt = buildCreatePrompt(brief, "GearLoop");
t(
  "create prompt names the new marketplace and the base",
  /"Pedal Share"/.test(prompt) && /GearLoop/.test(prompt),
);
t(
  "create prompt states the Sharetribe process and unit type",
  /"default-booking", unit type "hour"/.test(prompt),
);
t(
  "create prompt carries seats, price variations, layouts and fields",
  /multiple seats/.test(prompt) &&
    /price variations/.test(prompt) &&
    /'map' variant/.test(prompt) &&
    /'coverPhoto' variant/.test(prompt) &&
    /frame size, motor power, range/.test(prompt),
);
t(
  "create prompt keeps the template's page structure",
  /EditListingPage/.test(prompt) && /BrowserRouter/.test(prompt),
);
t(
  "every transaction type maps to a process the template supports",
  Object.values(TRANSACTION_TYPES).every((x) =>
    ["default-booking", "default-purchase", "default-inquiry", "default-negotiation"].includes(
      x.process,
    ),
  ),
);
t(
  "every preset produces a prompt that keeps the Sharetribe rules",
  CHANGE_PRESETS.every(
    (p) =>
      buildChangePrompt("", p.key).includes(p.prompt) &&
      /EditListingPage/.test(buildChangePrompt("", p.key)),
  ),
);
t(
  "a free-text change is passed through",
  /make the hero darker/.test(buildChangePrompt("make the hero darker", null)),
);
const setup = buildSharetribeSetup(brief);
t(
  "handoff names the listing type, layout, branding and fields",
  /process: 'default-booking'/.test(setup) &&
    /unitType: 'hour'/.test(setup) &&
    /Search page: \*\*map\*\*/.test(setup) &&
    /#22AA88/.test(setup) &&
    /- motor power/.test(setup),
);
const pkg = read("src/lib/magic-designs/package.server.ts");
t(
  "the download ships SHARETRIBE_SETUP.md, README and LICENSE",
  /SHARETRIBE_SETUP\.md/.test(pkg) && /"README\.md"/.test(pkg) && /"LICENSE\.md"/.test(pkg),
);
t(
  "the download bundles images and fills empty design-system stubs",
  /public\/images\//.test(pkg) && /content\.trim\(\) !== ""/.test(pkg),
);
t(
  "every vendored design-system source is present",
  [
    "Avatar",
    "Checkbox",
    "Dialog",
    "Drawer",
    "Input",
    "Slider",
    "Tabs",
    "Toggle",
    "Separator",
  ].every((n) => existsSync(join(ROOT, "src/lib/magic-designs/ds", `${n}.tsx.txt`))),
);

console.log("\n=== 6. review fixes: fulfilment, refunds, persistence, images ===");
const webhook = read("supabase/functions/stripe-webhook/index.ts");
const completed = webhook.slice(webhook.indexOf('case "checkout.session.completed"'));
t(
  "the Stripe webhook grants design tokens itself (no dependence on the redirect)",
  completed.indexOf("DESIGN_TOKENS_KIND") > -1 &&
    completed.indexOf("grantDesignTokens(admin, s)") <
      completed.indexOf("if (!workspace_id) break;"),
);
const grantFn = webhook.slice(
  webhook.indexOf("async function grantDesignTokens"),
  webhook.indexOf("Which workspace a charge belongs to"),
);
t(
  "the webhook grant is the same idempotent ledger row as the claim",
  /delta: pack\.tokens,\s*reason: "purchase",\s*ref: s\.id/.test(grantFn) &&
    /23505/.test(grantFn) &&
    /throw error/.test(grantFn),
);
t("the webhook grants only paid sessions", /payment_status !== "paid"\) return;/.test(grantFn));
const { designTokenGrantAllowed } = await import("../supabase/functions/_shared/design-tokens");
const U = "11111111-2222-3333-4444-555555555555";
t("live sessions always grant", designTokenGrantAllowed(true, U, undefined));
t(
  "test sessions grant nobody by default",
  !designTokenGrantAllowed(false, U, undefined) && !designTokenGrantAllowed(false, U, ""),
);
t(
  "test sessions grant only allow-listed test users",
  designTokenGrantAllowed(false, U, ` other , ${U.toUpperCase()} `),
);
t(
  "webhook and claim both apply the test-mode rule",
  /designTokenGrantAllowed\(s\.livemode/.test(grantFn) &&
    /designTokenGrantAllowed\(\s*session\.livemode/.test(claim),
);
const refundFn = fns.slice(
  fns.indexOf("async function refund("),
  fns.indexOf("function engineFailure("),
);
t(
  "a refund that cannot be written is never reported as done",
  /attempt <= 2/.test(refundFn) &&
    /throw new CustomerFacingError/.test(refundFn) &&
    /quote reference \$\{ref\}/.test(refundFn),
);
t(
  "create: the design row exists before tokens are spent or the engine starts",
  createBlock.indexOf('from("magic_designs").insert(') < createBlock.indexOf("await spend(") &&
    createBlock.indexOf("await spend(") < createBlock.indexOf("createEngineDesign("),
);
t(
  "create: a failed engine start marks the row failed and refunds",
  /await markFailed\(\);\s*await refund\(context\.userId, cost, id\);/.test(createBlock),
);
t(
  "create: the engine link is retried and never silently lost",
  /attempt <= 3 && !linked/.test(createBlock) && /if \(!linked\)/.test(createBlock),
);
t(
  "download: only images that were bundled are rewritten to local paths",
  /const allBundled = imageIds\.size === bundled\.size;/.test(pkg) &&
    /localizeImages\(raw\)/.test(pkg) &&
    !/\.split\(CDN\)\s*\.join\("\/images\/"\)\s*\.replace/.test(pkg),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed:");
  for (const f of failed) console.log(`  ${f}`);
  process.exit(1);
}
