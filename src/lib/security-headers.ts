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
