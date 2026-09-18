/**
 * WHAT A WORKSPACE IS ENTITLED TO, DERIVED RATHER THAN REMEMBERED.
 *
 * The product is published-page capacity on the customer's own domain. The
 * promise that makes it a subscription rather than a purchase is that the
 * pages stop when paying stops.
 *
 * Until now that promise rested entirely on a Stripe webhook arriving and
 * writing `page_limit_base` down. Three things follow from that design, all
 * of them bad:
 *
 *   - A missed or failed webhook leaves the old entitlement in place forever.
 *     Nothing sweeps `stripe_webhook_events` rows stuck in error, so a
 *     cancelled customer keeps free hosting indefinitely and nobody learns.
 *   - `trial_ends_at` was written and displayed but never compared to now(),
 *     so a trial kept its capacity indefinitely.
 *   - The public serving path never consulted billing at all. Published pages
 *     kept rendering on the customer's domain after cancellation.
 *
 * This module makes entitlement a *function of the billing facts* evaluated
 * at read time, so a webhook that never arrives can no longer mean "granted
 * forever". Stripe remains the authority on those facts; this only decides
 * what they mean.
 *
 * Fail-safe direction matters and is deliberately asymmetric: when we are
 * confident the customer has lapsed, we stop serving. When we are unsure —
 * an unrecognised status, a missing column — we keep serving and say so.
 * Taking a paying customer's site down over a null is worse than carrying a
 * free rider until a human looks.
 */

/** Days after `current_period_end` that we keep serving while Stripe retries. */
export const PAST_DUE_GRACE_DAYS = 7;

/**
 * How stale `current_period_end` may get on a supposedly-live subscription
 * before we stop believing it. Every plan bills monthly, so a period end more
 * than this far in the past means we stopped hearing from Stripe — the missed
 * webhook case. Generous enough to absorb a late renewal, short enough that
 * free hosting is measured in weeks rather than never.
 */
export const STALE_PERIOD_DAYS = 45;

export type BillingFacts = {
  subscriptionStatus: string | null | undefined;
  trialEndsAt: string | null | undefined;
  currentPeriodEnd: string | null | undefined;
  /**
   * Total pages granted by a platform admin and active right now — the sum of
   * `workspace_entitlement_grants.page_limit` over unrevoked, started,
   * unexpired rows. Free beta and test accounts carry no Stripe object at all,
   * so without this every one of them would read as "no subscription" and be
   * refused publishing no matter how large the grant.
   */
  grantedPages?: number | null;
};

export type BillingState =
  | "active" // paying, in good standing
  | "trialing" // trial running, not yet expired
  | "trial_expired" // trial ended, never converted
  | "granted" // no usable Stripe state, but an admin grant is active
  | "grace" // payment failing, still inside the retry window
  | "lapsed" // cancelled, unpaid, or past the grace window
  | "stale" // status says live but Stripe has gone quiet past a full cycle
  | "unknown"; // unrecognised or absent — fail open, flag loudly

export type CapacityDecision = {
  state: BillingState;
  /** Whether already-published pages should keep rendering on the customer's domain. */
  serve: boolean;
  /** Whether new pages may be published. Never true when `serve` is false. */
  publish: boolean;
  /** Operator- and customer-safe explanation. */
  reason: string;
};

function parseDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

const DAY_MS = 86_400_000;

/**
 * The Stripe half of the decision: what the subscription alone would allow,
 * ignoring any admin grant. Kept separate so `decideCapacity` can ask "would
 * Stripe have refused this?" without re-deriving it, and so paid capacity can
 * be counted only when Stripe itself says the workspace may publish.
 *
 * `now` is injectable so the rules are testable without freezing clocks.
 */
function stripeCapacity(facts: BillingFacts, now: number = Date.now()): CapacityDecision {
  const status = (facts.subscriptionStatus ?? "").trim().toLowerCase();
  const trialEnds = parseDate(facts.trialEndsAt);
  const periodEnd = parseDate(facts.currentPeriodEnd);

  const serveAll = (state: BillingState, reason: string): CapacityDecision => ({
    state,
    serve: true,
    publish: true,
    reason,
  });
  const serveOnly = (state: BillingState, reason: string): CapacityDecision => ({
    state,
    serve: true,
    publish: false,
    reason,
  });
  const stop = (state: BillingState, reason: string): CapacityDecision => ({
    state,
    serve: false,
    publish: false,
    reason,
  });

  switch (status) {
    case "active": {
      // A live monthly subscription whose period ended well over a cycle ago
      // means the renewal webhook never landed. Believing the stored status
      // here is exactly how a cancelled customer keeps free hosting forever.
      if (periodEnd !== null && now - periodEnd > STALE_PERIOD_DAYS * DAY_MS) {
        return stop(
          "stale",
          `Subscription reads active but its billing period ended ${Math.floor(
            (now - periodEnd) / DAY_MS,
          )} days ago. Stripe has not been heard from for over a cycle; treating as lapsed until reconciled.`,
        );
      }
      return serveAll("active", "Subscription active.");
    }

    case "trialing": {
      if (trialEnds === null) {
        // Trialing with no end date is not a trial, it is an oversight. Serve,
        // but do not let it quietly become permanent free capacity.
        return serveOnly(
          "unknown",
          "Workspace is trialing with no trial end date. Serving, but publishing is paused until billing is resolved.",
        );
      }
      if (now >= trialEnds) {
        return stop("trial_expired", "Free trial has ended. Subscribe to restore your pages.");
      }
      return serveAll("trialing", "Free trial running.");
    }

    case "past_due": {
      // Stripe is still retrying the card. Keep the customer's site up through
      // the retry window — their pages going dark is the most destructive
      // possible response to a temporarily declined card — but stop new
      // publishing so the bill cannot grow while it is unpaid.
      const deadline = (periodEnd ?? now) + PAST_DUE_GRACE_DAYS * DAY_MS;
      if (now < deadline) {
        return serveOnly(
          "grace",
          `Payment failed and is being retried. Pages stay up until ${new Date(deadline)
            .toISOString()
            .slice(0, 10)}; publishing is paused until payment succeeds.`,
        );
      }
      return stop("lapsed", "Payment failed and the retry window has closed.");
    }

    case "canceled":
    case "cancelled": {
      // A cancellation is paid through the end of the period already bought.
      if (periodEnd !== null && now < periodEnd) {
        return serveOnly(
          "grace",
          `Subscription cancelled. Pages stay up until the paid period ends on ${new Date(periodEnd)
            .toISOString()
            .slice(0, 10)}.`,
        );
      }
      return stop("lapsed", "Subscription cancelled and the paid period has ended.");
    }

    case "unpaid":
      return stop("lapsed", "Subscription unpaid after Stripe exhausted its retries.");

    case "incomplete":
    case "incomplete_expired":
      return stop("lapsed", "Subscription was never completed — no successful payment.");

    case "paused":
      return stop("lapsed", "Subscription paused.");

    case "":
      // No status at all. Almost always a workspace provisioned before billing
      // ran. Fail open: we have no evidence of non-payment, only of silence.
      return serveOnly(
        "unknown",
        "No subscription status recorded. Serving existing pages; publishing paused until billing is resolved.",
      );

    default:
      return serveOnly(
        "unknown",
        `Unrecognised subscription status "${status}". Serving existing pages; publishing paused pending review.`,
      );
  }
}

/** Grants are whole pages; a negative or fractional grant is a data error, not a credit. */
export function normalizeGrantedPages(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * Decide what a workspace may do, from its billing facts AND any active admin
 * grant.
 *
 * A grant is additive and rescuing: it adds capacity to a paying workspace, and
 * it restores serving and publishing to one Stripe would refuse. That is what
 * makes a free beta account behave like a real entitled customer rather than
 * needing a hidden bypass somewhere in the serving path.
 *
 * It is deliberately NOT a downgrade: a grant never reduces what a paying
 * customer already has, because the paid and granted components are summed
 * rather than compared.
 *
 * Mirrored in SQL by public.workspace_capacity(); tests/entitlement-grants.test.ts
 * asserts the two agree for every state.
 */
export function decideCapacity(facts: BillingFacts, now: number = Date.now()): CapacityDecision {
  const stripe = stripeCapacity(facts, now);
  const granted = normalizeGrantedPages(facts.grantedPages);
  if (granted === 0) return stripe;
  if (stripe.publish) {
    // Already entitled through Stripe. The grant still adds pages — see
    // effectivePageLimit — but the state stays the commercial one, because
    // "Subscription active" is the true and more useful thing to tell them.
    return stripe;
  }
  return {
    state: "granted",
    serve: true,
    publish: true,
    reason:
      `Complimentary access granted by founders.click (${granted} page${granted === 1 ? "" : "s"}).` +
      (stripe.state === "unknown" ? "" : ` Commercial status: ${stripe.state}.`),
  };
}

/**
 * The page limit actually in force, given the stored limits and the billing
 * facts. A workspace that may not publish has no capacity, whatever its
 * columns say — which is what stops a missed webhook from reading as a grant.
 */
export function effectivePageLimit(
  stored: { base: number; addon: number; bonus: number; granted?: number | null },
  decision: CapacityDecision,
): number {
  const granted = normalizeGrantedPages(stored.granted);
  // ADDITIVE, never greater-of. Paid capacity counts only while Stripe itself
  // says the workspace may publish — the `granted` state is produced exactly
  // when Stripe refused, so paid contributes nothing there and the grant is the
  // whole allowance. A lapsed plan plus a 50-page grant is 50 pages, not 50
  // plus whatever page_limit_base happens to still say.
  const stripeEntitled = decision.publish && decision.state !== "granted";
  const paid = stripeEntitled ? stored.base + stored.addon + stored.bonus : 0;
  return paid + granted;
}
