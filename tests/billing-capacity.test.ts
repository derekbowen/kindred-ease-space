/**
 * Entitlement derived from billing facts. Run: bun tests/billing-capacity.test.ts
 *
 * The rules here are the subscription promise: pages stop when paying stops.
 * Each case below is a way that promise was previously broken.
 */
import {
  decideCapacity,
  effectivePageLimit,
  PAST_DUE_GRACE_DAYS,
  STALE_PERIOD_DAYS,
} from "../src/lib/billing-capacity";

let pass = 0, fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL  ${name}  ${extra}`); }
}

const NOW = Date.parse("2026-09-13T00:00:00Z");
const days = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

console.log("\n=== active subscription ===");
{
  const d = decideCapacity(
    { subscriptionStatus: "active", trialEndsAt: null, currentPeriodEnd: days(12) },
    NOW,
  );
  t("serves", d.serve);
  t("may publish", d.publish);
  t("state is active", d.state === "active", d.state);
}

console.log("\n=== trial expiry (was never compared to now) ===");
{
  const running = decideCapacity(
    { subscriptionStatus: "trialing", trialEndsAt: days(3), currentPeriodEnd: null },
    NOW,
  );
  t("running trial serves and publishes", running.serve && running.publish);
  t("running trial state", running.state === "trialing", running.state);

  const expired = decideCapacity(
    { subscriptionStatus: "trialing", trialEndsAt: days(-1), currentPeriodEnd: null },
    NOW,
  );
  t("expired trial stops serving", !expired.serve);
  t("expired trial cannot publish", !expired.publish);
  t("expired trial state", expired.state === "trial_expired", expired.state);

  const boundary = decideCapacity(
    { subscriptionStatus: "trialing", trialEndsAt: new Date(NOW).toISOString(), currentPeriodEnd: null },
    NOW,
  );
  t("trial ending exactly now is over", !boundary.serve);

  const noEnd = decideCapacity(
    { subscriptionStatus: "trialing", trialEndsAt: null, currentPeriodEnd: null },
    NOW,
  );
  t("trialing with no end date serves but cannot publish", noEnd.serve && !noEnd.publish);
}

console.log("\n=== cancellation: paid through the period, then dark ===");
{
  const withinPaid = decideCapacity(
    { subscriptionStatus: "canceled", trialEndsAt: null, currentPeriodEnd: days(5) },
    NOW,
  );
  t("still serves inside the paid period", withinPaid.serve);
  t("cannot publish new pages after cancelling", !withinPaid.publish);
  t("reason names the end date", withinPaid.reason.includes("2026-09-18"), withinPaid.reason);

  const afterPaid = decideCapacity(
    { subscriptionStatus: "canceled", trialEndsAt: null, currentPeriodEnd: days(-1) },
    NOW,
  );
  t("goes dark once the paid period ends", !afterPaid.serve);
  t("state is lapsed", afterPaid.state === "lapsed", afterPaid.state);

  t("British spelling handled too", !decideCapacity(
    { subscriptionStatus: "cancelled", trialEndsAt: null, currentPeriodEnd: days(-1) },
    NOW,
  ).serve);
}

console.log("\n=== past_due: a declined card must not instantly kill a live site ===");
{
  const inGrace = decideCapacity(
    { subscriptionStatus: "past_due", trialEndsAt: null, currentPeriodEnd: days(-1) },
    NOW,
  );
  t("stays up during the retry window", inGrace.serve);
  t("publishing paused while unpaid", !inGrace.publish);
  t("state is grace", inGrace.state === "grace", inGrace.state);

  const afterGrace = decideCapacity(
    { subscriptionStatus: "past_due", trialEndsAt: null, currentPeriodEnd: days(-PAST_DUE_GRACE_DAYS - 1) },
    NOW,
  );
  t("lapses once the retry window closes", !afterGrace.serve);
}

console.log("\n=== the missed-webhook hole: active but Stripe went quiet ===");
{
  const stale = decideCapacity(
    { subscriptionStatus: "active", trialEndsAt: null, currentPeriodEnd: days(-STALE_PERIOD_DAYS - 1) },
    NOW,
  );
  t("a period end older than a full cycle stops serving", !stale.serve);
  t("state is stale, distinct from lapsed", stale.state === "stale", stale.state);
  t("reason explains Stripe silence", /not been heard from/i.test(stale.reason), stale.reason);

  const justLate = decideCapacity(
    { subscriptionStatus: "active", trialEndsAt: null, currentPeriodEnd: days(-3) },
    NOW,
  );
  t("a merely late renewal keeps serving", justLate.serve && justLate.publish);

  const noPeriod = decideCapacity(
    { subscriptionStatus: "active", trialEndsAt: null, currentPeriodEnd: null },
    NOW,
  );
  t("active with no period end is not punished", noPeriod.serve && noPeriod.publish);
}

console.log("\n=== states that never paid ===");
{
  for (const status of ["unpaid", "incomplete", "incomplete_expired", "paused"]) {
    const d = decideCapacity({ subscriptionStatus: status, trialEndsAt: null, currentPeriodEnd: null }, NOW);
    t(`${status} does not serve`, !d.serve, d.state);
  }
}

console.log("\n=== unknown facts fail OPEN, never closed ===");
{
  const missing = decideCapacity(
    { subscriptionStatus: null, trialEndsAt: null, currentPeriodEnd: null },
    NOW,
  );
  t("null status keeps the site up", missing.serve);
  t("null status pauses publishing", !missing.publish);
  t("null status is flagged unknown", missing.state === "unknown", missing.state);

  const weird = decideCapacity(
    { subscriptionStatus: "some_new_stripe_status", trialEndsAt: null, currentPeriodEnd: null },
    NOW,
  );
  t("unrecognised status keeps the site up", weird.serve);
  t("unrecognised status is flagged", weird.state === "unknown");
  t("unrecognised status is named in the reason", weird.reason.includes("some_new_stripe_status"));

  const cased = decideCapacity(
    { subscriptionStatus: "  ACTIVE  ", trialEndsAt: null, currentPeriodEnd: days(5) },
    NOW,
  );
  t("status matching is case- and whitespace-insensitive", cased.state === "active", cased.state);

  const garbageDate = decideCapacity(
    { subscriptionStatus: "trialing", trialEndsAt: "not-a-date", currentPeriodEnd: null },
    NOW,
  );
  t("unparseable trial date does not read as expired", garbageDate.serve, garbageDate.state);
}

console.log("\n=== effective limit ===");
{
  const stored = { base: 100, addon: 50, bonus: 25 };
  const active = decideCapacity(
    { subscriptionStatus: "active", trialEndsAt: null, currentPeriodEnd: days(10) },
    NOW,
  );
  t("entitled workspace gets the full sum", effectivePageLimit(stored, active) === 175);

  const lapsed = decideCapacity(
    { subscriptionStatus: "canceled", trialEndsAt: null, currentPeriodEnd: days(-1) },
    NOW,
  );
  t("lapsed workspace has zero capacity whatever the columns say",
    effectivePageLimit(stored, lapsed) === 0);

  const grace = decideCapacity(
    { subscriptionStatus: "past_due", trialEndsAt: null, currentPeriodEnd: days(-1) },
    NOW,
  );
  t("grace has no publishing capacity but still serves",
    effectivePageLimit(stored, grace) === 0 && grace.serve);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("Failed: " + failed.join(", ")); process.exit(1); }
