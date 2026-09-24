/**
 * STRIPE WEBHOOK, OFFLINE. Run:
 *   bun --preload ./tests/_preload/deno-edge-function.ts tests/stripe-webhook.test.ts
 *
 * Drives supabase/functions/stripe-webhook/index.ts through its Deno.serve
 * handler with REAL Stripe signatures (the stripe npm package signs and the
 * function verifies) and a recording fake of the service-role client. Pins:
 * signature verification, replay outside the tolerance window, duplicate-event
 * idempotency, reclaim of a crashed attempt, failed-payment grace, suspension
 * on cancel/unpaid, the fail-loud paths (500 keeps Stripe retrying), and the
 * test-mode deployment: mode chosen by the function-name path segment, writes
 * only for a workspace flagged is_internal, nothing else touched otherwise.
 */
import Stripe from "stripe";

let pass = 0, fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL  ${name}  ${extra}`); }
}

type Call = { table: string; op: string; payload?: any; filters: Array<[string, string, unknown]> };
const g = globalThis as unknown as {
  __edgeHandler: (req: Request) => Promise<Response>;
  __edgeEnv: Record<string, string | undefined>;
  __sbCalls: Call[];
  __sbResponses: Record<string, Array<{ data?: unknown; error?: { code?: string; message: string } | null; count?: number | null }>>;
  __sbRpc: Record<string, (args: unknown) => unknown>;
  __stripeStubs: Record<string, (...a: unknown[]) => unknown>;
  __stripeCalls: string[];
};

const SECRET = "whsec_test_" + "a".repeat(32);
g.__edgeEnv.STRIPE_SECRET_KEY = "sk_test_placeholder";
g.__edgeEnv.STRIPE_WEBHOOK_SECRET = SECRET;
const TEST_SECRET = "whsec_testmode_" + "c".repeat(32);
g.__edgeEnv.STRIPE_SECRET_KEY_TEST = "sk_test_placeholder_testmode";
g.__edgeEnv.STRIPE_WEBHOOK_SECRET_TEST = TEST_SECRET;
g.__edgeEnv.SUPABASE_URL = "http://supabase.invalid";
g.__edgeEnv.SUPABASE_SERVICE_ROLE_KEY = "service-role-placeholder";

// Bun cannot load the function's esm.sh imports, so the source is rewritten
// onto the installed SDK and the local fakes. Each rewrite is asserted, so a
// changed import line fails the suite instead of silently testing nothing.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const ROOT = join(import.meta.dir, "..");
const original = readFileSync(join(ROOT, "supabase/functions/stripe-webhook/index.ts"), "utf8");
const rewrites: Array<[RegExp, string]> = [
  [/from "https:\/\/esm\.sh\/stripe@[^"]+"/, `from "${join(ROOT, "tests/_preload/fakes/stripe.ts")}"`],
  [/from "https:\/\/esm\.sh\/@supabase\/supabase-js@[^"]+"/, `from "${join(ROOT, "tests/_preload/fakes/supabase-js.ts")}"`],
  [/from "\.\.\/_shared\/stripe-catalog\.ts"/, `from "${join(ROOT, "supabase/functions/_shared/stripe-catalog.ts")}"`],
];
let src = original;
for (const [re, to] of rewrites) {
  t(`source import rewritten: ${re.source.slice(0, 40)}`, re.test(src));
  src = src.replace(re, to);
}
mkdirSync(join(ROOT, "tests/_build"), { recursive: true });
const built = join(ROOT, "tests/_build/stripe-webhook.offline.ts");
writeFileSync(built, src);
const webhook = (await import(built)) as {
  stripeEnvFor: (url: string) => { test: boolean; apiKey?: string; webhookSecret?: string };
  stripeDeploymentName: (url: string) => string;
  TEST_MODE_WORKSPACE_REFUSED_ERROR: string;
};
const handler = g.__edgeHandler;
t("function registered a Deno.serve handler", typeof handler === "function");

const stripe = new Stripe("sk_test_placeholder", { apiVersion: "2024-06-20" });
function signed(payload: string, opts: { secret?: string; timestamp?: number } = {}) {
  return stripe.webhooks.generateTestHeaderString({
    payload, secret: opts.secret ?? SECRET, ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
  });
}
function reset() {
  g.__sbCalls.length = 0; g.__sbResponses = {}; g.__sbRpc = {}; g.__stripeStubs = {}; g.__stripeCalls.length = 0;
}
async function deliver(event: Record<string, unknown>, headerOverride?: string | null, path = "/stripe-webhook") {
  const body = JSON.stringify(event);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const sig = headerOverride === undefined ? signed(body) : headerOverride;
  if (sig !== null) headers["stripe-signature"] = sig;
  const res = await handler(new Request("http://edge.invalid" + path, { method: "POST", headers, body }));
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
const calls = (table: string, op?: string) => g.__sbCalls.filter((c) => c.table === table && (!op || c.op === op));
const WS = "11111111-1111-4111-8111-111111111111";
function subEvent(id: string, status: string, extra: Record<string, unknown> = {}, type = "customer.subscription.updated") {
  return {
    id, object: "event", type, livemode: true, created: Math.floor(Date.now() / 1000),
    data: { object: {
      id: "sub_1", object: "subscription", status, metadata: { workspace_id: WS, plan_tier: "starter" },
      items: { data: [{ quantity: 1, price: { id: "price_1", unit_amount: 2900 } }] },
      current_period_end: Math.floor(Date.now() / 1000) + 86400, cancel_at_period_end: false, ...extra,
    } },
  };
}

// ---------------------------------------------------------------------------
console.log("\n=== signature verification ===");
reset();
{
  const r = await deliver(subEvent("evt_nosig", "active"), null);
  t("missing stripe-signature -> 400", r.status === 400, String(r.status));
  t("missing signature writes nothing", g.__sbCalls.length === 0, String(g.__sbCalls.length));
}
reset();
{
  const body = JSON.stringify(subEvent("evt_badsig", "active"));
  const r = await deliver(subEvent("evt_badsig", "active"), signed(body, { secret: "whsec_wrong_" + "b".repeat(32) }));
  t("wrong signing secret -> 400", r.status === 400, String(r.status));
  t("wrong secret writes nothing", g.__sbCalls.length === 0);
}
reset();
{
  const ev = subEvent("evt_tampered", "active");
  const header = signed(JSON.stringify(ev));
  (ev.data as any).object.metadata.plan_tier = "scale"; // body altered after signing
  const r = await deliver(ev, header);
  t("tampered body under a valid header -> 400", r.status === 400, String(r.status));
}
reset();
{
  const ev = subEvent("evt_replay", "active");
  const old = Math.floor(Date.now() / 1000) - 3600; // an hour old: outside the 300s default tolerance
  const r = await deliver(ev, signed(JSON.stringify(ev), { timestamp: old }));
  t("replayed delivery with a stale signature timestamp -> 400", r.status === 400, String(r.status));
  t("stale replay writes nothing", g.__sbCalls.length === 0);
}

// ---------------------------------------------------------------------------
console.log("\n=== happy path: subscription active grants capacity ===");
reset();
g.__stripeStubs["subscriptions.retrieve"] = async () => subEvent("x", "active").data.object;
{
  const r = await deliver(subEvent("evt_active_1", "active"));
  t("valid event -> 200 received", r.status === 200 && r.json.received === true, JSON.stringify(r.json));
  const claim = calls("stripe_webhook_events", "insert")[0];
  t("event id claimed BEFORE business work", !!claim && g.__sbCalls.indexOf(claim) === 0 && claim.payload?.stripe_event_id === "evt_active_1");
  t("subscription fetched from Stripe for current state (ordering-safe)", g.__stripeCalls.includes("subscriptions.retrieve"));
  const up = calls("subscriptions", "upsert")[0];
  t("subscriptions upserted on stripe_subscription_id", !!up && up.payload?.stripe_subscription_id === "sub_1" && up.payload?.status === "active");
  const ws = calls("workspaces", "update")[0];
  t("workspace gets plan + page_limit_base while entitled", !!ws && ws.payload?.plan === "starter" && typeof ws.payload?.page_limit_base === "number" && ws.payload.page_limit_base > 0, JSON.stringify(ws?.payload));
  t("billing_events audited with the stripe event id", calls("billing_events", "insert").some((c) => c.payload?.stripe_event_id === "evt_active_1" && c.payload?.event_type === "subscription_updated"));
  const mark = calls("stripe_webhook_events", "update").at(-1);
  t("event marked processed at the end", mark?.payload?.processing_status === "processed", JSON.stringify(mark?.payload));
}

// ---------------------------------------------------------------------------
console.log("\n=== idempotency: duplicate and reclaimed deliveries ===");
reset();
g.__sbResponses["stripe_webhook_events.insert"] = [{ error: { code: "23505", message: "duplicate key" } }];
g.__sbResponses["stripe_webhook_events.select"] = [{ data: { processing_status: "processed" } }];
{
  const r = await deliver(subEvent("evt_dup", "active"));
  t("already-processed event id -> 200 duplicate ack", r.status === 200 && r.json.duplicate === true, JSON.stringify(r.json));
  t("duplicate performs NO business writes", calls("subscriptions").length === 0 && calls("workspaces").length === 0 && calls("billing_events").length === 0);
  t("duplicate does not call Stripe", g.__stripeCalls.length === 0);
}
reset();
g.__sbResponses["stripe_webhook_events.insert"] = [{ error: { code: "23505", message: "duplicate key" } }];
g.__sbResponses["stripe_webhook_events.select"] = [{ data: { processing_status: "error" } }];
g.__stripeStubs["subscriptions.retrieve"] = async () => subEvent("x", "active").data.object;
{
  const r = await deliver(subEvent("evt_reclaim", "active"));
  t("a previously-failed attempt is reprocessed, not skipped", r.status === 200 && r.json.duplicate !== true && calls("subscriptions", "upsert").length === 1);
}
reset();
g.__sbResponses["stripe_webhook_events.insert"] = [{ error: { code: "42P01", message: "relation does not exist" } }];
{
  const r = await deliver(subEvent("evt_nolog", "active"));
  t("event log unavailable -> 500 so Stripe retries (never an unaudited action)", r.status === 500, String(r.status));
  t("no business writes without an audit row", calls("subscriptions").length === 0 && calls("workspaces").length === 0);
}

// ---------------------------------------------------------------------------
console.log("\n=== failed payment: grace, then suspension only when Stripe gives up ===");
reset();
g.__sbResponses["subscriptions.select"] = [{ data: { workspace_id: WS } }];
{
  const ev = { id: "evt_pf", object: "event", type: "invoice.payment_failed", livemode: true, created: Math.floor(Date.now() / 1000),
    data: { object: { id: "in_1", object: "invoice", subscription: "sub_1", attempt_count: 1, next_payment_attempt: 1 } } };
  const r = await deliver(ev);
  t("payment_failed -> 200", r.status === 200);
  t("payment_failed is audited", calls("billing_events", "insert").some((c) => c.payload?.event_type === "payment_failed"));
  t("payment_failed does NOT suspend pages (grace period)", calls("tenant_pages", "update").length === 0);
}
reset();
g.__stripeStubs["subscriptions.retrieve"] = async () => subEvent("x", "past_due").data.object;
{
  const r = await deliver(subEvent("evt_pastdue", "past_due"));
  t("past_due keeps pages online (no suspension)", r.status === 200 && !calls("tenant_pages", "update").some((c) => c.payload?.status === "billing_suspended"));
  t("past_due still records the status on the workspace", calls("workspaces", "update").some((c) => c.payload?.subscription_status === "past_due"));
}
reset();
g.__stripeStubs["subscriptions.retrieve"] = async () => subEvent("x", "unpaid").data.object;
{
  const r = await deliver(subEvent("evt_unpaid", "unpaid"));
  const susp = calls("tenant_pages", "update").find((c) => c.payload?.status === "billing_suspended");
  t("unpaid -> published pages suspended", r.status === 200 && !!susp);
  t("suspension targets only this workspace's published pages", !!susp && susp.filters.some(([f, c, v]) => f === "eq" && c === "workspace_id" && v === WS) && susp.filters.some(([f, c, v]) => f === "eq" && c === "status" && v === "published"));
  t("unpaid does not grant page_limit_base", !calls("workspaces", "update").some((c) => "page_limit_base" in (c.payload ?? {})));
}
reset();
{
  const r = await deliver(subEvent("evt_deleted", "canceled", {}, "customer.subscription.deleted"));
  t("subscription.deleted -> 200", r.status === 200);
  t("subscription.deleted marks subscription canceled", calls("subscriptions", "update").some((c) => c.payload?.status === "canceled"));
  t("subscription.deleted suspends published pages", calls("tenant_pages", "update").some((c) => c.payload?.status === "billing_suspended"));
  t("subscription.deleted audited", calls("billing_events", "insert").some((c) => c.payload?.event_type === "subscription_canceled"));
}
reset();
g.__stripeStubs["subscriptions.retrieve"] = async () => subEvent("x", "active").data.object;
{
  const r = await deliver(subEvent("evt_react", "active"));
  const react = calls("tenant_pages", "update").find((c) => c.payload?.status === "published");
  t("payment restored -> billing_suspended pages reactivated at the same rows", r.status === 200 && !!react && react.filters.some(([f, c, v]) => f === "eq" && c === "status" && v === "billing_suspended"));
}

// ---------------------------------------------------------------------------
console.log("\n=== fail loud: a crash inside a handler is a 500, recorded on the event ===");
reset();
g.__stripeStubs["subscriptions.retrieve"] = async () => subEvent("x", "active").data.object;
g.__sbResponses["subscriptions.upsert"] = [{ error: { code: "XX000", message: "boom" } }];
{
  // upsert errors are not thrown by supabase-js; force a throw via a stub that rejects
  g.__stripeStubs["subscriptions.retrieve"] = async () => { throw new Error("stripe down"); };
  const r = await deliver(subEvent("evt_crash", "active"));
  t("Stripe retrieve failure falls back to the event payload (still 200)", r.status === 200, String(r.status));
}
reset();
g.__sbRpc["grant_credits"] = () => ({ data: null, error: { message: "ledger down" } });
g.__stripeStubs["checkout.sessions.listLineItems"] = async () => ({ data: [{ quantity: 1 }] });
{
  const ev = { id: "evt_credits", object: "event", type: "checkout.session.completed", livemode: true, created: Math.floor(Date.now() / 1000),
    data: { object: { id: "cs_1", object: "checkout.session", metadata: { workspace_id: WS, mode: "credits", credits_per_pack: "1000" }, payment_intent: "pi_1", amount_total: 1000, currency: "usd" } } };
  const r = await deliver(ev);
  t("failed credit grant -> 500 (never ACK a purchase that was not granted)", r.status === 500, String(r.status));
  const mark = calls("stripe_webhook_events", "update").at(-1);
  t("crashed attempt recorded as error on the event row", mark?.payload?.processing_status === "error" && /ledger down/.test(String(mark?.payload?.error)), JSON.stringify(mark?.payload));
}


// ---------------------------------------------------------------------------
console.log("\n=== test-mode deployment: separate secrets, no cross-mode processing ===");
reset();
{
  const ev = { ...subEvent("evt_tm_livesecret", "active"), livemode: false };
  const r = await deliver(ev, signed(JSON.stringify(ev)), "/stripe-webhook-test");
  t("test deployment rejects a payload signed with the LIVE secret -> 400", r.status === 400, String(r.status));
  t("… and writes nothing", g.__sbCalls.length === 0);
}
reset();
g.__stripeStubs["subscriptions.retrieve"] = async () => subEvent("x", "active").data.object;
g.__sbResponses["workspaces.select"] = [{ data: { is_internal: true } }]; // the proof workspace is internal (B1)
{
  const ev = { ...subEvent("evt_tm_ok", "active"), livemode: false };
  const r = await deliver(ev, signed(JSON.stringify(ev), { secret: TEST_SECRET }), "/stripe-webhook-test");
  t("test deployment processes a test-mode event signed with the TEST secret -> 200", r.status === 200 && r.json.received === true, JSON.stringify(r.json));
  t("… recording exactly one event claim", calls("stripe_webhook_events", "insert").length === 1);
  t("… and granting the entitlement", calls("workspaces", "update").some((c) => typeof c.payload?.page_limit_base === "number"));
}
reset();
{
  const ev = { ...subEvent("evt_tm_live_on_test", "active"), livemode: true };
  const r = await deliver(ev, signed(JSON.stringify(ev), { secret: TEST_SECRET }), "/stripe-webhook-test");
  t("a LIVE event reaching the test deployment is acknowledged and ignored", r.status === 200 && r.json.ignored === "mode_mismatch", JSON.stringify(r.json));
  t("… with no writes at all", g.__sbCalls.length === 0);
}
reset();
{
  const ev = { ...subEvent("evt_test_on_live", "active"), livemode: false };
  const r = await deliver(ev);
  t("a TEST event reaching the live deployment is acknowledged and ignored", r.status === 200 && r.json.ignored === "mode_mismatch", JSON.stringify(r.json));
  t("… with no writes at all", g.__sbCalls.length === 0);
}

// ---------------------------------------------------------------------------
console.log("\n=== test-mode deployment: the mode is the function-name segment, never a suffix (B1a) ===");
{
  const mode = (path: string) => webhook.stripeEnvFor("https://ref.supabase.co" + path);
  t("/functions/v1/stripe-webhook-test -> test", mode("/functions/v1/stripe-webhook-test").test === true);
  t("/stripe-webhook-test -> test", mode("/stripe-webhook-test").test === true);
  t("/functions/v1/stripe-webhook -> live", mode("/functions/v1/stripe-webhook").test === false);
  t("/functions/v1/stripe-webhook/stripe-webhook-test -> LIVE (a sub-path cannot steer the live function onto the test secret)",
    mode("/functions/v1/stripe-webhook/stripe-webhook-test").test === false);
  t("/stripe-webhook-test/anything -> test", mode("/stripe-webhook-test/anything").test === true);
  t("/stripe-webhook/stripe-webhook-test -> live", mode("/stripe-webhook/stripe-webhook-test").test === false);
  t("/functions/v1/stripe-webhook-test/ (trailing slash) -> test", mode("/functions/v1/stripe-webhook-test/").test === true);
  t("a name that merely starts with the test name is live", mode("/functions/v1/stripe-webhook-tests").test === false);
  t("the deployment name is the first segment after /functions/v1",
    webhook.stripeDeploymentName("https://ref.supabase.co/functions/v1/stripe-webhook/x") === "stripe-webhook" &&
      webhook.stripeDeploymentName("http://edge.invalid/stripe-webhook-test") === "stripe-webhook-test" &&
      webhook.stripeDeploymentName("https://ref.supabase.co/functions/v1") === "");
  t("test mode selects the _TEST secrets, live the plain ones",
    mode("/functions/v1/stripe-webhook-test").webhookSecret === TEST_SECRET && mode("/functions/v1/stripe-webhook").webhookSecret === SECRET);
  t("stripeEnvFor keeps its shape", Object.keys(mode("/stripe-webhook")).sort().join() === "apiKey,test,webhookSecret");
}

// ---------------------------------------------------------------------------
console.log("\n=== test-mode deployment: writes only for a workspace flagged is_internal (B1b/c) ===");
// The test deployment shares the database and the service role with the live
// one, and every handler takes its workspace id from metadata that anyone with
// test-dashboard access can write. So in test mode a workspace must be
// is_internal = true before the first write for it; otherwise the event is
// acknowledged (Stripe must not retry), the claimed event row says why, and
// nothing else is touched.
const TEST_PATH = "/functions/v1/stripe-webhook-test";
const testSigned = (ev: Record<string, unknown>) => signed(JSON.stringify(ev), { secret: TEST_SECRET });
const WRITE_OPS = new Set(["insert", "update", "upsert", "delete", "rpc"]);
// Every write a handler makes for a workspace; the event log is the only table
// a refused event may touch.
const writes = () => g.__sbCalls.filter((c) => WRITE_OPS.has(c.op) && c.table !== "stripe_webhook_events");
const writeNames = () => JSON.stringify(writes().map((c) => `${c.table}.${c.op}`));
const isInternalRead = (c: Call) =>
  c.table === "workspaces" && c.op === "select" && c.filters.some(([f, col, v]) => f === "select" && col === "cols" && v === "is_internal");
const refusedRow = () => {
  const m = calls("stripe_webhook_events", "update").at(-1);
  return m?.payload?.processing_status === "error" && m?.payload?.error === "test mode: workspace is not internal; no changes made";
};
t("the refusal text is exported for the audit row", webhook.TEST_MODE_WORKSPACE_REFUSED_ERROR === "test mode: workspace is not internal; no changes made");

reset();
g.__stripeStubs["subscriptions.retrieve"] = async () => subEvent("x", "active").data.object;
{
  // Nothing queued for workspaces.select: the fake answers {data:null} — not internal.
  const ev = { ...subEvent("evt_tm_notint_sub", "active"), livemode: false };
  const r = await deliver(ev, testSigned(ev), TEST_PATH);
  t("subscription.updated for a non-internal workspace -> 200 ignored: workspace_not_internal",
    r.status === 200 && r.json.received === true && r.json.ignored === "workspace_not_internal", JSON.stringify(r.json));
  t("… the event row was claimed, then marked error with the refusal text",
    calls("stripe_webhook_events", "insert").length === 1 && refusedRow(), JSON.stringify(calls("stripe_webhook_events", "update").at(-1)?.payload));
  t("… is_internal was read for that workspace id",
    g.__sbCalls.some((c) => isInternalRead(c) && c.filters.some(([f, col, v]) => f === "eq" && col === "id" && v === WS)));
  t("… and NOTHING was written: no workspaces/subscriptions/tenant_pages/billing_events rows, no rpc", writes().length === 0, writeNames());
}
reset();
g.__stripeStubs["checkout.sessions.listLineItems"] = async () => ({ data: [{ quantity: 3 }] });
g.__sbRpc["grant_credits"] = () => ({ data: null, error: null });
{
  const ev = { id: "evt_tm_notint_credits", object: "event", type: "checkout.session.completed", livemode: false, created: Math.floor(Date.now() / 1000),
    data: { object: { id: "cs_tm_1", object: "checkout.session", metadata: { workspace_id: WS, mode: "credits", credits_per_pack: "1000" }, payment_intent: "pi_tm_1", amount_total: 3000, currency: "usd" } } };
  const r = await deliver(ev, testSigned(ev), TEST_PATH);
  t("a credits checkout for a non-internal workspace is refused the same way", r.status === 200 && r.json.ignored === "workspace_not_internal" && refusedRow(), JSON.stringify(r.json));
  t("… no credit_purchases row, no grant_credits call, no write at all",
    calls("credit_purchases").length === 0 && calls("rpc:grant_credits").length === 0 && writes().length === 0, writeNames());
  t("… and Stripe was not even asked for the line items", !g.__stripeCalls.includes("checkout.sessions.listLineItems"));
}
reset();
g.__sbResponses["subscriptions.select"] = [{ data: { workspace_id: WS, plan_tier: "starter" } }];
g.__stripeStubs["subscriptions.retrieve"] = async () => subEvent("x", "active").data.object;
{
  const ev = { id: "evt_tm_notint_inv", object: "event", type: "invoice.paid", livemode: false, created: Math.floor(Date.now() / 1000),
    data: { object: { id: "in_tm_1", object: "invoice", subscription: "sub_1", billing_reason: "subscription_cycle" } } };
  const r = await deliver(ev, testSigned(ev), TEST_PATH);
  t("invoice.paid for a non-internal workspace is refused before reactivation and the monthly grant",
    r.status === 200 && r.json.ignored === "workspace_not_internal" && refusedRow() && calls("tenant_pages").length === 0 && calls("rpc:grant_credits").length === 0 && writes().length === 0,
    writeNames());
}
reset();
{
  const ev = { ...subEvent("evt_tm_notint_del", "canceled", {}, "customer.subscription.deleted"), livemode: false };
  const r = await deliver(ev, testSigned(ev), TEST_PATH);
  t("subscription.deleted for a non-internal workspace suspends nothing and cancels nothing",
    r.status === 200 && r.json.ignored === "workspace_not_internal" && refusedRow() && calls("tenant_pages").length === 0 && calls("subscriptions").length === 0 && writes().length === 0,
    writeNames());
}
reset();
g.__sbResponses["subscriptions.select"] = [{ data: { workspace_id: WS } }];
{
  const ev = { id: "evt_tm_notint_pf", object: "event", type: "invoice.payment_failed", livemode: false, created: Math.floor(Date.now() / 1000),
    data: { object: { id: "in_tm_2", object: "invoice", subscription: "sub_1", attempt_count: 1, next_payment_attempt: 1 } } };
  const r = await deliver(ev, testSigned(ev), TEST_PATH);
  t("invoice.payment_failed for a non-internal workspace is not even audited for it",
    r.status === 200 && r.json.ignored === "workspace_not_internal" && refusedRow() && calls("billing_events").length === 0 && writes().length === 0, writeNames());
}
reset();
g.__stripeStubs["invoices.retrieve"] = async () => ({ subscription: "sub_1" });
g.__sbResponses["subscriptions.select"] = [{ data: { workspace_id: WS } }];
{
  const ev = { id: "evt_tm_notint_ref", object: "event", type: "charge.refunded", livemode: false, created: Math.floor(Date.now() / 1000),
    data: { object: { id: "ch_tm_1", object: "charge", invoice: "in_tm_3", amount: 2900, amount_refunded: 2900, currency: "usd" } } };
  const r = await deliver(ev, testSigned(ev), TEST_PATH);
  t("charge.refunded attributed to a non-internal workspace is refused before its audit row",
    r.status === 200 && r.json.ignored === "workspace_not_internal" && refusedRow() && calls("billing_events").length === 0 && writes().length === 0, writeNames());
}
reset();
g.__stripeStubs["charges.retrieve"] = async () => ({ id: "ch_tm_2", invoice: null, customer: "cus_tm_1" });
g.__sbResponses["stripe_customers.select"] = [{ data: { workspace_id: WS } }];
{
  const ev = { id: "evt_tm_notint_disp", object: "event", type: "charge.dispute.created", livemode: false, created: Math.floor(Date.now() / 1000),
    data: { object: { id: "dp_tm_1", object: "dispute", charge: "ch_tm_2", amount: 2900, currency: "usd", reason: "fraudulent", status: "needs_response" } } };
  const r = await deliver(ev, testSigned(ev), TEST_PATH);
  t("charge.dispute.created attributed to a non-internal workspace is refused before its audit row",
    r.status === 200 && r.json.ignored === "workspace_not_internal" && refusedRow() && calls("billing_events").length === 0 && writes().length === 0, writeNames());
}
// "Exactly true": nothing else counts.
for (const { label, row } of [
  { label: "false", row: { is_internal: false } },
  { label: "null", row: { is_internal: null } },
  { label: "the string 'true'", row: { is_internal: "true" } },
  { label: "a missing workspace row", row: null },
]) {
  reset();
  g.__sbResponses["workspaces.select"] = [{ data: row }];
  g.__stripeStubs["subscriptions.retrieve"] = async () => subEvent("x", "active").data.object;
  const ev = { ...subEvent(`evt_tm_notint_${label.replace(/\W/g, "")}`, "active"), livemode: false };
  const r = await deliver(ev, testSigned(ev), TEST_PATH);
  t(`is_internal = ${label} is refused`, r.status === 200 && r.json.ignored === "workspace_not_internal" && writes().length === 0, JSON.stringify(r.json));
}
reset();
g.__sbResponses["workspaces.select"] = [{ data: null, error: { code: "XX000", message: "db down" } }];
g.__stripeStubs["subscriptions.retrieve"] = async () => subEvent("x", "active").data.object;
{
  const ev = { ...subEvent("evt_tm_readerr", "active"), livemode: false };
  const r = await deliver(ev, testSigned(ev), TEST_PATH);
  t("a failed is_internal read is a 500 (Stripe retries) with the real error on the row, never a write",
    r.status === 500 && writes().length === 0 && /db down/.test(String(calls("stripe_webhook_events", "update").at(-1)?.payload?.error)), JSON.stringify(calls("stripe_webhook_events", "update").at(-1)?.payload));
}
reset();
{
  const ev = { ...subEvent("evt_tm_order", "active"), livemode: true };
  const r = await deliver(ev, testSigned(ev), TEST_PATH);
  t("signature and livemode come first: a live event on the test deployment is mode_mismatch before any is_internal read",
    r.json.ignored === "mode_mismatch" && g.__sbCalls.length === 0);
}
reset();
{
  const ev = { ...subEvent("evt_tm_unsigned", "active"), livemode: false };
  const r = await deliver(ev, null, TEST_PATH);
  t("…and an unsigned event is a 400 before any is_internal read", r.status === 400 && g.__sbCalls.length === 0);
}

console.log("\n=== test-mode deployment: an internal workspace is processed as normal ===");
reset();
g.__sbResponses["workspaces.select"] = [{ data: { is_internal: true } }];
g.__stripeStubs["checkout.sessions.listLineItems"] = async () => ({ data: [{ quantity: 2 }] });
let granted: any = null;
g.__sbRpc["grant_credits"] = (args) => { granted = args; return { data: null, error: null }; };
{
  const ev = { id: "evt_tm_int_credits", object: "event", type: "checkout.session.completed", livemode: false, created: Math.floor(Date.now() / 1000),
    data: { object: { id: "cs_tm_2", object: "checkout.session", metadata: { workspace_id: WS, mode: "credits", credits_per_pack: "1000" }, payment_intent: "pi_tm_2", amount_total: 2000, currency: "usd" } } };
  const r = await deliver(ev, testSigned(ev), TEST_PATH);
  t("internal workspace: credits checkout -> 200 received, not ignored", r.status === 200 && r.json.received === true && r.json.ignored === undefined, JSON.stringify(r.json));
  t("… the purchase is recorded and the credits granted", calls("credit_purchases", "insert").length === 1 && granted?._workspace_id === WS && granted?._amount === 2000, JSON.stringify(granted));
  const readAt = g.__sbCalls.findIndex(isInternalRead);
  const firstWrite = g.__sbCalls.findIndex((c) => WRITE_OPS.has(c.op) && c.table !== "stripe_webhook_events");
  t("… and is_internal was checked BEFORE the first write", readAt >= 0 && firstWrite > readAt, `${readAt} vs ${firstWrite}`);
  t("… event marked processed", calls("stripe_webhook_events", "update").at(-1)?.payload?.processing_status === "processed");
}
reset();
g.__sbResponses["workspaces.select"] = [{ data: { is_internal: true } }];
{
  const ev = { ...subEvent("evt_tm_int_del", "canceled", {}, "customer.subscription.deleted"), livemode: false };
  const r = await deliver(ev, testSigned(ev), TEST_PATH);
  t("internal workspace: subscription.deleted suspends its pages as on live",
    r.status === 200 && r.json.received === true && calls("tenant_pages", "update").some((c) => c.payload?.status === "billing_suspended"));
}
reset();
g.__sbResponses["workspaces.select"] = [{ data: { is_internal: true } }];
g.__sbResponses["subscriptions.select"] = [{ data: { workspace_id: WS, plan_tier: "starter" } }];
g.__stripeStubs["subscriptions.retrieve"] = async () => subEvent("x", "active").data.object;
g.__sbRpc["grant_credits"] = () => ({ data: null, error: null });
{
  const ev = { id: "evt_tm_int_inv", object: "event", type: "invoice.paid", livemode: false, created: Math.floor(Date.now() / 1000),
    data: { object: { id: "in_tm_4", object: "invoice", subscription: "sub_1", billing_reason: "subscription_cycle" } } };
  const r = await deliver(ev, testSigned(ev), TEST_PATH);
  t("internal workspace: invoice.paid reactivates pages and grants the monthly allowance",
    r.status === 200 && r.json.received === true && calls("tenant_pages", "update").some((c) => c.payload?.status === "published") && calls("rpc:grant_credits").length === 1);
}

console.log("\n=== live deployment never consults is_internal ===");
reset();
g.__stripeStubs["subscriptions.retrieve"] = async () => subEvent("x", "active").data.object;
{
  const r = await deliver(subEvent("evt_live_noflag", "active"));
  t("live subscription.updated -> 200 with the entitlement granted", r.status === 200 && calls("workspaces", "update").some((c) => typeof c.payload?.page_limit_base === "number"));
  t("… without any is_internal read", !g.__sbCalls.some(isInternalRead));
}
reset();
g.__stripeStubs["checkout.sessions.listLineItems"] = async () => ({ data: [{ quantity: 1 }] });
{
  const ev = { id: "evt_live_credits", object: "event", type: "checkout.session.completed", livemode: true, created: Math.floor(Date.now() / 1000),
    data: { object: { id: "cs_live_1", object: "checkout.session", metadata: { workspace_id: WS, mode: "credits", credits_per_pack: "1000" }, payment_intent: "pi_live_1", amount_total: 1000, currency: "usd" } } };
  const r = await deliver(ev);
  t("live credits checkout is granted without any is_internal read", r.status === 200 && calls("rpc:grant_credits").length === 1 && !g.__sbCalls.some(isInternalRead));
}
reset();
{
  const r = await deliver(subEvent("evt_live_del", "canceled", {}, "customer.subscription.deleted"));
  t("live subscription.deleted still suspends, with no is_internal read", r.status === 200 && calls("tenant_pages", "update").some((c) => c.payload?.status === "billing_suspended") && !g.__sbCalls.some(isInternalRead));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("Failed:\n  " + failed.join("\n  ")); process.exit(1); }
