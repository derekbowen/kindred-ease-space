/**
 * THE AFFILIATE ADD-ON NEEDS THE INTEGRATION API CONNECTION.
 * Run: bun --preload ./tests/_preload/deno-edge-function.ts tests/affiliate-integration-requirement.test.ts
 *
 * Round-4 release review M1. Referral tracking reads transactions through
 * Sharetribe's Integration API; the read-only Marketplace API connection —
 * the launch default — cannot, so on it the add-on tracks nothing. It was
 * still trialled and sold there, and "Run sync now" answered "try again in a
 * few minutes" forever. Now:
 *   - startAffiliateTrial refuses unless the connection is the Integration API;
 *   - create-checkout refuses every affiliate tier the same way, before any
 *     Stripe object exists (driven here offline, with recording fakes);
 *   - the sync says what to do instead of secret_decrypt_failed;
 *   - the Add-ons card, /app/affiliates, the homepage card and /beta say so.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

process.env.SUPABASE_URL = "http://affiliate-req.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";

const req = await import("../src/lib/affiliate-requirements");
const reqServer = await import("../src/lib/affiliate-requirements.server");
const edgeReq = await import("../supabase/functions/_shared/affiliate-requirement.ts");
const { runAffiliateReferralSync } = await import("../src/lib/affiliate-sync.server");
const { userMessage, isCustomerSentence } = await import("../src/lib/user-message");
const { edgeFunctionError } = await import("../src/lib/edge-function-error");

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
const errOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};
const WS = "11111111-1111-4111-8111-111111111111";

// ---------------------------------------------------------------------------
console.log("\nthe sentences");

const RECONNECT =
  "Referral tracking needs the Integration API connection. Reconnect under Settings → Sharetribe → Integration API (Advanced).";
t(
  "the marketplace-mode sentence is the one the release review asked for",
  req.AFFILIATE_RECONNECT_MESSAGE === RECONNECT,
);
for (const [name, s] of [
  ["reconnect", req.AFFILIATE_RECONNECT_MESSAGE],
  ["connect", req.AFFILIATE_CONNECT_MESSAGE],
] as const) {
  t(
    `${name}: a customer sentence (userMessage shows it as is)`,
    isCustomerSentence(s) && userMessage(new Error(s), "fallback") === s,
  );
}
t(
  "the edge function uses the very same sentences",
  edgeReq.AFFILIATE_RECONNECT_MESSAGE === req.AFFILIATE_RECONNECT_MESSAGE &&
    edgeReq.AFFILIATE_CONNECT_MESSAGE === req.AFFILIATE_CONNECT_MESSAGE,
);
t(
  "an old row with no auth_mode is an Integration API connection",
  req.connectionModeOf({ auth_mode: null }) === "integration" &&
    req.connectionModeOf({}) === "integration",
);
t(
  "marketplace mode → the reconnect sentence",
  req.affiliateConnectionProblem(req.connectionModeOf({ auth_mode: "marketplace" })) ===
    req.AFFILIATE_RECONNECT_MESSAGE,
);
t(
  "no connection → the connect sentence",
  req.affiliateConnectionProblem(req.connectionModeOf(null)) === req.AFFILIATE_CONNECT_MESSAGE,
);
t(
  "Integration API → no problem",
  req.affiliateConnectionProblem(req.connectionModeOf({ auth_mode: "integration" })) === null,
);
t(
  "the edge rule agrees on every connection",
  [null, { auth_mode: "marketplace" }, { auth_mode: "integration" }, { auth_mode: null }].every(
    (row) =>
      edgeReq.affiliateConnectionRefusal(row) ===
      req.affiliateConnectionProblem(req.connectionModeOf(row)),
  ),
);
t(
  "every affiliate tier is an affiliate key; DM Champ is not",
  ["affiliate-lite", "affiliate-standard", "affiliate-pro"].every(edgeReq.isAffiliateAddonKey) &&
    !edgeReq.isAffiliateAddonKey("dmchamp"),
);

// ---------------------------------------------------------------------------
// A fake PostgREST for the Worker side.
type Hit = { path: string; query: URLSearchParams };
const hits: Hit[] = [];
let integrationRow: Record<string, unknown> | null = null;
let integrationError = false;
let secret: string | null = null;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  if (url.origin !== process.env.SUPABASE_URL) throw new TypeError(`unexpected host ${url.host}`);
  const path = url.pathname.replace(/^\/rest\/v1\//, "");
  hits.push({ path, query: url.searchParams });
  if (path === "tenant_integrations") {
    if (integrationError) return Response.json({ code: "XX000", message: "boom" }, { status: 500 });
    return Response.json(
      integrationRow ? [{ id: "int-1", client_id: "client-1", ...integrationRow }] : [],
    );
  }
  if (path === "workspace_affiliate_settings")
    return Response.json([{ referrer_param: "referrerID" }]);
  if (path === "rpc/tenant_get_integration_secret") return Response.json(secret);
  return Response.json([]);
}) as typeof fetch;

console.log("\nthe trial's server gate (assertAffiliateConnection)");
integrationRow = { auth_mode: "integration" };
t(
  "Integration API connection → the trial may start",
  (await errOf(reqServer.assertAffiliateConnection(WS))) === null,
);
const read1 = hits.find((h) => h.path === "tenant_integrations");
t(
  "…read fresh for this workspace's Sharetribe row",
  !!read1 &&
    read1.query.get("workspace_id") === `eq.${WS}` &&
    read1.query.get("provider") === "eq.sharetribe",
);
integrationRow = { auth_mode: "marketplace" };
t(
  "Marketplace API connection → refused with the reconnect sentence",
  (await errOf(reqServer.assertAffiliateConnection(WS))) === req.AFFILIATE_RECONNECT_MESSAGE,
);
integrationRow = null;
t(
  "no connection → refused with the connect sentence",
  (await errOf(reqServer.assertAffiliateConnection(WS))) === req.AFFILIATE_CONNECT_MESSAGE,
);
integrationRow = { auth_mode: null };
t(
  "a pre-auth_mode row → allowed (it is an Integration API connection)",
  (await errOf(reqServer.assertAffiliateConnection(WS))) === null,
);
integrationError = true;
const unreadable = await errOf(reqServer.assertAffiliateConnection(WS));
integrationError = false;
t(
  "an unreadable connection → refused (fails closed), in a customer sentence",
  !!unreadable && isCustomerSentence(unreadable),
  String(unreadable),
);

console.log("\nthe referral sync says what to do instead of secret_decrypt_failed");
hits.length = 0;
integrationRow = { auth_mode: "marketplace" };
t(
  "marketplace mode → the reconnect sentence",
  (await errOf(runAffiliateReferralSync(WS))) === req.AFFILIATE_RECONNECT_MESSAGE,
);
t(
  "…without even asking Vault for a secret it cannot have",
  !hits.some((h) => h.path === "rpc/tenant_get_integration_secret"),
);
integrationRow = null;
t(
  "no connection → the connect sentence",
  (await errOf(runAffiliateReferralSync(WS))) === req.AFFILIATE_CONNECT_MESSAGE,
);
integrationRow = { auth_mode: "integration" };
secret = null;
t(
  "Integration API with no stored secret → still secret_decrypt_failed (unchanged)",
  (await errOf(runAffiliateReferralSync(WS))) === "secret_decrypt_failed",
);
const settingsPage = read("src/routes/_authenticated/app.affiliates.settings.tsx");
t(
  "the settings page shows the sync's error through userMessage (so the sentence reaches the owner)",
  /toast\.error\(userMessage\(r\.error, AFFILIATE_SYNC_FAILED\)\)/.test(settingsPage) &&
    userMessage(req.AFFILIATE_RECONNECT_MESSAGE, "fallback") === req.AFFILIATE_RECONNECT_MESSAGE,
);

console.log("\nstartAffiliateTrial enforces it on the server");
const aff = read("src/lib/affiliates.functions.ts");
const trial = aff.slice(
  aff.indexOf("export const startAffiliateTrial"),
  aff.indexOf("// ---------------------------------------------------------------- programs"),
);
const ownerAt = trial.indexOf("await assertWorkspaceOwner(data.workspaceId, context.userId);");
const gateAt = trial.indexOf("await assertAffiliateConnection(data.workspaceId);");
const updateAt = trial.indexOf('.update({ addon_status: "trialing"');
t(
  "owner check → connection gate → trial start, in that order",
  ownerAt > 0 && gateAt > ownerAt && updateAt > gateAt,
  `${ownerAt}/${gateAt}/${updateAt}`,
);
t(
  "the gate is the shared server rule",
  /await import\("@\/lib\/affiliate-requirements\.server"\)/.test(trial),
);

// ---------------------------------------------------------------------------
console.log("\ncreate-checkout refuses every affiliate tier on the wrong connection");

type Filters = Array<[string, string, unknown]>;
const g = globalThis as unknown as {
  __edgeHandler: (req: Request) => Promise<Response>;
  __edgeEnv: Record<string, string | undefined>;
  __ck: {
    stripeCalls: string[];
    user: { id: string; email: string } | null;
    role: string;
    integration: { data: unknown; error: unknown };
    tableCalls: Array<{ table: string; op: string; filters: Filters }>;
  };
};
g.__ck = {
  stripeCalls: [],
  user: { id: "user-1", email: "owner@example.test" },
  role: "owner",
  integration: { data: null, error: null },
  tableCalls: [],
};
mkdirSync(join(ROOT, "tests/_build"), { recursive: true });
const stripeFake = join(ROOT, "tests/_build/checkout-stripe.fake.ts");
writeFileSync(
  stripeFake,
  `const ck = () => (globalThis as any).__ck;
const rec = (name: string, out: unknown) => async (..._a: unknown[]) => { ck().stripeCalls.push(name); return out; };
export default class Stripe {
  customers = { create: rec("customers.create", { id: "cus_new" }), retrieve: rec("customers.retrieve", { id: "cus_1" }) };
  products = { list: rec("products.list", { data: [] }), create: rec("products.create", { id: "prod_1", tax_code: "txcd_10103001", metadata: {} }), update: rec("products.update", { id: "prod_1" }) };
  prices = { list: rec("prices.list", { data: [] }), create: rec("prices.create", { id: "price_1", metadata: { addon_tier: "standard" } }) };
  subscriptions = { list: rec("subscriptions.list", { data: [] }) };
  checkout = { sessions: { create: rec("checkout.sessions.create", { url: "https://checkout.stripe.test/s" }) } };
  constructor(..._a: unknown[]) {}
}
`,
);
const sbFake = join(ROOT, "tests/_build/checkout-supabase.fake.ts");
writeFileSync(
  sbFake,
  `const ck = () => (globalThis as any).__ck;
class Q {
  filters: Array<[string, string, unknown]> = [];
  op = "select";
  constructor(public table: string) {}
  select(c?: string) { this.filters.push(["select", "cols", c]); return this; }
  eq(c: string, v: unknown) { this.filters.push(["eq", c, v]); return this; }
  in(c: string, v: unknown) { this.filters.push(["in", c, v]); return this; }
  limit(n: number) { this.filters.push(["limit", "n", n]); return this; }
  upsert(p: unknown) { this.op = "upsert"; return this; }
  maybeSingle() { return this; }
  then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
    ck().tableCalls.push({ table: this.table, op: this.op, filters: this.filters });
    let out: unknown = { data: null, error: null };
    if (this.table === "workspace_members") out = { data: { workspace_id: "ws", role: ck().role }, error: null };
    if (this.table === "tenant_integrations") out = ck().integration;
    if (this.table === "stripe_customers" && this.op === "select") out = { data: { stripe_customer_id: "cus_1" }, error: null };
    return Promise.resolve(out).then(res, rej);
  }
}
export function createClient(..._a: unknown[]) {
  return { auth: { getUser: async () => ({ data: { user: ck().user } }) }, from: (t: string) => new Q(t) };
}
`,
);
const checkoutSrc = read("supabase/functions/create-checkout/index.ts");
const rewrites: Array<[RegExp, string]> = [
  [/from "https:\/\/esm\.sh\/stripe@[^"]+"/, `from "${stripeFake}"`],
  [/from "https:\/\/esm\.sh\/@supabase\/supabase-js@[^"]+"/, `from "${sbFake}"`],
  [
    /from "\.\.\/_shared\/stripe-catalog\.ts"/,
    `from "${join(ROOT, "supabase/functions/_shared/stripe-catalog.ts")}"`,
  ],
  [
    /from "\.\.\/_shared\/affiliate-requirement\.ts"/,
    `from "${join(ROOT, "supabase/functions/_shared/affiliate-requirement.ts")}"`,
  ],
];
let built = checkoutSrc;
for (const [re, to] of rewrites) {
  t(`create-checkout import rewritten: ${re.source.slice(6, 46)}`, re.test(built));
  built = built.replace(re, to);
}
const builtPath = join(ROOT, "tests/_build/create-checkout.offline.ts");
writeFileSync(builtPath, built);
Object.assign(g.__edgeEnv, {
  STRIPE_SECRET_KEY: "sk_test_placeholder",
  SUPABASE_URL: "http://supabase.invalid",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
});
await import(builtPath);
const checkout = g.__edgeHandler;
t("create-checkout registered its handler", typeof checkout === "function");

async function buy(
  addonKey: string,
  integration: { data: unknown; error: unknown },
  role = "owner",
) {
  g.__ck.stripeCalls = [];
  g.__ck.tableCalls = [];
  g.__ck.role = role;
  g.__ck.integration = integration;
  const res = await checkout(
    new Request("http://fn.test/create-checkout", {
      method: "POST",
      headers: {
        Authorization: "Bearer user-jwt",
        "content-type": "application/json",
        origin: "https://www.founders.click",
      },
      body: JSON.stringify({ workspace_id: WS, mode: "addon", addon_key: addonKey }),
    }),
  );
  const body = (await res.json().catch(() => null)) as {
    error?: string;
    message?: string;
    url?: string;
  } | null;
  return {
    status: res.status,
    body,
    stripe: [...g.__ck.stripeCalls],
    tables: [...g.__ck.tableCalls],
  };
}
const MARKETPLACE = { data: { auth_mode: "marketplace" }, error: null };
const INTEGRATION = { data: { auth_mode: "integration" }, error: null };
const NONE = { data: null, error: null };

for (const key of ["affiliate-lite", "affiliate-standard", "affiliate-pro"]) {
  const r = await buy(key, MARKETPLACE);
  t(
    `${key} on the Marketplace API → 409 with the reconnect sentence, no Stripe call`,
    r.status === 409 &&
      r.body?.error === "integration_api_required" &&
      r.body?.message === req.AFFILIATE_RECONNECT_MESSAGE &&
      r.stripe.length === 0,
    `${r.status} ${JSON.stringify(r.body)} ${r.stripe.join(",")}`,
  );
}
const none = await buy("affiliate-standard", NONE);
t(
  "affiliate-standard with no connection → 409 with the connect sentence",
  none.status === 409 &&
    none.body?.message === req.AFFILIATE_CONNECT_MESSAGE &&
    none.stripe.length === 0,
);
const broken = await buy("affiliate-standard", { data: null, error: { message: "boom" } });
t(
  "an unreadable connection → 503 in a customer sentence, no Stripe call (fails closed)",
  broken.status === 503 &&
    isCustomerSentence(String(broken.body?.message)) &&
    broken.stripe.length === 0,
  `${broken.status} ${JSON.stringify(broken.body)}`,
);
const ok = await buy("affiliate-standard", INTEGRATION);
t(
  "affiliate-standard on the Integration API → checkout proceeds to Stripe",
  ok.status === 200 &&
    ok.body?.url === "https://checkout.stripe.test/s" &&
    ok.stripe.includes("checkout.sessions.create"),
  `${ok.status} ${JSON.stringify(ok.body)}`,
);
const gateRead = ok.tables.find((c) => c.table === "tenant_integrations");
t(
  "…after reading this workspace's Sharetribe row",
  !!gateRead &&
    gateRead.filters.some(([op, c, v]) => op === "eq" && c === "workspace_id" && v === WS) &&
    gateRead.filters.some(([op, c, v]) => op === "eq" && c === "provider" && v === "sharetribe"),
);
const dm = await buy("dmchamp", MARKETPLACE);
t(
  "DM Champ is not gated by the Sharetribe connection",
  dm.status === 200 && !dm.tables.some((c) => c.table === "tenant_integrations"),
);
const member = await buy("affiliate-standard", MARKETPLACE, "member");
t(
  "a non-owner is refused as before, before the connection is read",
  member.status === 403 && !member.tables.some((c) => c.table === "tenant_integrations"),
);

console.log("\nthe refusal's sentence reaches the customer");
const httpError = Object.assign(new Error("Edge Function returned a non-2xx status code"), {
  context: new Response(
    JSON.stringify({ error: "integration_api_required", message: req.AFFILIATE_RECONNECT_MESSAGE }),
    { status: 409 },
  ),
});
t(
  "without help, userMessage hides the transport text (the old behaviour)",
  userMessage(httpError, "fallback") === "fallback",
);
t(
  "edgeFunctionError surfaces the body's sentence",
  userMessage(await edgeFunctionError(httpError), "fallback") === req.AFFILIATE_RECONNECT_MESSAGE,
);
const noBody = Object.assign(new Error("Edge Function returned a non-2xx status code"), {
  context: new Response("oops", { status: 500 }),
});
t("a non-JSON body falls back to the original error", (await edgeFunctionError(noBody)) === noBody);
const addonsPage = read("src/routes/_authenticated/app.addons.tsx");
t(
  "the Add-ons checkout uses it",
  /if \(error\) throw await edgeFunctionError\(error\);/.test(addonsPage),
);
t(
  "so does the billing checkout",
  /if \(error\) throw await edgeFunctionError\(error\);/.test(
    read("src/routes/_authenticated/app.billing.tsx"),
  ),
);

// ---------------------------------------------------------------------------
console.log("\nevery surface that sells it says so");
const addons = read("src/lib/addons.functions.ts");
t(
  "the Add-ons catalogue states the requirement",
  /requires: AFFILIATE_REQUIREMENT_NOTE,/.test(addons),
);
t(
  "getAddons computes the blocked reason on the server from the connection",
  /affiliateConnectionProblem\(\s*await readSharetribeConnectionMode\(data\.workspaceId\),?\s*\)/.test(
    addons,
  ) && /blockedReason: a\.key === "affiliate-standard" \? affiliateBlocked : null,/.test(addons),
);
t(
  "the Add-ons card shows the requirement, the problem and a link, and disables the purchase",
  /\{a\.requires && \(/.test(addonsPage) &&
    /\{blocked && \(/.test(addonsPage) &&
    /to=\{SHARETRIBE_SETTINGS_PATH\}/.test(addonsPage) &&
    /disabled=\{busy === a\.key \|\| !!blocked\}/.test(addonsPage) &&
    /\{isAffiliate && !blocked && \(/.test(addonsPage),
);
const dash = read("src/routes/_authenticated/app.affiliates.tsx");
t(
  "/app/affiliates reads the requirement from the server and blocks the trial button",
  /getAffiliateRequirement\(\{ data: \{ workspaceId: workspaceId! \} \}\)/.test(dash) &&
    /disabled=\{starting \|\| !!connectionProblem\}/.test(dash),
);
t(
  "/app/affiliates states the requirement and warns an active add-on too",
  /\{AFFILIATE_REQUIREMENT_NOTE\}/.test(dash) &&
    (dash.match(/<ConnectionRequirement problem=\{connectionProblem\} \/>/g) ?? []).length === 2,
);
t("the affiliate settings page states it", /\{AFFILIATE_REQUIREMENT_NOTE\}/.test(settingsPage));
t(
  "the requirement note is a customer sentence about the Integration API",
  /Integration API/.test(req.AFFILIATE_REQUIREMENT_NOTE) &&
    isCustomerSentence(req.AFFILIATE_REQUIREMENT_NOTE),
);
t(
  "the homepage card says it needs the Integration API",
  /Available as an add-on, priced separately; it needs your marketplace connected through Sharetribe's Integration API\./.test(
    read("src/routes/index.tsx"),
  ),
);
t(
  "/beta says it",
  /Affiliate Programs tracks referrals through Sharetribe&apos;s Integration API/.test(
    read("src/routes/beta.tsx"),
  ),
);
const fns = read("src/lib/affiliate-requirements.functions.ts");
t(
  "the requirement endpoint is member-only",
  /await assertWorkspaceMember\(data\.workspaceId, context\.userId\);/.test(fns) &&
    /requireSupabaseAuth/.test(fns),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
