/**
 * Response security headers, applied to every response by the Worker entry
 * (src/server.ts). Pure so the policy is unit-testable without a Worker.
 *
 * Scope matters here because one Worker serves two very different things:
 *  - the platform (marketing site + dashboard) on founders.click, and
 *  - customers' published pages on their own hostnames, proxied by the edge
 *    Worker to /a/... paths.
 * Frame protection and HSTS are therefore platform-only: a customer may
 * legitimately embed their own hosted pages elsewhere, and an HSTS header on
 * a hostname we do not own would pin that hostname to HTTPS on our say-so.
 */
export const PLATFORM_HOSTS: ReadonlySet<string> = new Set(["founders.click", "www.founders.click"]);

const TENANT_PATH_PREFIXES = ["/a/", "/p/", "/s/", "/apply/"];

export function isTenantPath(pathname: string): boolean {
  return TENANT_PATH_PREFIXES.some((p) => pathname.startsWith(p));
}

export function securityHeadersFor(url: URL): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
  if (!isTenantPath(url.pathname)) {
    headers["X-Frame-Options"] = "DENY";
  }
  // No includeSubDomains: notify.www.founders.click and other subdomains are
  // delegated to third parties whose TLS posture we do not control.
  if (PLATFORM_HOSTS.has(url.hostname)) {
    headers["Strict-Transport-Security"] = "max-age=31536000";
  }
  return headers;
}

/** The one origin the platform answers on; everything else 301s here. */
export const PLATFORM_CANONICAL_HOST = "www.founders.click";

/** Machine callbacks (pg_cron sync fan-out, Supabase auth hook, ops probes). */
const NEVER_REDIRECT_PREFIXES = ["/api/public/hooks/"];

/**
 * Where a platform request must go instead, or null to serve it as is.
 *
 * Production served http://www.founders.click with a 200 and no redirect, and
 * the apex answered with a 302. For the PLATFORM hosts only, this makes both a
 * single permanent 301 to https://www.founders.click with the path and query
 * kept:
 *   http://www.founders.click/x?y   → https://www.founders.click/x?y
 *   http(s)://founders.click/x?y    → https://www.founders.click/x?y
 *
 * Never redirected:
 *  - any other hostname: customers' custom domains, the edge's
 *    proxy.founders.click, previews, localhost;
 *  - a request the edge Worker forwarded for a customer domain
 *    (x-forwarded-host names a non-platform host) — it already arrives as
 *    https://www.founders.click, this is belt and braces;
 *  - /api/public/hooks/* — cron and auth callbacks are POSTs from machines;
 *  - any method but GET/HEAD: a 301 turns a POST into a GET in most clients,
 *    which would silently drop the body.
 *
 * The scheme is read from the request URL only (the Worker sees the visitor's
 * scheme there). Trusting a client-supplied header could produce a redirect to
 * the URL being requested — a loop.
 */
export function platformRedirectFor(
  url: URL,
  method: string,
  headers?: Pick<Headers, "get">,
): string | null {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!PLATFORM_HOSTS.has(host)) return null;
  const verb = method.toUpperCase();
  if (verb !== "GET" && verb !== "HEAD") return null;
  if (NEVER_REDIRECT_PREFIXES.some((p) => url.pathname.startsWith(p))) return null;
  const forwarded = headers?.get("x-forwarded-host")?.trim().toLowerCase();
  if (forwarded && !PLATFORM_HOSTS.has(forwarded)) return null;
  if (url.protocol === "https:" && host === PLATFORM_CANONICAL_HOST) return null;
  return `https://${PLATFORM_CANONICAL_HOST}${url.pathname}${url.search}`;
}

/** Adds the policy headers without overriding any the app already set. */
export function withSecurityHeaders(response: Response, url: URL): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeadersFor(url))) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
