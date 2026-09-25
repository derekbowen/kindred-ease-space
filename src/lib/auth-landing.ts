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
 * SIGNED_IN (authEventNavigation sends that to the form), so a
 * "/reset-password" landing reaching here is defensive only.
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

/** Where a redeemed recovery link is sent: the password form, in update mode. */
export const RECOVERY_FORM_HREF = "/reset-password?recovery=1";

/**
 * Pure: where the root auth bridge navigates for ONE auth event, or null.
 *
 * @supabase/auth-js 2.105.4 emits PASSWORD_RECOVERY — never SIGNED_IN — when
 * a recovery link is redeemed, and that event used to be ignored: the
 * customer stayed on the page the link landed on (the homepage) under a
 * "Sign in" button. It now goes to the password form in update mode
 * (RECOVERY_FORM_HREF) from wherever it landed, unless the tab is already on
 * the form (reset-password.tsx listens for the event itself there).
 *
 * `landing` is the hash landing still armed for this event. The bridge
 * disarms it on the FIRST auth event of any kind, so only that event may use
 * it — SIGNED_IN, or INITIAL_SESSION when auth-js happens to deliver that
 * first, either way carrying the session the link just established — and a
 * later SIGNED_IN (auth-js re-emits it on tab visibility recovery) never
 * replays it. A recovery landing reached that way still opens the form in
 * update mode.
 */
export function authEventNavigation(
  event: string,
  landing: AuthLanding | null,
  pathname: string,
  hasSession: boolean,
): string | null {
  if (event === "PASSWORD_RECOVERY") return onPasswordForm(pathname) ? null : RECOVERY_FORM_HREF;
  if (event !== "SIGNED_IN" && event !== "INITIAL_SESSION") return null;
  if (!hasSession) return null;
  if (!shouldNavigateOnSignIn(landing, pathname)) return null;
  return landing === "/reset-password" ? RECOVERY_FORM_HREF : landing;
}

/** Pure: does the URL carry the bridge's `?recovery=1` marker? */
export function hasRecoveryMarker(search: string): boolean {
  return new URLSearchParams(search).get("recovery") === "1";
}

/**
 * Pure: should the password form open in update mode ("Set a new password")?
 * The implicit flow's own `type=recovery` in the hash still counts on its own.
 * The bridge's `?recovery=1` marker counts only with a live session — the
 * recovery session: by the time the form mounts, PASSWORD_RECOVERY has fired
 * and supabase-js has already cleared the hash, so the marker is the signal
 * that is left. Without a session it is just a URL, and the form offers to
 * send a reset link.
 */
export function passwordFormMode(p: {
  search: string;
  hash: string;
  hasSession: boolean;
}): "update" | "request" {
  if (p.hash.includes("type=recovery")) return "update";
  if (hasRecoveryMarker(p.search) && p.hasSession) return "update";
  return "request";
}
