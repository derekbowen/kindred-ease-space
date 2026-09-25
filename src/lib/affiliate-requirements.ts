/**
 * THE AFFILIATE ADD-ON NEEDS THE INTEGRATION API CONNECTION.
 *
 * Referral tracking reads the marketplace's transactions, and the referral
 * code in each referred user's private data, through Sharetribe's Integration
 * API (src/lib/affiliate-sync.server.ts). The read-only Marketplace API
 * connection — the default since the launch — can read neither, so on it the
 * add-on tracks nothing, attributes nothing and accrues no payout. Round-4
 * release review M1: it was sold and trialled there anyway, and "Run sync now"
 * answered "try again in a few minutes" forever.
 *
 * So the trial (startAffiliateTrial) and the checkout (create-checkout, add-on
 * mode) refuse unless the workspace's Sharetribe connection uses the
 * Integration API, and every surface that sells the add-on says so. The
 * sentences are mirrored for the edge function in
 * supabase/functions/_shared/affiliate-requirement.ts
 * (tests/affiliate-integration-requirement.test.ts keeps the two identical).
 *
 * Pure and dependency-free: safe in the browser, in SSR and in tests.
 */

/** How a workspace is connected to Sharetribe, as far as the add-on cares. */
export type SharetribeConnectionMode = "integration" | "marketplace" | "none";

/** Connected, but through the read-only Marketplace API. */
export const AFFILIATE_RECONNECT_MESSAGE =
  "Referral tracking needs the Integration API connection. Reconnect under Settings → Sharetribe → Integration API (Advanced).";

/** Not connected to Sharetribe at all. */
export const AFFILIATE_CONNECT_MESSAGE =
  "Referral tracking needs the Integration API connection. Connect your marketplace under Settings → Sharetribe → Integration API (Advanced).";

/** The requirement, stated wherever the add-on is offered. */
export const AFFILIATE_REQUIREMENT_NOTE =
  "Requires the Sharetribe Integration API connection (Settings → Sharetribe → Integration API, Advanced). The default read-only Marketplace API connection can't read transactions.";

/** Where the connection is changed. */
export const SHARETRIBE_SETTINGS_PATH = "/app/settings/integrations/sharetribe";

/**
 * Rows created before auth_mode existed are Integration API connections
 * (see sharetribe-sync.server.ts), so anything but "marketplace" is one.
 */
export function connectionModeOf(
  row: { auth_mode?: string | null } | null | undefined,
): SharetribeConnectionMode {
  if (!row) return "none";
  return row.auth_mode === "marketplace" ? "marketplace" : "integration";
}

/** The customer sentence for a connection the add-on cannot use, or null. */
export function affiliateConnectionProblem(mode: SharetribeConnectionMode): string | null {
  if (mode === "integration") return null;
  return mode === "marketplace" ? AFFILIATE_RECONNECT_MESSAGE : AFFILIATE_CONNECT_MESSAGE;
}
