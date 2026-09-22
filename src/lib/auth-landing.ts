/**
 * Pure: given the URL fragment an auth redirect arrived with and the path it
 * landed on, the in-app destination — or null when this is not an auth
 * landing (no session in the fragment) or the page is already inside /app.
 * Recovery links go to the password form; everything else to the dashboard.
 */
export function authLandingFromHash(hash: string, pathname: string): "/app" | "/reset-password" | null {
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.replace(/^#\/?/, ""));
  if (!params.get("access_token")) return null;
  if (params.get("type") === "recovery") return "/reset-password";
  if (pathname === "/app" || pathname.startsWith("/app/")) return null;
  if (pathname === "/reset-password") return null;
  return "/app";
}
