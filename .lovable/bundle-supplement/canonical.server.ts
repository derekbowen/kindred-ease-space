/**
 * Canonical URL helper — the ONLY source of truth for user-facing URLs.
 *
 * Workspace rule #6: every <link rel="canonical">, og:url, twitter:url,
 * sitemap <loc>, and JSON-LD url/@id MUST be built from X-Forwarded-Host
 * (the production proxy) — never from request.url, window.location, or
 * hardcoded *.lovable.app strings.
 *
 * Fallback order:
 *   1. X-Forwarded-Host header (production proxy)
 *   2. PUBLIC_SITE_ORIGIN env var
 *   3. https://www.poolrentalnearme.com in production
 *   4. http://localhost:3000 in development
 */

const PROD_ORIGIN = "https://www.poolrentalnearme.com";
const DEV_ORIGIN = "http://localhost:3000";

function isLovableHost(host: string): boolean {
  return host.includes("lovable.app");
}

function readHeader(request: Request | undefined, name: string): string | null {
  if (!request) return null;
  try {
    const value = request.headers.get(name);
    return value && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Returns the canonical origin (e.g. "https://www.poolrentalnearme.com").
 * Pass the incoming server Request when available; falls back safely otherwise.
 */
export function getCanonicalOrigin(request?: Request): string {
  const fwdHost = readHeader(request, "x-forwarded-host");
  if (fwdHost && !isLovableHost(fwdHost)) {
    const proto = readHeader(request, "x-forwarded-proto") ?? "https";
    return `${proto}://${fwdHost}`;
  }

  const envOrigin = (() => {
    try {
      return process.env.PUBLIC_SITE_ORIGIN ?? null;
    } catch {
      return null;
    }
  })();
  if (envOrigin && !isLovableHost(envOrigin)) {
    return envOrigin.replace(/\/+$/, "");
  }

  const isDev = (() => {
    try {
      return process.env.NODE_ENV === "development";
    } catch {
      return false;
    }
  })();
  return isDev ? DEV_ORIGIN : PROD_ORIGIN;
}

/**
 * Returns a full canonical URL for the given path.
 * Path may be relative ("/p/foo") or absolute — leading slash is normalized.
 */
export function getCanonicalUrl(request: Request | undefined, path: string): string {
  const origin = getCanonicalOrigin(request);
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${origin}${normalized}`;
}
