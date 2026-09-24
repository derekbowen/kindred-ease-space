/**
 * AUTH LINK LANDING. Run: bun tests/auth-landing.test.ts
 *
 * Measured on production 2026-09-22 with a real confirmation email: GoTrue
 * redirects to the Auth Site URL (the apex), Cloudflare forwards to www, the
 * app stores the session from the fragment — and leaves the customer on the
 * marketing homepage under a "Sign in" button. The root auth bridge now sends
 * a hash landing to the app; this pins the routing decision.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { authLandingFromHash, shouldNavigateOnSignIn } from "../src/lib/auth-landing";

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
t("SIGNED_IN re-checks the live pathname through the pure helper", /event === "SIGNED_IN" && shouldNavigateOnSignIn\(landing, window\.location\.pathname\)/.test(root));
const toAt = root.indexOf("const to = landing;");
const nullAt = root.indexOf("landing = null;");
const navAt = root.indexOf("router.navigate({ to, replace: true });");
t("the destination is copied, the landing nulled, THEN the navigate runs", toAt > 0 && nullAt > toAt && navAt > nullAt, `to=${toAt} null=${nullAt} nav=${navAt}`);
t("nothing else navigates on `landing` directly", !/router\.navigate\(\{ to: landing/.test(root));
t("the bridge says why the landing is consumed once", /tab visibility recovery/.test(root));
t("the bridge notes that recovery links emit PASSWORD_RECOVERY, handled by reset-password.tsx", /PASSWORD_RECOVERY/.test(root) && /reset-password\.tsx/.test(root));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("Failed:\n  " + failed.join("\n  ")); process.exit(1); }
