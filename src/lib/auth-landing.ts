/** The in-app destinations an auth link can be for. */
export type AuthLanding = "/app" | "/reset-password";

function insideApp(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/");
}

function onPasswordForm(pathname: string): boolean {
  return pathname === "/reset-password" || pathname.startsWith("/reset-password/");
}

/**
 * Pure: given the URL fragment an auth redirect arrived with and the path it
 * landed on, the in-app destination — or null when this is not an auth
 * landing (no session in the fragment) or the page is already inside /app.
 * Recovery links go to the password form; everything else to the dashboard.
 */
export function authLandingFromHash(hash: string, pathname: string): AuthLanding | null {
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.replace(/^#\/?/, ""));
  if (!params.get("access_token")) return null;
  if (params.get("type") === "recovery") return "/reset-password";
  if (insideApp(pathname)) return null;
  if (onPasswordForm(pathname)) return null;
  return "/app";
}

/**
 * Pure: whether a SIGNED_IN event should navigate to `landing`, judged by the
 * path the tab is on WHEN THE EVENT FIRES, not when the listener mounted.
 *
 * @supabase/auth-js re-emits SIGNED_IN on tab visibility recovery, and the
 * root bridge listens for the whole session, so the answer is no once the
 * landing has been consumed (null) and no when the customer is already inside
 * /app or on the password form — a redirect there only takes them away from
 * what they were doing. Recovery links emit PASSWORD_RECOVERY rather than
 * SIGNED_IN (reset-password.tsx handles it), so a "/reset-password" landing
 * reaching here is defensive only.
 */
export function shouldNavigateOnSignIn(
  landing: AuthLanding | null,
  pathname: string,
): landing is AuthLanding {
  if (landing === null) return false;
  if (insideApp(pathname)) return false;
  if (onPasswordForm(pathname)) return false;
  return true;
}
