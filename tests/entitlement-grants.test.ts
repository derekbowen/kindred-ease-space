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
 *   grantPages = sum(page_limit) over grants active now
 *   granted    = grantPages > 0 AND (NOT stripe_publish OR stripe_state = trialing)
 *   paidPages  = stripe_publish AND NOT granted ? base + addon + bonus : 0
 *   effective  = paidPages + grantPages          -- additive, never greater-of
 *   publish    = stripe_publish OR grantPages > 0
 *   serve      = stripe_serve   OR grantPages > 0
 *
 * The `granted` line was amended on 2026-09-24 (20260924000700): a grant
 * supersedes a TRIAL, which is not a paid entitlement, and never an active
 * paid subscription. Before that a beta tenant read as 'trialing' for its
 * first fortnight — Trial badge, "pick a plan" countdown, metered generation.
 *
 * Round 5 (owner request 2026-09-25): an ACTIVE grant of type 'internal' —
 * the founder / internal unlimited entitlement — decides first and alone:
 *
 *   internal   = an active grant_type 'internal' grant (not revoked, started,
 *                not expired; a NULL expiry is permanent)
 *   internal  → state 'internal', serve, publish, page limit 2147483647
 *
 * Every row of EXPECTED is also run with that grant (it must read internal
 * whatever the Stripe facts say) and without it (it must read exactly as
 * before) — in TypeScript, and LIVE against the SQL on PGlite (section 12).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  decideCapacity,
  effectivePageLimit,
  INTERNAL_UNLIMITED_PAGE_LIMIT,
  INTERNAL_UNLIMITED_PLAN_LABEL,
  internalAccessFields,
  normalizeGrantedPages,
  PAST_DUE_GRACE_DAYS,
  STALE_PERIOD_DAYS,
  type BillingState,
} from "../src/lib/billing-capacity";
import { isGrantActive, type GrantRow } from "../src/lib/entitlement-grants.server";
import { MIGRATION_700, MIGRATION_GRANTS, SUPABASE_STUBS, readRepo } from "./_support/ai-db";

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
    internalUnlimited?: boolean | null;
  },
  stored: { base: number; addon: number; bonus: number },
  now: number = NOW,
) {
  const decision = decideCapacity(
    {
      subscriptionStatus: facts.subscriptionStatus ?? null,
      trialEndsAt: facts.trialEndsAt ?? null,
      currentPeriodEnd: facts.currentPeriodEnd ?? null,
      grantedPages: facts.grantedPages ?? 0,
      ...(facts.internalUnlimited === undefined ? {} : { internalUnlimited: facts.internalUnlimited }),
    },
    now,
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
    name: "active paid + grant stays active",
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
    // A grant supersedes a trial: 'granted', and the grant is the whole
    // allowance — not the 25-page trial base plus it.
    name: "trialing live + grant",
    status: "trialing",
    trialEndsAt: days(5),
    granted: 50,
    stored: NO_PLAN,
    expect: { state: "granted", serve: true, publish: true, limit: 50 },
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

// ---------------------------------------------------------------------------
console.log("\n=== 9. a grant supersedes a trial, never a paid plan ===");
// ---------------------------------------------------------------------------
// Every workspace is provisioned as a 14-day trial, so a beta tenant is
// 'trialing' AND granted for its first fortnight. Reporting the Stripe state
// there gave it a Trial badge, a "pick a plan" countdown and — because
// isGenerationGranted keys on 'granted' — metered generation, for exactly the
// two weeks /beta promises are free. A trial is not a paid entitlement.
{
  const r = resolve(
    { subscriptionStatus: "trialing", trialEndsAt: days(5), grantedPages: 50 },
    NO_PLAN,
  );
  t("live trial + grant reports 'granted', not 'trialing'", r.state === "granted", r.state);
  t(
    "live trial + grant: the grant is the whole allowance (50, not 25 + 50)",
    r.limit === 50,
    `got ${r.limit}`,
  );
  t("live trial + grant still serves and publishes", r.serve && r.publish);
  t(
    "the reason still records the commercial state for ops",
    /Commercial status: trialing/.test(r.reason),
    r.reason,
  );

  const paid = resolve(
    { subscriptionStatus: "active", currentPeriodEnd: days(10), grantedPages: 50 },
    STARTER,
  );
  t("active paid + grant stays 'active'", paid.state === "active", paid.state);
  t(
    "active paid + grant keeps paid capacity and adds the grant",
    paid.limit === 150,
    `got ${paid.limit}`,
  );

  const noEnd = resolve(
    { subscriptionStatus: "trialing", trialEndsAt: null, grantedPages: 50 },
    NO_PLAN,
  );
  t(
    "trialing with no end date + grant is rescued to 'granted'",
    noEnd.state === "granted" && noEnd.publish && noEnd.limit === 50,
    `state=${noEnd.state} limit=${noEnd.limit}`,
  );

  const bare = resolve({ subscriptionStatus: "trialing", trialEndsAt: days(5) }, NO_PLAN);
  t(
    "a live trial with no grant is still a trial",
    bare.state === "trialing" && bare.limit === 25,
    `state=${bare.state} limit=${bare.limit}`,
  );
}

// ---------------------------------------------------------------------------
console.log("\n=== 10. the SQL half carries the same amendment (migration text) ===");
// ---------------------------------------------------------------------------
{
  const ROOT = join(import.meta.dir, "..");
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
  const withoutComments = (sql: string) =>
    sql
      .split("\n")
      .filter((l) => !/^\s*--/.test(l))
      .join("\n");
  // The workspace_capacity definition only, from CREATE to its closing $$;.
  const capacityRaw = (sql: string) => {
    const start = sql.indexOf(
      "CREATE OR REPLACE FUNCTION public.workspace_capacity(_workspace_id uuid)",
    );
    const end = sql.indexOf("$$;", start);
    return start >= 0 && end > start ? sql.slice(start, end) : "";
  };
  const originalRaw = capacityRaw(
    read("supabase/migrations/20260918000000_entitlement_grants.sql"),
  );
  const original = withoutComments(originalRaw);
  const migration = read("supabase/migrations/20260924000700_grant_supersedes_trial.sql");
  const rollback = read("supabase/rollback/20260924000700_grant_supersedes_trial_rollback.sql");
  const NEW_BLOCK =
    "  IF v_granted > 0 AND (NOT v_stripe_pub OR v_state = 'trialing') THEN\n" +
    "    v_state := 'granted';\n" +
    "    v_paid := 0;\n" +
    "  END IF;";
  const OLD_BLOCK =
    "  IF v_granted > 0 AND NOT v_stripe_pub THEN\n    v_state := 'granted';\n  END IF;";

  t(
    "the 20260918 body is where this test thinks it is",
    original.includes(OLD_BLOCK) && !original.includes("v_paid := 0;"),
  );
  const amended = withoutComments(capacityRaw(migration));
  t("000700 redefines workspace_capacity", amended.length > 0);
  t("000700 makes a grant supersede a trial", amended.includes(NEW_BLOCK));
  t(
    "000700 zeroes paid capacity in the granted state (mirrors effectivePageLimit)",
    amended.includes("v_paid := 0;"),
  );
  // Round 5: the founder / internal unlimited branch, first and alone —
  // right after the workspace is found, before any Stripe fact is read.
  const INTERNAL_BLOCK =
    "  IF public.workspace_is_internal_unlimited(_workspace_id) THEN\n" +
    "    RETURN QUERY SELECT 'internal'::text, true, true, 2147483647;\n" +
    "    RETURN;\n" +
    "  END IF;\n\n";
  t(
    "000700 answers the internal entitlement first and alone: once, after NOT FOUND, before the Stripe facts",
    amended.split(INTERNAL_BLOCK).length === 2 &&
      amended.indexOf(INTERNAL_BLOCK) > amended.indexOf("RAISE EXCEPTION 'workspace_not_found';") &&
      amended.indexOf(INTERNAL_BLOCK) < amended.indexOf("v_status  := lower("),
  );
  t(
    "000700 changes nothing else in the body",
    amended.replace(NEW_BLOCK, OLD_BLOCK).replace(INTERNAL_BLOCK, "") === original,
  );
  t(
    "000700 keeps the function service-role only",
    migration.includes(
      "REVOKE ALL ON FUNCTION public.workspace_capacity(uuid) FROM PUBLIC, anon, authenticated;",
    ) &&
      migration.includes(
        "GRANT EXECUTE ON FUNCTION public.workspace_capacity(uuid) TO service_role;",
      ),
  );
  t(
    "000700 verifies the predicate landed in the stored body",
    /prosrc LIKE '%IF v_granted > 0 AND \(NOT v_stripe_pub OR v_state = ''trialing''\) THEN%'/.test(
      migration,
    ) && /prosrc LIKE '%v_paid := 0;%'/.test(migration),
  );
  t(
    "000700 verifies anon and authenticated still cannot execute it",
    /NOT has_function_privilege\('anon', 'public\.workspace_capacity\(uuid\)', 'EXECUTE'\)/.test(
      migration,
    ) &&
      /NOT has_function_privilege\('authenticated', 'public\.workspace_capacity\(uuid\)', 'EXECUTE'\)/.test(
        migration,
      ),
  );
  t(
    "000700 verification block is last",
    migration.trim().endsWith("p.proname = 'publish_tenant_pages');"),
  );

  t("the rollback restores the 20260918 body verbatim", capacityRaw(rollback) === originalRaw);
  const restored = withoutComments(capacityRaw(rollback));
  t(
    "the rollback body has no trace of the new predicate (nor of the internal branch)",
    restored.length > 0 &&
      !restored.includes("v_state = 'trialing'") &&
      !restored.includes("v_paid := 0;") &&
      !restored.includes("workspace_is_internal_unlimited"),
  );
  t(
    "the rollback is transactional and keeps the grants",
    /^BEGIN;/m.test(rollback) &&
      /^COMMIT;/m.test(rollback) &&
      rollback.includes(
        "GRANT EXECUTE ON FUNCTION public.workspace_capacity(uuid) TO service_role;",
      ),
  );
  t(
    "the rollback ends with a VERIFY query for the old predicate",
    /-- VERIFY \(rolled back\)/.test(rollback) &&
      /AS supersedes_trial/.test(rollback) &&
      /AS zeroes_paid/.test(rollback),
  );
}

// ---------------------------------------------------------------------------
console.log("\n=== 11. the founder / internal unlimited entitlement decides first and alone (TS) ===");
// ---------------------------------------------------------------------------
{
  const INTERNAL = { state: "internal" as BillingState, serve: true, publish: true, limit: INTERNAL_UNLIMITED_PAGE_LIMIT };
  const regressions: string[] = [];
  let checked = 0;
  for (const c of EXPECTED) {
    const facts = {
      subscriptionStatus: c.status,
      trialEndsAt: c.trialEndsAt ?? null,
      currentPeriodEnd: c.periodEnd ?? null,
      grantedPages: c.granted,
    };
    const on = resolve({ ...facts, internalUnlimited: true }, c.stored);
    t(
      `internal + ${c.name}: internal, serves, publishes, no page limit`,
      on.state === INTERNAL.state && on.serve && on.publish && on.limit === INTERNAL.limit,
      `got state=${on.state} serve=${on.serve} publish=${on.publish} limit=${on.limit}`,
    );
    // The regression half: the same facts without the grant read exactly as before.
    for (const off of [false, null, undefined]) {
      const r = resolve({ ...facts, internalUnlimited: off }, c.stored);
      checked++;
      if (!(r.state === c.expect.state && r.serve === c.expect.serve && r.publish === c.expect.publish && r.limit === c.expect.limit)) {
        regressions.push(`${String(off)} + ${c.name}: state=${r.state} limit=${r.limit}`);
      }
    }
  }
  t(
    `internalUnlimited false / null / absent changes no row of the table (${checked} checks)`,
    checked === EXPECTED.length * 3 && regressions.length === 0,
    regressions.join("; "),
  );
  t("the internal page limit is int4's maximum (what workspace_capacity returns)", INTERNAL_UNLIMITED_PAGE_LIMIT === 2_147_483_647);
  t(
    "the internal reason says so, by its label",
    resolve({ subscriptionStatus: "trialing", trialEndsAt: days(-30), internalUnlimited: true }, NO_PLAN).reason.startsWith(
      `${INTERNAL_UNLIMITED_PLAN_LABEL}: no page, publishing or AI usage limits`,
    ),
  );
  t(
    "an expired trial never reads expired while the internal grant is active",
    resolve({ subscriptionStatus: "trialing", trialEndsAt: days(-365), internalUnlimited: true }, NO_PLAN).state === "internal",
  );
  t(
    "only a literal true counts (a truthy non-boolean from a bad read does not)",
    resolve({ subscriptionStatus: "trialing", trialEndsAt: days(-5), internalUnlimited: "true" as unknown as boolean }, NO_PLAN).state === "trial_expired",
  );
  const on = internalAccessFields(true);
  const off = internalAccessFields(false);
  t(
    "the UI fields: internal → { internalUnlimited: true, planLabel: 'Founder / Internal Unlimited', revealLaunchHiddenFeatures: true }",
    JSON.stringify(on) === JSON.stringify({ internalUnlimited: true, planLabel: "Founder / Internal Unlimited", revealLaunchHiddenFeatures: true }),
    JSON.stringify(on),
  );
  t(
    "the UI fields: everyone else → { internalUnlimited: false, planLabel: null, revealLaunchHiddenFeatures: false }",
    JSON.stringify(off) === JSON.stringify({ internalUnlimited: false, planLabel: null, revealLaunchHiddenFeatures: false }),
    JSON.stringify(off),
  );
}

// ---------------------------------------------------------------------------
console.log("\n=== 12. LIVE PARITY: workspace_capacity() against decideCapacity(), row by row (PGlite) ===");
// ---------------------------------------------------------------------------
// 20260918000000 and 20260924000700 applied to PGlite (Postgres compiled to
// WASM) on the Supabase stand-ins; every EXPECTED row becomes a real
// workspace (its billing facts, a beta grant for its granted pages) and is
// read through the SQL, once as is and once more holding an internal grant.
// Dates are the table's offsets from the real clock, since the SQL reads
// now(). The SQL shares decideCapacity()'s two constants
// (PAST_DUE_GRACE_DAYS = 7, STALE_PERIOD_DAYS = 45).
{
  const db = await PGlite.create();
  await db.exec(SUPABASE_STUBS);
  await db.exec(readRepo(MIGRATION_GRANTS));
  await db.exec(readRepo(MIGRATION_700));
  const ADMIN = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
  await db.exec(`INSERT INTO auth.users (id) VALUES ('${ADMIN}')`);
  const live = (iso: string | null | undefined) =>
    iso ? new Date(Date.now() + (Date.parse(iso) - NOW)).toISOString() : null;
  let n = 0;
  const wsId = () => `eeeeeeee-eeee-4eee-8eee-${String(++n).padStart(12, "0")}`;
  const capacity = async (ws: string) =>
    (await db.query<{ state: string; serve: boolean; publish: boolean; page_limit: number }>(
      "SELECT state, serve, publish, page_limit FROM public.workspace_capacity($1)",
      [ws],
    )).rows[0]!;
  const grant = (ws: string, type: string, pages: number) =>
    db.query(
      `INSERT INTO public.workspace_entitlement_grants (workspace_id, grant_type, page_limit, starts_at, granted_by, reason)
       VALUES ($1, $2, $3, now() - interval '1 day', $4, 'parity test')`,
      [ws, type, pages, ADMIN],
    );
  let agreed = 0;
  for (const c of EXPECTED) {
    for (const internal of [false, true]) {
      const ws = wsId();
      await db.query(
        `INSERT INTO public.workspaces (id, subscription_status, trial_ends_at, current_period_end,
                                        page_limit_base, page_limit_addon, page_limit_bonus)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ws, c.status, live(c.trialEndsAt), live(c.periodEnd), c.stored.base, c.stored.addon, c.stored.bonus],
      );
      if (c.granted > 0) await grant(ws, "beta", c.granted);
      if (internal) await grant(ws, "internal", 1_000_000);
      const sql = await capacity(ws);
      const ts = resolve(
        {
          subscriptionStatus: c.status,
          trialEndsAt: live(c.trialEndsAt),
          currentPeriodEnd: live(c.periodEnd),
          grantedPages: c.granted,
          internalUnlimited: internal,
        },
        c.stored,
        Date.now(),
      );
      const want = internal
        ? { state: "internal", serve: true, publish: true, limit: INTERNAL_UNLIMITED_PAGE_LIMIT }
        : c.expect;
      const same =
        sql.state === ts.state && sql.serve === ts.serve && sql.publish === ts.publish && sql.page_limit === ts.limit;
      const right =
        sql.state === want.state && sql.serve === want.serve && sql.publish === want.publish && sql.page_limit === want.limit;
      t(
        `live: ${internal ? "internal + " : ""}${c.name} — SQL and TS agree, and match the table`,
        same && right,
        `sql=${JSON.stringify(sql)} ts=${JSON.stringify({ state: ts.state, serve: ts.serve, publish: ts.publish, limit: ts.limit })}`,
      );
      if (same && right) agreed++;
    }
  }
  t(`every row agrees live (${EXPECTED.length * 2} workspaces)`, agreed === EXPECTED.length * 2, `${agreed}`);

  // Revocation and the grant window, live.
  const ws = wsId();
  await db.query(
    `INSERT INTO public.workspaces (id, subscription_status, trial_ends_at) VALUES ($1, 'trialing', now() - interval '3 days')`,
    [ws],
  );
  await grant(ws, "internal", 1_000_000);
  t("an expired trial holding an internal grant reads internal", (await capacity(ws)).state === "internal");
  await db.query(`UPDATE public.workspace_entitlement_grants SET revoked_at = now() WHERE workspace_id = $1`, [ws]);
  const back = await capacity(ws);
  t(
    "revoked: the very next read is the workspace's own facts again (trial_expired: no serve, no publish, 0 pages)",
    back.state === "trial_expired" && !back.serve && !back.publish && back.page_limit === 0,
    JSON.stringify(back),
  );
  await db.query(
    `INSERT INTO public.workspace_entitlement_grants (workspace_id, grant_type, page_limit, starts_at, expires_at, granted_by, reason)
     VALUES ($1, 'internal', 1000000, now() - interval '5 days', now() - interval '1 day', $2, 'expired'),
            ($1, 'internal', 1000000, now() + interval '1 day', NULL, $2, 'not yet started')`,
    [ws, ADMIN],
  );
  t("an expired or not-yet-started internal grant is not internal", (await capacity(ws)).state === "trial_expired");
  const other = wsId();
  await db.query(`INSERT INTO public.workspaces (id, subscription_status, trial_ends_at) VALUES ($1, 'trialing', now() + interval '5 days')`, [other]);
  await grant(other, "beta", 50);
  const o = await capacity(other);
  t(
    "a workspace without the internal grant is untouched by another workspace's (per-workspace, never global)",
    o.state === "granted" && o.page_limit === 50,
    JSON.stringify(o),
  );
  await db.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed: " + failed.join(", "));
  process.exit(1);
}
