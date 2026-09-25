/**
 * TRIAL AND PLAN WORDING. Run: bun tests/plan-status.test.ts
 *
 * An expired trial keeps subscription_status = 'trialing', so billing showed
 * "Free trial · trialing · Trial ends 7/3/2026" beside "Free trial has ended",
 * and the dashboard said "Trial — 0 days left". One helper
 * (src/components/billing/plan-status.ts) now words every surface, deciding
 * "ended" by billing's own rule (decideCapacity). Offline and clock-injected.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describePlanStatus,
  formatPlanDate,
  planDisplayName,
  subscriptionStatusLabel,
} from "../src/components/billing/plan-status";
import { decideCapacity } from "../src/lib/billing-capacity";

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
const show = (x: unknown) => JSON.stringify(x);

const NOW = Date.parse("2026-09-25T10:00:00.000Z");
const UTC = { now: NOW, timeZone: "UTC" };
const H = 3_600_000;
const D = 24 * H;
const iso = (ms: number) => new Date(ms).toISOString();
const trial = (endsAt: string | null) => ({
  subscriptionStatus: "trialing",
  trialEndsAt: endsAt,
  planKey: "starter",
});
/** Nothing the customer reads may carry a raw status or a zero countdown. */
const everyString = (s: object) => Object.values(s).filter((v) => typeof v === "string").join(" | ");
const noRawStatus = (s: object) => !/trialing|past_due|incomplete|\b0 days\b/.test(everyString(s));

// ---------------------------------------------------------------------------
console.log("\nactive trial");
{
  const s = describePlanStatus(trial(iso(NOW + 5 * D)), UTC);
  t("kind trial", s.kind === "trial", show(s));
  t('badge "Trial"', s.badge === "Trial");
  t('plan label "Free trial"', s.planLabel === "Free trial");
  t('status line "5 days left"', s.statusLine === "5 days left", s.statusLine);
  t('date line "Trial ends Sep 30, 2026"', s.dateLine === "Trial ends Sep 30, 2026", String(s.dateLine));
  t('dashboard headline "Free trial — 5 days left"', s.trialHeadline === "Free trial — 5 days left");
  t("daysLeft 5", s.daysLeft === 5);
  t("no raw status anywhere", noRawStatus(s), everyString(s));
  const one = describePlanStatus(trial(iso(NOW + 1 * D)), UTC);
  t('singular: "1 day left"', one.statusLine === "1 day left", one.statusLine);
  const noEnd = describePlanStatus(trial(null), UTC);
  t("a trial with no end date claims no date and no countdown", noEnd.kind === "trial" && noEnd.dateLine === null && noEnd.daysLeft === null, show(noEnd));
}

// ---------------------------------------------------------------------------
console.log("\ntrial ends today");
{
  const s = describePlanStatus(trial(iso(NOW + 5 * H)), UTC);
  t("kind trial_ends_today", s.kind === "trial_ends_today", show(s));
  t('badge "Trial ends today"', s.badge === "Trial ends today");
  t('status line "Ends today"', s.statusLine === "Ends today");
  t('date line "Trial ends today (Sep 25, 2026)"', s.dateLine === "Trial ends today (Sep 25, 2026)", String(s.dateLine));
  t('dashboard headline "Free trial — ends today"', s.trialHeadline === "Free trial — ends today");
  t("never \"0 days left\"", noRawStatus(s), everyString(s));
  // "Today" is the viewer's calendar day: 20:00 UTC is already tomorrow in Tokyo.
  const tokyo = describePlanStatus(trial(iso(NOW + 10 * H)), { now: NOW, timeZone: "Asia/Tokyo" });
  t("in Tokyo the same instant is tomorrow: 1 day left", tokyo.kind === "trial" && tokyo.daysLeft === 1, show(tokyo));
}

// ---------------------------------------------------------------------------
console.log("\ntrial ended");
{
  // The live case from the browser check: trial_ends_at 2026-07-03.
  const s = describePlanStatus(trial("2026-07-03T12:00:00.000Z"), UTC);
  t("kind trial_ended", s.kind === "trial_ended", show(s));
  t('badge "Trial ended"', s.badge === "Trial ended");
  t('plan label "No active plan"', s.planLabel === "No active plan");
  t('status line "Free trial ended on Jul 3, 2026"', s.statusLine === "Free trial ended on Jul 3, 2026", s.statusLine);
  t("no separate date line repeating it", s.dateLine === null);
  t("dashboard headline says it ended", s.trialHeadline === "Free trial ended on Jul 3, 2026");
  t("no countdown", s.daysLeft === null);
  t('no "trialing", no "Trial ends", no "0 days"', noRawStatus(s) && !/Trial ends/.test(everyString(s)), everyString(s));
  const earlierToday = describePlanStatus(trial(iso(NOW - 2 * H)), UTC);
  t("ended earlier today reads ended, dated today", earlierToday.statusLine === "Free trial ended on Sep 25, 2026", show(earlierToday));
  const exactly = describePlanStatus(trial(iso(NOW)), UTC);
  t("ending at this very instant counts as ended (billing: now >= end)", exactly.kind === "trial_ended");
  const verdict = describePlanStatus(
    { ...trial(iso(NOW + 5 * D)), billingState: "trial_expired" },
    UTC,
  );
  t("the server's billingState wins when given", verdict.kind === "trial_ended");
}

// ---------------------------------------------------------------------------
console.log("\npaid plan");
{
  const s = describePlanStatus(
    { subscriptionStatus: "active", trialEndsAt: "2026-07-03T12:00:00.000Z", currentPeriodEnd: "2026-10-20T00:00:00.000Z", planKey: "growth" },
    UTC,
  );
  t("kind paid", s.kind === "paid", show(s));
  t('badge is the plan name "Growth"', s.badge === "Growth");
  t('plan label "Growth"', s.planLabel === "Growth");
  t('status line "Active" (not "active")', s.statusLine === "Active");
  t('date line "Renews Oct 20, 2026"', s.dateLine === "Renews Oct 20, 2026", String(s.dateLine));
  t("an old trial date on a paid plan is ignored", !/trial/i.test(everyString(s)), everyString(s));
  const pastDue = describePlanStatus(
    { subscriptionStatus: "past_due", trialEndsAt: null, currentPeriodEnd: iso(NOW - D), planKey: "scale" },
    UTC,
  );
  t('past_due reads "Payment past due" and claims no renewal', pastDue.statusLine === "Payment past due" && pastDue.dateLine === null, show(pastDue));
  t("statuses are words, never codes", subscriptionStatusLabel("canceled") === "Cancelled" && subscriptionStatusLabel("incomplete_expired") === "Checkout expired" && subscriptionStatusLabel("something_new") === "Needs attention");
  t("plan names come from the catalog, legacy keys are title-cased", planDisplayName("pro") === "Pro" && planDisplayName("enterprise") === "Enterprise" && planDisplayName(null) === "");
}

// ---------------------------------------------------------------------------
console.log("\nbeta");
{
  const s = describePlanStatus(
    { ...trial("2026-07-03T12:00:00.000Z"), inBeta: true, betaExpiresAt: "2026-12-31T00:00:00.000Z" },
    UTC,
  );
  t("kind beta, even over an expired trial", s.kind === "beta", show(s));
  t('badge "Beta"', s.badge === "Beta");
  t('plan label "Free beta"', s.planLabel === "Free beta");
  t('status line "No charge"', s.statusLine === "No charge");
  t('date line "Beta access until Dec 31, 2026"', s.dateLine === "Beta access until Dec 31, 2026", String(s.dateLine));
  t("no trial wording for a beta tenant", !/trial/i.test(everyString(s)), everyString(s));
  const open = describePlanStatus({ ...trial(null), inBeta: true }, UTC);
  t("an open-ended grant says so", open.dateLine === "Beta access with no end date set");
}

// ---------------------------------------------------------------------------
console.log("\none date format, one rule");

t('formatPlanDate prints "Jul 3, 2026"', formatPlanDate("2026-07-03T12:00:00.000Z", "UTC") === "Jul 3, 2026");
t(
  "formatPlanDate uses the viewer's calendar day",
  formatPlanDate("2026-07-03T02:00:00.000Z", "America/Los_Angeles") === "Jul 2, 2026",
);
t("formatPlanDate is empty for junk", formatPlanDate("nope") === "" && formatPlanDate(null) === "");
{
  let agree = true;
  const bad: string[] = [];
  for (let offsetH = -72; offsetH <= 72; offsetH += 1) {
    const end = iso(NOW + offsetH * H);
    const ended = describePlanStatus(trial(end), UTC).kind === "trial_ended";
    const billing = decideCapacity({ subscriptionStatus: "trialing", trialEndsAt: end, currentPeriodEnd: null }, NOW).state === "trial_expired";
    if (ended !== billing) {
      agree = false;
      bad.push(`${offsetH}h`);
    }
  }
  t("\"ended\" agrees with decideCapacity at every hour from -72h to +72h", agree, bad.join(","));
}

// ---------------------------------------------------------------------------
console.log("\nthe screens use it");

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const billing = read("src/routes/_authenticated/app.billing.tsx");
const dash = read("src/routes/_authenticated/app.index.tsx");
const shell = read("src/routes/_authenticated/app.tsx");

t("billing words the plan card with describePlanStatus", /describePlanStatus\(\{[\s\S]*billingState: ent\.billingState/.test(billing));
t("billing no longer prints the raw subscription status", !/\{[^}]*ent\??\.subscriptionStatus[^}]*\}\s*<\/div>/.test(billing) && !/"no charge" : \(ent\?\.subscriptionStatus/.test(billing));
t('billing no longer says "Trial ends" from its own date math', !/Trial ends \{new Date/.test(billing));
t("billing says an ended trial's pages are paused, not deleted", /kind === "trial_ended"[\s\S]{0,80}paused, not deleted/.test(billing));
t("dashboard words the trial card with describePlanStatus", /describePlanStatus\(/.test(dash) && /\{planStatus\.trialHeadline\}/.test(dash));
t("dashboard no longer counts days with its own Math.ceil", !/Math\.ceil/.test(dash) && !/day\{daysLeft === 1/.test(dash));
t("dashboard shows the card for an ended trial too", /\(trialRunning \|\| trialEnded\) &&/.test(dash));
t("shell badge comes from describePlanStatus", /\{planStatus\.badge\}/.test(shell) && !/subscription_status === "trialing"\s*\?\s*"Trial"/.test(shell));
for (const [name, src] of [["billing", billing], ["dashboard", dash]] as const) {
  t(`${name} formats every date one way (no toLocaleDateString)`, !/toLocaleDateString/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
