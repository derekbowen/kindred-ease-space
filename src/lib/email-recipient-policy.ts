/**
 * Recipient policy for every outbound email founders.click sends.
 *
 * WHY THIS EXISTS (2026-09-24 Emailit bounce incident)
 * Scheduled smoke tests sign up throwaway accounts such as
 * `smoke1790285685@example.com` against production every six hours. GoTrue
 * then asks our send-email hook for a confirmation message, the hook hands it
 * to Emailit, and Emailit's delivery attempt bounces — example.com accepts no
 * mail. Every bounce counts against the sending domain's reputation. Two
 * such signups per window, for weeks, is an incident.
 *
 * The fix belongs at the boundary, not in the test: ANY address that can only
 * belong to an automated test must never reach the email provider, whoever
 * signs it up and from wherever. Two layers use this module:
 *   1. sendEmail() in email.server.ts — the single Emailit call site — drops
 *      blocked recipients before building the request.
 *   2. The Supabase auth send-email hook refuses before it even builds copy.
 *
 * WHAT IS BLOCKED
 *   - RFC 2606 / RFC 6761 reserved names that can never receive mail:
 *     example.com/.org/.net/.edu (and any subdomain), the .test, .invalid,
 *     .localhost and .example TLDs, and the bare host "localhost".

 *   - Local parts that identify an automated test user: the tokens "smoke"
 *     (smoke, smoke-test, smoke1790285685, smoke+ci), "test-smoke", "e2e",
 *     "playwright", "cypress", "autotest" and the classic "testuser"/
 *     "test-user"/"test-account" shapes — each only when followed by a
 *     separator, a digit or the end of the local part — plus "+smoke"/"+e2e"
 *     plus-tags on any mailbox.
 *
 * WHAT IS NOT BLOCKED, deliberately: a bare "test@…" local part, ordinary
 * words that merely contain a marker (contest@, latest@, smokey.robinson@,
 * e2eco@). Real people use those. When in doubt this policy lets the mail through — the cost of a
 * bounce is smaller than the cost of silently losing a customer's
 * confirmation email.
 *
 * Pure: no I/O, no env. Safe to import from anywhere.
 */

/** Domains (and their subdomains) reserved for documentation; they never accept mail. */
export const RESERVED_DOMAINS = ["example.com", "example.org", "example.net", "example.edu"] as const;

/** Top-level labels reserved for testing; a host under them never resolves publicly. */
export const RESERVED_TLDS = ["test", "invalid", "localhost", "example"] as const;

/**
 * Local parts that only an automated test user carries. Each pattern is a
 * TOKEN match: the marker must be followed by a separator, a digit, "test"
 * or the end of the local part, so "smoke1790285685", "smoke-test",
 * "smoke+ci" and "smoketest7" are blocked while "smokey.robinson" and
 * "smokehouse-bbq" — real mailboxes — are not.
 */
export const TEST_LOCALPART_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /^smoke(?:[-_]?test)?(?:[-_+.]|\d|$)/, label: "smoke*" },
  { re: /^test[-_]?smoke(?:[-_+.]|\d|$)/, label: "test-smoke*" },
  { re: /^e2e(?:[-_+.]|\d|$)/, label: "e2e*" },
  { re: /^(?:playwright|cypress|autotest|auto-test)(?:[-_+.]|\d|$)/, label: "browser-automation*" },
  { re: /^test[-_]?(?:user|account)(?:[-_+.]|\d|$)/, label: "testuser*" },
];

/** Plus-tags that mark an otherwise real mailbox as a test alias: jane+smoke@, jane+e2e-3@. */
const TEST_PLUS_TAG_RE = /\+(?:smoke|e2e|smoketest|smoke-test|autotest)(?:[-_.+]|\d|$)/;

export type RecipientVerdict =
  | { deliverable: true; address: string }
  | { deliverable: false; address: string; reason: string };

/**
 * Normalise a recipient string to a bare lowercase address. Accepts the
 * display-name form ("Jane <jane@x.com>") because templates and callers
 * pass both. Returns null when no address can be found.
 */
export function normalizeRecipient(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  const angle = s.match(/<([^<>]+)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.toLowerCase();
  if (!s || !s.includes("@")) return null;
  return s;
}

/** Classify one recipient. Never throws. */
export function classifyRecipient(raw: string | null | undefined): RecipientVerdict {
  const address = normalizeRecipient(raw);
  if (!address) {
    return { deliverable: false, address: String(raw ?? ""), reason: "not an email address" };
  }
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at);
  const domain = address.slice(at + 1).replace(/\.$/, "");
  if (!local || !domain) {
    return { deliverable: false, address, reason: "not an email address" };
  }

  for (const reserved of RESERVED_DOMAINS) {
    if (domain === reserved || domain.endsWith("." + reserved)) {
      return { deliverable: false, address, reason: `reserved domain ${reserved}` };
    }
  }
  if (domain === "localhost") {
    return { deliverable: false, address, reason: "reserved host localhost" };
  }
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if ((RESERVED_TLDS as readonly string[]).includes(tld)) {
    return { deliverable: false, address, reason: `reserved top-level domain .${tld}` };
  }

  for (const { re, label } of TEST_LOCALPART_PATTERNS) {
    if (re.test(local)) {
      return { deliverable: false, address, reason: `automated test user (${label})` };
    }
  }
  if (TEST_PLUS_TAG_RE.test(local)) {
    return { deliverable: false, address, reason: "automated test alias (+smoke/+e2e)" };
  }

  return { deliverable: true, address };
}

/** True when this address must never be handed to the email provider. */
export function isBlockedTestRecipient(raw: string | null | undefined): boolean {
  return !classifyRecipient(raw).deliverable;
}

/**
 * Split a recipient list into what may be sent and what must be dropped.
 * Order is preserved; duplicates are kept as given (the provider dedupes).
 */
export function partitionRecipients(to: string | string[]): {
  deliverable: string[];
  blocked: Array<{ address: string; reason: string }>;
} {
  const list = Array.isArray(to) ? to : [to];
  const deliverable: string[] = [];
  const blocked: Array<{ address: string; reason: string }> = [];
  for (const raw of list) {
    const v = classifyRecipient(raw);
    if (v.deliverable) deliverable.push(raw);
    else blocked.push({ address: v.address, reason: v.reason });
  }
  return { deliverable, blocked };
}

/**
 * What to put in a log line about a blocked recipient: the domain and the
 * reason, never the full mailbox. Addresses in logs are how test data leaks
 * into places it should not be.
 */
export function describeBlocked(b: { address: string; reason: string }): string {
  const at = b.address.lastIndexOf("@");
  const domain = at >= 0 ? b.address.slice(at + 1) : "(no domain)";
  return `@${domain} (${b.reason})`;
}
