// The Affiliate add-on needs the Sharetribe Integration API connection: its
// referral tracking reads transactions and the referred users' private data,
// which the read-only Marketplace API connection (the default) cannot. The
// checkout refuses the add-on on any other connection (round-4 release review
// M1). The sentences mirror src/lib/affiliate-requirements.ts, which the app
// shows and startAffiliateTrial enforces;
// tests/affiliate-integration-requirement.test.ts keeps the two identical.

export const AFFILIATE_RECONNECT_MESSAGE =
  "Referral tracking needs the Integration API connection. Reconnect under Settings → Sharetribe → Integration API (Advanced).";

export const AFFILIATE_CONNECT_MESSAGE =
  "Referral tracking needs the Integration API connection. Connect your marketplace under Settings → Sharetribe → Integration API (Advanced).";

/** Every affiliate tier (affiliate-lite, affiliate-standard, affiliate-pro). */
export function isAffiliateAddonKey(key: unknown): boolean {
  return typeof key === "string" && key.startsWith("affiliate-");
}

/**
 * The refusal for a workspace's Sharetribe connection row (null = not
 * connected), or null when the add-on can work on it. Rows created before
 * auth_mode existed are Integration API connections.
 */
export function affiliateConnectionRefusal(
  row: { auth_mode?: string | null } | null | undefined,
): string | null {
  if (!row) return AFFILIATE_CONNECT_MESSAGE;
  return row.auth_mode === "marketplace" ? AFFILIATE_RECONNECT_MESSAGE : null;
}
