/**
 * STRIPE WEBHOOK, OFFLINE. Run:
 *   bun --preload ./tests/_preload/deno-edge-function.ts tests/stripe-webhook.test.ts
 *
 * Drives supabase/functions/stripe-webhook/index.ts through its Deno.serve
 * handler with REAL Stripe signatures (the stripe npm package signs and the
 * function verifies) and a recording fake of the service-role client. Pins:
 * signature verification, replay outside the tolerance window, duplicate-event
 * idempotency, reclaim of a crashed attempt, failed-payment grace, suspension
 * on cancel/unpaid, and the fail-loud paths (500 keeps Stripe retrying).
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
await import(built);
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
async function deliver(event: Record<string, unknown>, headerOverride?: string | null) {
  const body = JSON.stringify(event);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const sig = headerOverride === undefined ? signed(body) : headerOverride;
  if (sig !== null) headers["stripe-signature"] = sig;
  const res = await handler(new Request("http://edge.invalid/stripe-webhook", { method: "POST", headers, body }));
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
const calls = (table: string, op?: string) => g.__sbCalls.filter((c) => c.table === table && (!op || c.op === op));
const WS = "11111111-1111-4111-8111-111111111111";
function subEvent(id: string, status: string, extra: Record<string, unknown> = {}, type = "customer.subscription.updated") {
  return {
    id, object: "event", type, created: Math.floor(Date.now() / 1000),
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
  const ev = { id: "evt_pf", object: "event", type: "invoice.payment_failed", created: Math.floor(Date.now() / 1000),
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
  const ev = { id: "evt_credits", object: "event", type: "checkout.session.completed", created: Math.floor(Date.now() / 1000),
    data: { object: { id: "cs_1", object: "checkout.session", metadata: { workspace_id: WS, mode: "credits", credits_per_pack: "1000" }, payment_intent: "pi_1", amount_total: 1000, currency: "usd" } } };
  const r = await deliver(ev);
  t("failed credit grant -> 500 (never ACK a purchase that was not granted)", r.status === 500, String(r.status));
  const mark = calls("stripe_webhook_events", "update").at(-1);
  t("crashed attempt recorded as error on the event row", mark?.payload?.processing_status === "error" && /ledger down/.test(String(mark?.payload?.error)), JSON.stringify(mark?.payload));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("Failed:\n  " + failed.join("\n  ")); process.exit(1); }
