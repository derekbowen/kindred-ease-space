/**
 * PLAN AND TRIAL WORDING — one source for the billing page, the dashboard
 * card and the app-shell badge.
 *
 * An expired trial keeps subscription_status = 'trialing' (no Stripe object
 * ever changes it), so every screen that printed the raw status told the
 * customer "Free trial · trialing · Trial ends 7/3/2026" right beside "Free
 * trial has ended", and the dashboard said "Trial — 0 days left". Whether a
 * trial has ended is decided exactly where billing decides it — decideCapacity
 * in src/lib/billing-capacity.ts (ended once now >= trial_ends_at) — and this
 * module only words the answer. It changes no billing semantics.
 *
 * Pure and clock-injectable: tests/plan-status.test.ts covers an active trial,
 * one ending today, an ended one, a paid plan and the beta.
 */
import { decideCapacity, type BillingState } from "@/lib/billing-capacity";
import { planByKey } from "@/lib/plan-catalog";

export type PlanStatusKind = "beta" | "trial" | "trial_ends_today" | "trial_ended" | "paid";

export type PlanStatusInput = {
  subscriptionStatus: string | null | undefined;
  trialEndsAt: string | null | undefined;
  currentPeriodEnd?: string | null;
  /** The plan key stored on the workspace ('starter', 'growth', …). */
  planKey?: string | null;
  /** A free-beta grant is the entitlement (see readBetaStatus / the billing page's inBeta). */
  inBeta?: boolean;
  betaExpiresAt?: string | null;
  /**
   * The server's verdict when the caller has it (PageEntitlement.billingState).
   * Without it the state is derived from the same facts by decideCapacity.
   */
  billingState?: BillingState;
};

export type PlanStatus = {
  kind: PlanStatusKind;
  /** App-shell badge. */
  badge: string;
  /** The big line on the billing page's "Current plan" card. */
  planLabel: string;
  /** One line under it. Never a raw Stripe status. */
  statusLine: string;
  /** A second line with the relevant date, when there is one. */
  dateLine: string | null;
  /** Dashboard card headline for a trial (null outside a trial). */
  trialHeadline: string | null;
  /** Whole calendar days left in a running trial (0 = ends today); null otherwise. */
  daysLeft: number | null;
};

export type WordingOptions = {
  now?: number;
  /** IANA zone for dates and for "today". Defaults to the viewer's own. */
  timeZone?: string;
};

/**
 * The one date format for billing and trial wording: "Jul 3, 2026". Month
 * spelled out, so 7/3 can never be read as the 7th of March.
 */
export function formatPlanDate(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(d);
}

/** Calendar-day index of an instant in a zone, for "today" / "n days left". */
function dayNumber(ms: number, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Math.round(Date.UTC(get("year"), get("month") - 1, get("day")) / 86_400_000);
}

/** "growth" → "Growth": the catalog name, or the stored key title-cased. */
export function planDisplayName(planKey: string | null | undefined): string {
  const key = (planKey ?? "").trim();
  if (!key) return "";
  return planByKey(key)?.name ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** Customer words for a subscription status. Unknown values get a neutral phrase, never the raw code. */
export function subscriptionStatusLabel(status: string | null | undefined): string {
  switch ((status ?? "").trim().toLowerCase()) {
    case "active":
      return "Active";
    case "trialing":
      return "Free trial";
    case "past_due":
      return "Payment past due";
    case "canceled":
    case "cancelled":
      return "Cancelled";
    case "unpaid":
      return "Unpaid";
    case "incomplete":
      return "Payment incomplete";
    case "incomplete_expired":
      return "Checkout expired";
    case "paused":
      return "Paused";
    case "":
      return "No plan yet";
    default:
      return "Needs attention";
  }
}

export function describePlanStatus(input: PlanStatusInput, opts: WordingOptions = {}): PlanStatus {
  const now = opts.now ?? Date.now();
  const tz = opts.timeZone;
  const planName = planDisplayName(input.planKey);

  // Same rule as every other beta surface: "Free beta" only when the caller
  // established that the grant IS the entitlement.
  if (input.inBeta) {
    return {
      kind: "beta",
      badge: "Beta",
      planLabel: "Free beta",
      statusLine: "No charge",
      dateLine: input.betaExpiresAt
        ? `Beta access until ${formatPlanDate(input.betaExpiresAt, tz)}`
        : "Beta access with no end date set",
      trialHeadline: null,
      daysLeft: null,
    };
  }

  const state =
    input.billingState ??
    decideCapacity(
      {
        subscriptionStatus: input.subscriptionStatus,
        trialEndsAt: input.trialEndsAt,
        currentPeriodEnd: input.currentPeriodEnd ?? null,
      },
      now,
    ).state;
  const isTrial = (input.subscriptionStatus ?? "").trim().toLowerCase() === "trialing";

  if (state === "trial_expired") {
    const ended = formatPlanDate(input.trialEndsAt, tz);
    const line = ended ? `Free trial ended on ${ended}` : "Free trial ended";
    return {
      kind: "trial_ended",
      badge: "Trial ended",
      planLabel: "No active plan",
      statusLine: line,
      dateLine: null,
      trialHeadline: line,
      daysLeft: null,
    };
  }

  if (isTrial) {
    const ends = input.trialEndsAt ? Date.parse(input.trialEndsAt) : NaN;
    if (Number.isFinite(ends) && ends > now) {
      const daysLeft = Math.max(0, dayNumber(ends, tz) - dayNumber(now, tz));
      const date = formatPlanDate(input.trialEndsAt, tz);
      if (daysLeft === 0) {
        return {
          kind: "trial_ends_today",
          badge: "Trial ends today",
          planLabel: "Free trial",
          statusLine: "Ends today",
          dateLine: `Trial ends today (${date})`,
          trialHeadline: "Free trial — ends today",
          daysLeft: 0,
        };
      }
      const left = `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;
      return {
        kind: "trial",
        badge: "Trial",
        planLabel: "Free trial",
        statusLine: left,
        dateLine: `Trial ends ${date}`,
        trialHeadline: `Free trial — ${left}`,
        daysLeft,
      };
    }
    // Trialing with no end date: decideCapacity serves it and pauses
    // publishing; there is no date to count down to.
    return {
      kind: "trial",
      badge: "Trial",
      planLabel: "Free trial",
      statusLine: "Free trial",
      dateLine: null,
      trialHeadline: "Free trial",
      daysLeft: null,
    };
  }

  const renews =
    state === "active" && input.currentPeriodEnd
      ? `Renews ${formatPlanDate(input.currentPeriodEnd, tz)}`
      : null;
  // The badge names the plan alone only while the subscription is active. A
  // cancelled or past-due plan showed just "Growth" in the shell, as if all
  // were well (round-4 release review L10); it now says what is wrong.
  const statusLabel = subscriptionStatusLabel(input.subscriptionStatus);
  const healthy = (input.subscriptionStatus ?? "").trim().toLowerCase() === "active";
  return {
    kind: "paid",
    badge: planName ? (healthy ? planName : `${planName} · ${statusLabel}`) : statusLabel,
    planLabel: planName || "—",
    statusLine: statusLabel,
    dateLine: renews,
    trialHeadline: null,
    daysLeft: null,
  };
}
