/**
 * DOMAIN STATUS WORDING — the same two facts on Workspace Settings and on
 * Settings → Domains.
 *
 * A connected domain has two separate facts: whether we have proved the
 * customer owns it, and whether its certificate is ready. Workspace Settings
 * showed "Verified" (ownership) while Domains showed "Issuing SSL"
 * (certificate) for the same hostname, which read as a contradiction. Both
 * screens now print both facts, e.g. "Ownership verified · Certificate
 * issuing". Wording only: the statuses and their transitions are
 * src/lib/admin-domains.functions.ts's and are unchanged.
 *
 * Status → facts (from the launch provisioning flow):
 *   verification_required / pending  ownership not proven yet
 *   verified (legacy rows)           proven; no certificate requested yet
 *   dns_configuration_required       proven; the certificate (HTTP-validated)
 *                                    waits for DNS to point at the edge
 *   provisioning / ssl_pending       proven; certificate being issued
 *   active                           proven; certificate ready and serving
 *   error                            setup stalled (ownership per `verified`)
 *   disconnected                     no longer connected
 */

export type DomainTone = "ok" | "warn" | "muted";

export type DomainStatusFacts = {
  ownershipVerified: boolean;
  /** The certificate half, or null when it does not apply. */
  certificate: string | null;
  /** "Ownership verified · Certificate issuing" */
  label: string;
  tone: DomainTone;
};

const OWNERSHIP_VERIFIED = "Ownership verified";
const OWNERSHIP_UNVERIFIED = "Ownership not verified";

function facts(ownershipVerified: boolean, certificate: string | null, tone: DomainTone): DomainStatusFacts {
  const ownership = ownershipVerified ? OWNERSHIP_VERIFIED : OWNERSHIP_UNVERIFIED;
  return {
    ownershipVerified,
    certificate,
    label: certificate ? `${ownership} · ${certificate}` : ownership,
    tone,
  };
}

export function describeDomainStatus(
  status: string | null | undefined,
  verified: boolean | null | undefined,
): DomainStatusFacts {
  switch ((status ?? "").trim().toLowerCase()) {
    case "verification_required":
    case "pending":
      return facts(false, null, "warn");
    case "verified":
      return facts(true, "Certificate not requested yet", "warn");
    case "dns_configuration_required":
      return facts(true, "Certificate waiting for DNS", "warn");
    case "provisioning":
    case "ssl_pending":
      return facts(true, "Certificate issuing", "warn");
    case "active":
      return facts(true, "Certificate ready", "ok");
    case "error":
      return facts(Boolean(verified), "Setup needs attention", "warn");
    case "disconnected":
      return { ownershipVerified: Boolean(verified), certificate: null, label: "Disconnected", tone: "muted" };
    default:
      return facts(Boolean(verified), null, verified ? "ok" : "warn");
  }
}

export type DomainConnectionMode = "full_proxy" | "subdomain" | "customer_proxy";

/** The connection mode's name, shared by the mode picker and each domain row. */
export const DOMAIN_MODE_NAME: Record<DomainConnectionMode, string> = {
  full_proxy: "Root domain",
  subdomain: "Subdomain",
  customer_proxy: "My own proxy/CDN",
};

/**
 * A connected domain's mode, described with its OWN hostname: "Subdomain ·
 * seo.example.com/a/…". The generic picker labels ("Subdomain
 * (seo.yourdomain.com)") are examples for choosing a mode and are never used
 * to describe a domain that exists.
 */
export function domainModeLabel(mode: string | null | undefined, hostname: string): string {
  const key = (mode ?? "full_proxy") as DomainConnectionMode;
  const name = DOMAIN_MODE_NAME[key] ?? DOMAIN_MODE_NAME.full_proxy;
  return `${name} · ${hostname}/a/…`;
}

/** Host as the customer may have typed it: no scheme, path, port, trailing dot; lower case. */
export function normalizeDomainInput(input: string | null | undefined): string {
  return (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

/**
 * Which connected domain Workspace Settings should describe next to the
 * marketplace domain: the row for that exact hostname, else the most recent
 * row that is still connected. Rows arrive newest first (listWorkspaceDomains).
 */
export function pickDomainForSettings<T extends { hostname: string; status: string }>(
  rows: T[],
  marketplaceDomain: string | null | undefined,
): T | null {
  const want = normalizeDomainInput(marketplaceDomain);
  const live = rows.filter((r) => r.status !== "disconnected");
  if (want) {
    const exact = live.find((r) => normalizeDomainInput(r.hostname) === want);
    if (exact) return exact;
  }
  return live[0] ?? null;
}
