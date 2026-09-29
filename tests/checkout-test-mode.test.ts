/**
 * STRIPE TEST-MODE CHECKOUT IS FENCED. Run:
 *   bun --preload ./tests/_preload/deno-edge-function.ts tests/checkout-test-mode.test.ts
 *
 * create-checkout is deployed twice from one source, like the webhook:
 * `create-checkout` (live key) and `create-checkout-test` (STRIPE_SECRET_KEY_TEST).
 * The deployment name alone picks the key. The test deployment writes
 * stripe_customers like the live one, so it must refuse every workspace that
 * is not in STRIPE_TEST_WORKSPACE_IDS before any read, write or Stripe call:
 * a test customer id in a real workspace's row would break its live billing.
 * The live deployment must never read that allowlist.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
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

type Filters = Array<[string, string, unknown]>;
const g = globalThis as unknown as {
  __edgeHandler: (req: Request) => Promise<Response>;
  __edgeEnv: Record<string, string | undefined>;
  __ck: {
    keys: string[];
    stripeCalls: string[];
    tableCalls: Array<{ table: string; op: string; filters: Filters }>;
  };
};
g.__ck = { keys: [], stripeCalls: [], tableCalls: [] };

mkdirSync(join(ROOT, "tests/_build"), { recursive: true });
const stripeFake = join(ROOT, "tests/_build/checkout-mode-stripe.fake.ts");
writeFileSync(
  stripeFake,
  `const ck = () => (globalThis as any).__ck;
const rec = (name: string, out: unknown) => async (..._a: unknown[]) => { ck().stripeCalls.push(name); return out; };
export default class Stripe {
  customers = { create: rec("customers.create", { id: "cus_new" }), retrieve: rec("customers.retrieve", { id: "cus_1" }) };
  products = { list: rec("products.list", { data: [] }), create: rec("products.create", { id: "prod_1", tax_code: "txcd_10103001", metadata: {} }), update: rec("products.update", { id: "prod_1" }) };
  prices = { list: rec("prices.list", { data: [] }), create: rec("prices.create", { id: "price_1", metadata: { plan_tier: "starter" } }) };
  subscriptions = { list: rec("subscriptions.list", { data: [] }) };
  checkout = { sessions: { create: rec("checkout.sessions.create", { url: "https://checkout.stripe.test/s" }) } };
  constructor(key: string) { ck().keys.push(String(key)); }
}
`,
);
const sbFake = join(ROOT, "tests/_build/checkout-mode-supabase.fake.ts");
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
  upsert(_p: unknown) { this.op = "upsert"; return this; }
  maybeSingle() { return this; }
  then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
    ck().tableCalls.push({ table: this.table, op: this.op, filters: this.filters });
    let out: unknown = { data: null, error: null };
    if (this.table === "workspace_members") out = { data: { workspace_id: "ws", role: "owner" }, error: null };
    if (this.table === "stripe_customers" && this.op === "select") out = { data: { stripe_customer_id: "cus_1" }, error: null };
    return Promise.resolve(out).then(res, rej);
  }
}
export function createClient(..._a: unknown[]) {
  return { auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "owner@example.test" } } }) }, from: (t: string) => new Q(t) };
}
`,
);

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
let built = readFileSync(join(ROOT, "supabase/functions/create-checkout/index.ts"), "utf8");
for (const [re, to] of rewrites) {
  t(`create-checkout import rewritten: ${re.source.slice(6, 46)}`, re.test(built));
  built = built.replace(re, to);
}
const builtPath = join(ROOT, "tests/_build/checkout-test-mode.offline.ts");
writeFileSync(builtPath, built);
Object.assign(g.__edgeEnv, {
  STRIPE_SECRET_KEY: "sk_live_placeholder",
  STRIPE_SECRET_KEY_TEST: "sk_test_placeholder",
  SUPABASE_URL: "http://supabase.invalid",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
});
const mod = (await import(builtPath)) as {
  checkoutModeFor: (url: string) => { test: boolean; keyName: string };
  testModeWorkspaceAllowed: (raw: string | null | undefined, ws: string) => boolean;
};
const checkout = g.__edgeHandler;
t("create-checkout registered its handler", typeof checkout === "function");

const WS = "f02d1aa9-4e72-40fc-859f-dfecbba34a87";
const OTHER = "509e5a42-7eb9-4bdb-8b6c-981a15b69dce";
const FN = "https://xbxhzinnfhosoztqaaao.supabase.co/functions/v1";

console.log("\n=== the deployment name picks the key ===");
for (const [url, test] of [
  [`${FN}/create-checkout`, false],
  [`${FN}/create-checkout-test`, true],
  [`${FN}/create-checkout/create-checkout-test`, false],
  [`${FN}/create-checkout-testx`, false],
  [`${FN}/create-checkout?x=create-checkout-test`, false],
  ["http://localhost:54321/create-checkout-test", true],
] as const) {
  const m = mod.checkoutModeFor(url);
  t(
    `${url.replace(FN, "")} → ${test ? "test" : "live"}`,
    m.test === test && m.keyName === (test ? "STRIPE_SECRET_KEY_TEST" : "STRIPE_SECRET_KEY"),
    JSON.stringify(m),
  );
}

console.log("\n=== the allowlist ===");
t("unset refuses", !mod.testModeWorkspaceAllowed(undefined, WS));
t("empty refuses", !mod.testModeWorkspaceAllowed("", WS));
t("another workspace's id refuses", !mod.testModeWorkspaceAllowed(OTHER, WS));
t(
  "listed (any case, spaces) allows",
  mod.testModeWorkspaceAllowed(` ${OTHER.toUpperCase()} , ${WS.toUpperCase()} `, WS),
);
t("a non-UUID entry never matches loosely", !mod.testModeWorkspaceAllowed("f02d1aa9*", WS));

async function buy(path: string, workspaceId: string) {
  g.__ck.keys = [];
  g.__ck.stripeCalls = [];
  g.__ck.tableCalls = [];
  const res = await checkout(
    new Request(`${FN}/${path}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer user-jwt",
        "content-type": "application/json",
        origin: "https://www.founders.click",
      },
      body: JSON.stringify({ workspace_id: workspaceId, mode: "subscription", tier: "starter" }),
    }),
  );
  const body = (await res.json().catch(() => null)) as { error?: string; url?: string } | null;
  return {
    status: res.status,
    body,
    keys: [...g.__ck.keys],
    stripe: [...g.__ck.stripeCalls],
    tables: [...g.__ck.tableCalls],
  };
}

console.log("\n=== create-checkout-test ===");
delete g.__edgeEnv.STRIPE_TEST_WORKSPACE_IDS;
{
  const r = await buy("create-checkout-test", WS);
  t(
    "allowlist unset → 403 before any read, write or Stripe call",
    r.status === 403 &&
      r.body?.error === "test_mode_workspace_refused" &&
      r.tables.length === 0 &&
      r.stripe.length === 0,
    `${r.status} ${JSON.stringify(r.body)} ${r.tables.map((c) => c.table)} ${r.stripe}`,
  );
}
g.__edgeEnv.STRIPE_TEST_WORKSPACE_IDS = WS;
{
  const r = await buy("create-checkout-test", OTHER);
  t(
    "a workspace outside the allowlist → 403, nothing read or written, no Stripe call",
    r.status === 403 &&
      r.body?.error === "test_mode_workspace_refused" &&
      r.tables.length === 0 &&
      r.stripe.length === 0,
    `${r.status} ${JSON.stringify(r.body)} ${r.tables.map((c) => c.table)} ${r.stripe}`,
  );
}
{
  const r = await buy("create-checkout-test", WS);
  t(
    "the allowlisted workspace gets a test-mode session, built with the TEST key only",
    r.status === 200 &&
      r.body?.url === "https://checkout.stripe.test/s" &&
      r.keys.length === 1 &&
      r.keys[0] === "sk_test_placeholder" &&
      r.stripe.includes("checkout.sessions.create"),
    `${r.status} ${JSON.stringify(r.body)} keys=${r.keys} ${r.stripe}`,
  );
}

console.log("\n=== create-checkout (live) ===");
delete g.__edgeEnv.STRIPE_TEST_WORKSPACE_IDS;
{
  const r = await buy("create-checkout", OTHER);
  t(
    "live ignores the allowlist entirely and uses the LIVE key",
    r.status === 200 && r.keys.length === 1 && r.keys[0] === "sk_live_placeholder",
    `${r.status} ${JSON.stringify(r.body)} keys=${r.keys}`,
  );
}
{
  const r = await buy("create-checkout/create-checkout-test", OTHER);
  t(
    "a sub-path of the live function stays live (cannot be steered onto the test key)",
    r.status === 200 && r.keys[0] === "sk_live_placeholder",
    `${r.status} keys=${r.keys}`,
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) console.log("FAILED:\n  " + failed.join("\n  ") + "\n");
process.exit(fail ? 1 : 0);
