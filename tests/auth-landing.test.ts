/**
 * AUTH LINK LANDING. Run: bun tests/auth-landing.test.ts
 *
 * Measured on production 2026-09-22 with a real confirmation email: GoTrue
 * redirects to the Auth Site URL (the apex), Cloudflare forwards to www, the
 * app stores the session from the fragment — and leaves the customer on the
 * marketing homepage under a "Sign in" button. The root auth bridge now sends
 * a hash landing to the app; this pins the routing decision.
 *
 * Recovery links: @supabase/auth-js 2.105.4 emits PASSWORD_RECOVERY, not
 * SIGNED_IN, when one is redeemed, and the bridge ignored that event — the
 * customer never reached the reset form. The bridge now sends it to
 * /reset-password?recovery=1, the form treats that marker plus a live session
 * as "set a new password", and the landing is disarmed on the first auth
 * event of any kind so a later SIGNED_IN (tab visibility recovery) can never
 * replay it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RECOVERY_FORM_HREF,
  authEventNavigation,
  authLandingFromHash,
  hasRecoveryMarker,
  passwordFormMode,
  shouldNavigateOnSignIn,
  type AuthLanding,
} from "../src/lib/auth-landing";

let pass = 0, fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL  ${name}  ${extra}`); }
}
const SIGNUP = "#access_token=eyJ.x.y&expires_at=1&expires_in=3600&refresh_token=abc&sb=&token_type=bearer&type=signup";
const MAGIC = "#access_token=eyJ.x.y&expires_in=3600&refresh_token=abc&token_type=bearer&type=magiclink";
const RECOVERY = "#access_token=eyJ.x.y&expires_in=3600&refresh_token=abc&token_type=bearer&type=recovery";

console.log("\nwhere an auth link should land");
t("signup confirmation on the homepage -> /app", authLandingFromHash(SIGNUP, "/") === "/app");
t("magic link on the homepage -> /app", authLandingFromHash(MAGIC, "/") === "/app");
t("signup confirmation on a marketing page -> /app", authLandingFromHash(SIGNUP, "/pricing") === "/app");
t("recovery link -> password form, wherever it lands", authLandingFromHash(RECOVERY, "/") === "/reset-password" && authLandingFromHash(RECOVERY, "/app") === "/reset-password");
t("a leading #/ (hash-router style) is tolerated", authLandingFromHash("#/" + SIGNUP.slice(1), "/") === "/app");

console.log("\nwhen it must NOT redirect");
t("already inside /app: leave the router alone", authLandingFromHash(SIGNUP, "/app") === null && authLandingFromHash(SIGNUP, "/app/pages") === null);
t("already on /reset-password with a non-recovery session: leave it", authLandingFromHash(SIGNUP, "/reset-password") === null);
t("no fragment -> null", authLandingFromHash("", "/") === null && authLandingFromHash("#", "/") === null);
t("fragment without a session (expired link error) -> null", authLandingFromHash("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid", "/") === null);
t("an unrelated anchor -> null", authLandingFromHash("#pricing", "/") === null);

console.log("\nconsuming the landing when SIGNED_IN fires");
// @supabase/auth-js re-emits SIGNED_IN on tab visibility recovery, so the
// bridge decides at event time, from the pathname the tab is on THEN — a
// customer editing a page under /app must not be yanked back to /app.
t("armed landing on a marketing page -> navigate", shouldNavigateOnSignIn("/app", "/") === true && shouldNavigateOnSignIn("/app", "/pricing") === true);
t("a consumed (null) landing never navigates", shouldNavigateOnSignIn(null, "/") === false && shouldNavigateOnSignIn(null, "/app/pages/abc/edit") === false);
t("already under /app: a re-emitted SIGNED_IN leaves the editor alone", shouldNavigateOnSignIn("/app", "/app") === false && shouldNavigateOnSignIn("/app", "/app/pages/abc/edit") === false);
t("/app means the route, not any path starting with those letters", shouldNavigateOnSignIn("/app", "/apply") === true);
t("recovery landing from a marketing page -> the password form", shouldNavigateOnSignIn("/reset-password", "/") === true);
t("already on the password form: leave it", shouldNavigateOnSignIn("/reset-password", "/reset-password") === false);
t("recovery landing while inside /app: leave the router alone (defensive — recovery emits PASSWORD_RECOVERY, not SIGNED_IN)", shouldNavigateOnSignIn("/reset-password", "/app") === false);

console.log("\nthe root bridge consumes the landing exactly once (source guard)");
const root = readFileSync(join(import.meta.dir, "../src/routes/__root.tsx"), "utf8");
t("landing is a `let` decided from the hash before supabase-js strips it", /let landing = authLandingFromHash\(window\.location\.hash, window\.location\.pathname\);/.test(root));
// Converted from "SIGNED_IN re-checks the live pathname through the pure
// helper": EVERY event now goes through authEventNavigation (which still
// checks the live pathname via shouldNavigateOnSignIn), because the landing
// belongs to the first event of any kind and PASSWORD_RECOVERY navigates too.
t("every auth event re-checks the live pathname through the pure helper", /const to = authEventNavigation\(event, landing, window\.location\.pathname, !!session\);/.test(root));
const toAt = root.indexOf("const to = authEventNavigation(");
const nullAt = root.indexOf("landing = null;");
const navAt = root.indexOf("router.navigate({ href: to, replace: true });");
t("the destination is decided, the landing nulled, THEN the navigate runs", toAt > 0 && nullAt > toAt && navAt > nullAt, `to=${toAt} null=${nullAt} nav=${navAt}`);
t("nothing else navigates on `landing` directly", !/router\.navigate\(\{ to: landing/.test(root) && !/router\.navigate\(\{ href: landing/.test(root));
t(
  "the landing is disarmed on the FIRST event of any kind (unconditionally, right after the decision)",
  /const to = authEventNavigation\(event, landing, window\.location\.pathname, !!session\);\s*landing = null;/.test(root) &&
    !/if \([^)]*\)\s*\{?\s*landing = null;/.test(root),
);
t("no event is filtered out before the landing is disarmed", !/if \(event !== "SIGNED_IN" && event !== "SIGNED_OUT" && event !== "USER_UPDATED"\) return;/.test(root));
t(
  "PASSWORD_RECOVERY is an identity transition (router and queries refresh for the recovery session)",
  /const IDENTITY_EVENTS = new Set\(\["SIGNED_IN", "SIGNED_OUT", "USER_UPDATED", "PASSWORD_RECOVERY"\]\);/.test(root),
);
t("the bridge says why the landing is consumed once", /tab visibility recovery/.test(root));
t("the bridge notes that recovery links emit PASSWORD_RECOVERY, handled by reset-password.tsx", /PASSWORD_RECOVERY/.test(root) && /reset-password\.tsx/.test(root));

console.log("\nrecovery links reach the reset form (PASSWORD_RECOVERY)");
t("the recovery form is /reset-password?recovery=1", RECOVERY_FORM_HREF === "/reset-password?recovery=1");
t("PASSWORD_RECOVERY on the homepage -> the form in update mode", authEventNavigation("PASSWORD_RECOVERY", null, "/", true) === RECOVERY_FORM_HREF);
t("PASSWORD_RECOVERY wherever it lands, armed landing or not", authEventNavigation("PASSWORD_RECOVERY", "/reset-password", "/pricing", true) === RECOVERY_FORM_HREF && authEventNavigation("PASSWORD_RECOVERY", "/app", "/app/pages", true) === RECOVERY_FORM_HREF);
t("PASSWORD_RECOVERY already on the form: leave it (the form listens itself)", authEventNavigation("PASSWORD_RECOVERY", "/reset-password", "/reset-password", true) === null);

console.log("\nthe landing belongs to the first event, whichever it is");
t("SIGNED_IN with an armed landing and a session -> go", authEventNavigation("SIGNED_IN", "/app", "/", true) === "/app");
t("INITIAL_SESSION first (auth-js may deliver it first) with the session -> go", authEventNavigation("INITIAL_SESSION", "/app", "/", true) === "/app");
t("a recovery landing reached through SIGNED_IN / INITIAL_SESSION opens the form in update mode", authEventNavigation("SIGNED_IN", "/reset-password", "/", true) === RECOVERY_FORM_HREF && authEventNavigation("INITIAL_SESSION", "/reset-password", "/", true) === RECOVERY_FORM_HREF);
t("no session -> nowhere", authEventNavigation("INITIAL_SESSION", "/app", "/", false) === null && authEventNavigation("SIGNED_IN", "/app", "/", false) === null);
t("a disarmed (null) landing never navigates on SIGNED_IN", authEventNavigation("SIGNED_IN", null, "/", true) === null && authEventNavigation("SIGNED_IN", null, "/pricing", true) === null);
t("other events never use the landing", ["TOKEN_REFRESHED", "USER_UPDATED", "SIGNED_OUT", "MFA_CHALLENGE_VERIFIED"].every((e) => authEventNavigation(e, "/app", "/", true) === null));
t("already inside /app -> nowhere (live pathname)", authEventNavigation("SIGNED_IN", "/app", "/app/pages/abc/edit", true) === null);

// The bridge, replayed: decide with the armed landing, disarm, navigate.
function bridge(landing: AuthLanding | null, startPath: string, events: Array<[string, boolean]>): string[] {
  let armed = landing;
  let path = startPath;
  const went: string[] = [];
  for (const [event, hasSession] of events) {
    const to = authEventNavigation(event, armed, path, hasSession);
    armed = null;
    if (to) {
      went.push(to);
      path = to.split("?")[0]!;
    }
  }
  return went;
}
const signupLanding = authLandingFromHash(SIGNUP, "/");
const recoveryLanding = authLandingFromHash(RECOVERY, "/");
t("signup link, SIGNED_IN first: exactly one navigation, to /app", JSON.stringify(bridge(signupLanding, "/", [["SIGNED_IN", true], ["INITIAL_SESSION", true]])) === JSON.stringify(["/app"]));
t("signup link, INITIAL_SESSION first: still exactly one navigation, to /app", JSON.stringify(bridge(signupLanding, "/", [["INITIAL_SESSION", true], ["SIGNED_IN", true]])) === JSON.stringify(["/app"]));
t(
  "recovery link on the homepage: PASSWORD_RECOVERY -> the form; a later tab-visibility SIGNED_IN goes nowhere",
  JSON.stringify(bridge(recoveryLanding, "/", [["PASSWORD_RECOVERY", true], ["INITIAL_SESSION", true], ["SIGNED_IN", true]])) === JSON.stringify([RECOVERY_FORM_HREF]),
);
t(
  "recovery link, INITIAL_SESSION first: the form once, and PASSWORD_RECOVERY there is left to the form",
  JSON.stringify(bridge(recoveryLanding, "/", [["INITIAL_SESSION", true], ["PASSWORD_RECOVERY", true]])) === JSON.stringify([RECOVERY_FORM_HREF]),
);
t(
  "the replay bug: a first event that does not navigate still disarms the landing",
  JSON.stringify(bridge(signupLanding, "/", [["TOKEN_REFRESHED", true], ["SIGNED_IN", true]])) === JSON.stringify([]),
);

console.log("\nthe reset form opens in update mode for a redeemed recovery link");
t("?recovery=1 is the marker", hasRecoveryMarker("?recovery=1") && hasRecoveryMarker("?x=y&recovery=1") && !hasRecoveryMarker("?recovery=0") && !hasRecoveryMarker("") && !hasRecoveryMarker("?recovery=true"));
t("?recovery=1 with a live session -> update", passwordFormMode({ search: "?recovery=1", hash: "", hasSession: true }) === "update");
t("?recovery=1 without a session -> request (it is just a URL)", passwordFormMode({ search: "?recovery=1", hash: "", hasSession: false }) === "request");
t("a session alone is not a recovery -> request", passwordFormMode({ search: "", hash: "", hasSession: true }) === "request");
t("the implicit flow's #type=recovery still opens update mode on its own", passwordFormMode({ search: "", hash: RECOVERY, hasSession: false }) === "update");
const reset = readFileSync(join(import.meta.dir, "../src/routes/reset-password.tsx"), "utf8");
t(
  "reset-password.tsx reads the marker and asks for the live session before switching to update mode",
  /if \(hasRecoveryMarker\(search\)\) \{\s*void supabase\.auth\.getSession\(\)\.then\(\(\{ data: current \}\) => \{\s*if \(\s*live &&\s*passwordFormMode\(\{ search, hash, hasSession: !!current\.session \}\) === "update"\s*\) \{\s*setMode\("update"\);/.test(reset),
);
t("reset-password.tsx still listens for PASSWORD_RECOVERY itself", /if \(event === "PASSWORD_RECOVERY"\) setMode\("update"\);/.test(reset));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("Failed:\n  " + failed.join("\n  ")); process.exit(1); }
