/**
 * Canonical URL helper — single source of truth for the production hostname.
 * Every <link rel="canonical">, og:url, twitter:url, sitemap entry, and outbound
 * absolute link to our own site MUST be built through these helpers.
 *
 * The audit script (scripts/audit-canonical-urls.ts) and the live crawl audit
 * (src/lib/admin-canonical-audit.functions.ts) both enforce this.
 */

export const CANONICAL_ORIGIN = "https://www.founders.click";

/** Hosts that are NEVER allowed in shipped HTML. */
export const FORBIDDEN_HOSTS = [
  // Apex without www — should 301 to www at the edge, but never appear in HTML.
  "founders.click",
  // Any preview / staging host.
  "lovable.app",
  "lovable-project.com",
];

/**
 * Hosts that may appear in HTML even though they aren't `www.founders.click`.
 * Keep this list short and reviewed.
 */
export const ALLOWED_EXTERNAL_HOSTS = [
  // OG image / static asset CDN (Cloudflare R2 public bucket).
  "pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev",
  // Supabase data plane (auth, storage, edge functions).
  "xbxhzinnfhosoztqaaao.supabase.co",
  // Schema.org and other well-known metadata vocabularies.
  "schema.org",
];

/** Build an absolute canonical URL from a path (leading slash recommended). */
export function canonicalUrl(path: string = "/"): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${CANONICAL_ORIGIN}${normalized}`;
}

/** True if `url` is canonical (matches www.founders.click) or relative. */
export function isCanonicalUrl(url: string): boolean {
  if (!url) return false;
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  if (url.startsWith("#") || url.startsWith("mailto:") || url.startsWith("tel:")) return true;
  try {
    const u = new URL(url);
    return u.origin === CANONICAL_ORIGIN;
  } catch {
    return false;
  }
}

export type UrlClassification =
  "canonical" | "apex" | "preview" | "external-allowed" | "external" | "invalid";

/** Classify any URL string for audit reporting. */
export function classifyUrl(url: string): UrlClassification {
  if (!url) return "invalid";
  if (url.startsWith("/") && !url.startsWith("//")) return "canonical";
  if (url.startsWith("#") || url.startsWith("mailto:") || url.startsWith("tel:"))
    return "canonical";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "invalid";
  }
  if (u.origin === CANONICAL_ORIGIN) return "canonical";
  const host = u.hostname.toLowerCase();
  if (host === "founders.click") return "apex";
  if (host.endsWith(".lovable.app") || host.endsWith(".lovable-project.com")) return "preview";
  if (ALLOWED_EXTERNAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)))
    return "external-allowed";
  return "external";
}
