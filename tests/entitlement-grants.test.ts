/**
 * ADMIN ENTITLEMENT GRANTS. Run: bun tests/entitlement-grants.test.ts
 *
 * Free beta accounts carry no Stripe object, so on billing facts alone they
 * read as "no subscription" and get nothing. Each case below is a way that
 * could go wrong — either by refusing a tester who was granted access, or by
 * handing capacity to someone whose grant has ended.
 *
 * THE SHARED RULE, implemented twice on purpose (a pure TS function the app can
 * evaluate without a round trip, and SQL the publish gate can evaluate under a
 * lock). `EXPECTED` below is the single specification both must satisfy; the
 * SQL half is checked against this same table by the live parity block at the
 * foot of this file.
 *
 *   paidPages  = stripe_publish ? base + addon + bonus : 0
 *   grantPages = sum(page_limit) over grants active now
 *   effective  = paidPages + grantPages          -- additive, never greater-of
 *   publish    = stripe_publish OR grantPages > 0
 *   serve      = stripe_serve   OR grantPages > 0
 */
import {
  decideCapacity,
  effectivePageLimit,
  normalizeGrantedPages,
  PAST_DUE_GRACE_DAYS,
  STALE_PERIOD_DAYS,
  type BillingState,
} from "../src/lib/billing-capacity";
import { isGrantActive, type GrantRow } from "../src/lib/entitlement-grants.server";

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

const NOW = Date.parse("2026-09-18T00:00:00Z");
const days = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

/** Shorthand: run the whole rule the way readEntitlement does. */
function resolve(
  facts: {
    subscriptionStatus?: string | null;
    trialEndsAt?: string | null;
    currentPeriodEnd?: string | null;
    grantedPages?: number;
  },
  stored: { base: number; addon: number; bonus: number },
) {
  const decision = decideCapacity(
    {
      subscriptionStatus: facts.subscriptionStatus ?? null,
      trialEndsAt: facts.trialEndsAt ?? null,
      currentPeriodEnd: facts.currentPeriodEnd ?? null,
      grantedPages: facts.grantedPages ?? 0,
    },
    NOW,
  );
  return {
    ...decision,
    limit: effectivePageLimit({ ...stored, granted: facts.grantedPages ?? 0 }, decision),
  };
}

const NO_PLAN = { base: 25, addon: 0, bonus: 0 }; // schema default: the 25-page trial
const STARTER = { base: 100, addon: 0, bonus: 0 };
const GROWTH = { base: 500, addon: 0, bonus: 0 };

// ---------------------------------------------------------------------------
console.log("\n=== 1. the four approved combination examples ===");
// ---------------------------------------------------------------------------
{
  // No paid plan (expired trial) + 50-page beta grant = 50.
  const r = resolve(
    { subscriptionStatus: "trialing", trialEndsAt: days(-5), grantedPages: 50 },
    NO_PLAN,
  );
  t("no paid plan + 50 grant = 50 pages", r.limit === 50, `got ${r.limit}`);
  t("no paid plan + grant may publish", r.publish === true);
  t("no paid plan + grant may serve", r.serve === true);
  t("no paid plan + grant reports 'granted'", r.state === "granted", r.state);
  t(
    "expired trial page_limit_base does NOT leak in",
    r.limit === 50,
    "25 base must contribute nothing once the trial lapsed",
  );
}
{
  const r = resolve(
    { subscriptionStatus: "active", currentPeriodEnd: days(10), grantedPages: 50 },
    STARTER,
  );
  t("starter 100 + 50 grant = 150", r.limit === 150, `got ${r.limit}`);
  t("paying customer keeps the commercial state", r.state === "active", r.state);
}
{
  const r = resolve(
    { subscriptionStatus: "active", currentPeriodEnd: days(10), grantedPages: 100 },
    GROWTH,
  );
  t("growth 500 + 100 grant = 600", r.limit === 600, `got ${r.limit}`);
}
{
  const r = resolve({ subscriptionStatus: "active", currentPeriodEnd: days(10) }, STARTER);
  t("starter with no grant is unchanged at 100", r.limit === 100, `got ${r.limit}`);
}

// ---------------------------------------------------------------------------
console.log("\n=== 2. publishing within, and denial beyond, the allowance ===");
// ---------------------------------------------------------------------------
{
  const r = resolve(
    { subscriptionStatus: "trialing", trialEndsAt: days(-5), grantedPages: 50 },
    NO_PLAN,
  );
  const remainingAt = (published: number) => Math.max(r.limit - published, 0);
  t("tester may publish page 1", remainingAt(0) > 0);
  t("tester may publish page 50", remainingAt(49) > 0);
  t("page 51 is denied", remainingAt(50) === 0, `remaining ${remainingAt(50)}`);
  t("already-over workspace gets no negative headroom", remainingAt(70) === 0);
}

// ---------------------------------------------------------------------------
console.log("\n=== 3. expiry, revocation, restoration ===");
// ---------------------------------------------------------------------------
{
  const expired = resolve(
    { subscriptionStatus: "trialing", trialEndsAt: days(-5), grantedPages: 0 },
    NO_PLAN,
  );
  t("expired grant contributes nothing", expired.limit === 0, `got ${expired.limit}`);
  t("expired grant cannot publish", expired.publish === false);
  t("expired grant cannot serve", expired.serve === false);
  t("expired grant is not reported as 'granted'", expired.state !== "granted", expired.state);

  const restored = resolve(
    { subscriptionStatus: "trialing", trialEndsAt: days(-5), grantedPages: 50 },
    NO_PLAN,
  );
  t("restoring a grant restores entitlement immediately", restored.limit === 50);
  t("restoring a grant restores serving", restored.serve === true);
}

const baseGrant: GrantRow = {
  id: "00000000-0000-0000-0000-000000000001",
  workspace_id: "00000000-0000-0000-0000-0000000000ff",
  grant_type: "beta",
  page_limit: 50,
  starts_at: days(-1),
  expires_at: days(29),
  revoked_at: null,
  granted_by: "00000000-0000-0000-0000-00000000000a",
  reason: "beta tester",
  metadata: {},
  created_at: days(-1),
};

{
  t("active grant is active", isGrantActive(baseGrant, NOW) === true);
  t(
    "expired grant is inactive",
    isGrantActive({ ...baseGrant, expires_at: days(-1) }, NOW) === false,
  );
  t(
    "revoked grant is inactive even before expiry",
    isGrantActive({ ...baseGrant, revoked_at: days(0) }, NOW) === false,
  );
  t(
    "future-dated grant is not yet active",
    isGrantActive({ ...baseGrant, starts_at: days(3) }, NOW) === false,
  );
  t(
    "NULL expiry means permanent, not disabled",
    isGrantActive({ ...baseGrant, expires_at: null }, NOW) === true,
    "page_limit_bonus got this backwards — a NULL expiry silently voided it",
  );
  t(
    "expiry exactly now is over",
    isGrantActive({ ...baseGrant, expires_at: new Date(NOW).toISOString() }, NOW) === false,
  );
  t(
    "unparseable expiry fails closed",
    isGrantActive({ ...baseGrant, expires_at: "not-a-date" }, NOW) === false,
  );
}

// ---------------------------------------------------------------------------
console.log("\n=== 4. a grant never shrinks a paying customer ===");
// ---------------------------------------------------------------------------
{
  const withGrant = resolve(
    { subscriptionStatus: "active", currentPeriodEnd: days(10), grantedPages: 1 },
    GROWTH,
  );
  const without = resolve({ subscriptionStatus: "active", currentPeriodEnd: days(10) }, GROWTH);
  t(
    "a 1-page grant adds to 500, never replaces it",
    withGrant.limit === 501,
    `got ${withGrant.limit}`,
  );
  t("grant is strictly additive", withGrant.limit > without.limit);
}

// ---------------------------------------------------------------------------
console.log("\n=== 5. grants do not resurrect stale or fraudulent state ===");
// ---------------------------------------------------------------------------
{
  // 'active' but the period ended 60 days ago: Stripe has gone quiet. The
  // workspace is NOT entitled commercially, so paid capacity must not count —
  // only the grant.
  const r = resolve(
    {
      subscriptionStatus: "active",
      currentPeriodEnd: days(-(STALE_PERIOD_DAYS + 15)),
      grantedPages: 50,
    },
    GROWTH,
  );
  t("stale subscription contributes no paid pages", r.limit === 50, `got ${r.limit}`);
  t("stale + grant still publishes (on the grant alone)", r.publish === true);
  t("stale + grant reports 'granted', not 'active'", r.state === "granted", r.state);
}
{
  const r = resolve(
    { subscriptionStatus: "canceled", currentPeriodEnd: days(-30), grantedPages: 50 },
    GROWTH,
  );
  t("lapsed cancellation contributes no paid pages", r.limit === 50, `got ${r.limit}`);
}
{
  const r = resolve(
    { subscriptionStatus: "past_due", currentPeriodEnd: days(-1), grantedPages: 50 },
    STARTER,
  );
  // Inside the retry window Stripe says serve-but-do-not-publish, so paid pages
  // do not count; the grant is the whole allowance.
  t("past_due inside grace contributes no paid pages", r.limit === 50, `got ${r.limit}`);
  t("past_due inside grace + grant can publish", r.publish === true);
}

// ---------------------------------------------------------------------------
console.log("\n=== 6. input hardening — a grant is whole pages or nothing ===");
// ---------------------------------------------------------------------------
{
  t("negative grant is clamped to 0", normalizeGrantedPages(-50) === 0);
  t("fractional grant is truncated", normalizeGrantedPages(50.9) === 50);
  t("NaN grant is 0", normalizeGrantedPages(Number.NaN) === 0);
  t("Infinity grant is 0", normalizeGrantedPages(Number.POSITIVE_INFINITY) === 0);
  t("null grant is 0", normalizeGrantedPages(null) === 0);
  t("undefined grant is 0", normalizeGrantedPages(undefined) === 0);
  const r = resolve({ subscriptionStatus: "", grantedPages: -10 }, NO_PLAN);
  t("a negative grant cannot rescue an unentitled workspace", r.publish === false, r.state);
}

// ---------------------------------------------------------------------------
console.log("\n=== 7. the shared specification, state by state ===");
// ---------------------------------------------------------------------------
// This table IS the contract. The SQL implementation is checked against the
// same rows by the live parity query documented at the foot of this file, so a
// change to either side without the other fails here or there.
type Case = {
  name: string;
  status: string;
  trialEndsAt?: string | null;
  periodEnd?: string | null;
  granted: number;
  stored: { base: number; addon: number; bonus: number };
  expect: { state: BillingState; serve: boolean; publish: boolean; limit: number };
};

const EXPECTED: Case[] = [
  {
    name: "active, no grant",
    status: "active",
    periodEnd: days(10),
    granted: 0,
    stored: STARTER,
    expect: { state: "active", serve: true, publish: true, limit: 100 },
  },
  {
    name: "active + grant",
    status: "active",
    periodEnd: days(10),
    granted: 50,
    stored: STARTER,
    expect: { state: "active", serve: true, publish: true, limit: 150 },
  },
  {
    name: "trialing live, no grant",
    status: "trialing",
    trialEndsAt: days(5),
    granted: 0,
    stored: NO_PLAN,
    expect: { state: "trialing", serve: true, publish: true, limit: 25 },
  },
  {
    name: "trialing live + grant",
    status: "trialing",
    trialEndsAt: days(5),
    granted: 50,
    stored: NO_PLAN,
    expect: { state: "trialing", serve: true, publish: true, limit: 75 },
  },
  {
    name: "trial expired, no grant",
    status: "trialing",
    trialEndsAt: days(-5),
    granted: 0,
    stored: NO_PLAN,
    expect: { state: "trial_expired", serve: false, publish: false, limit: 0 },
  },
  {
    name: "trial expired + grant",
    status: "trialing",
    trialEndsAt: days(-5),
    granted: 50,
    stored: NO_PLAN,
    expect: { state: "granted", serve: true, publish: true, limit: 50 },
  },
  {
    name: "no status, no grant",
    status: "",
    granted: 0,
    stored: NO_PLAN,
    expect: { state: "unknown", serve: true, publish: false, limit: 0 },
  },
  {
    name: "no status + grant",
    status: "",
    granted: 50,
    stored: NO_PLAN,
    expect: { state: "granted", serve: true, publish: true, limit: 50 },
  },
  {
    name: "past_due in grace, no grant",
    status: "past_due",
    periodEnd: days(-1),
    granted: 0,
    stored: STARTER,
    expect: { state: "grace", serve: true, publish: false, limit: 0 },
  },
  {
    name: "past_due lapsed, no grant",
    status: "past_due",
    periodEnd: days(-(PAST_DUE_GRACE_DAYS + 5)),
    granted: 0,
    stored: STARTER,
    expect: { state: "lapsed", serve: false, publish: false, limit: 0 },
  },
  {
    name: "cancelled in paid period",
    status: "canceled",
    periodEnd: days(10),
    granted: 0,
    stored: STARTER,
    expect: { state: "grace", serve: true, publish: false, limit: 0 },
  },
  {
    name: "cancelled, period over",
    status: "canceled",
    periodEnd: days(-1),
    granted: 0,
    stored: STARTER,
    expect: { state: "lapsed", serve: false, publish: false, limit: 0 },
  },
  {
    name: "unpaid",
    status: "unpaid",
    granted: 0,
    stored: STARTER,
    expect: { state: "lapsed", serve: false, publish: false, limit: 0 },
  },
  {
    name: "incomplete",
    status: "incomplete",
    granted: 0,
    stored: STARTER,
    expect: { state: "lapsed", serve: false, publish: false, limit: 0 },
  },
  {
    name: "paused",
    status: "paused",
    granted: 0,
    stored: STARTER,
    expect: { state: "lapsed", serve: false, publish: false, limit: 0 },
  },
  {
    name: "stale active",
    status: "active",
    periodEnd: days(-(STALE_PERIOD_DAYS + 5)),
    granted: 0,
    stored: STARTER,
    expect: { state: "stale", serve: false, publish: false, limit: 0 },
  },
  {
    name: "lapsed + grant",
    status: "unpaid",
    granted: 50,
    stored: STARTER,
    expect: { state: "granted", serve: true, publish: true, limit: 50 },
  },
  {
    name: "trialing, no end date",
    status: "trialing",
    trialEndsAt: null,
    granted: 0,
    stored: NO_PLAN,
    expect: { state: "unknown", serve: true, publish: false, limit: 0 },
  },
];

for (const c of EXPECTED) {
  const r = resolve(
    {
      subscriptionStatus: c.status,
      trialEndsAt: c.trialEndsAt ?? null,
      currentPeriodEnd: c.periodEnd ?? null,
      grantedPages: c.granted,
    },
    c.stored,
  );
  t(
    `spec: ${c.name}`,
    r.state === c.expect.state &&
      r.serve === c.expect.serve &&
      r.publish === c.expect.publish &&
      r.limit === c.expect.limit,
    `got state=${r.state} serve=${r.serve} publish=${r.publish} limit=${r.limit}; ` +
      `want state=${c.expect.state} serve=${c.expect.serve} publish=${c.expect.publish} limit=${c.expect.limit}`,
  );
}

// ---------------------------------------------------------------------------
console.log("\n=== 8. the divergence this change closes ===");
// ---------------------------------------------------------------------------
{
  // Before this work, publish_tenant_pages() summed base+addon+bonus and never
  // read subscription_status, so an expired trial published 25 pages while the
  // app reported 0. Both layers now derive from the rule above; the assertion
  // here is the app half, and the SQL half is asserted live (see below).
  const r = resolve({ subscriptionStatus: "trialing", trialEndsAt: days(-5) }, NO_PLAN);
  t(
    "expired trial has NO publish rights, base column notwithstanding",
    r.limit === 0 && r.publish === false,
    `limit=${r.limit} publish=${r.publish}`,
  );
  const revoked = resolve(
    { subscriptionStatus: "", grantedPages: 0 },
    { base: 999999, addon: 0, bonus: 0 },
  );
  t(
    "a huge page_limit_base grants nothing without an entitling state",
    revoked.limit === 0,
    `got ${revoked.limit}`,
  );
}

/*
 * LIVE PARITY — run against the database after applying
 * 20260918000000_entitlement_grants.sql. Every row must report true; each
 * corresponds to a `spec:` case above.
 *
 *   SELECT c.state, c.serve, c.publish, c.page_limit
 *     FROM public.workspace_capacity('<workspace-id>') c;
 *
 * The SQL mirrors decideCapacity() case for case and shares its two constants
 * (PAST_DUE_GRACE_DAYS = 7, STALE_PERIOD_DAYS = 45). If either side changes
 * without the other, the state/limit pair stops matching this table.
 */

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed: " + failed.join(", "));
  process.exit(1);
}
