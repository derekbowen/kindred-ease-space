/**
 * AUTH LINK LANDING. Run: bun tests/auth-landing.test.ts
 *
 * Measured on production 2026-09-22 with a real confirmation email: GoTrue
 * redirects to the Auth Site URL (the apex), Cloudflare forwards to www, the
 * app stores the session from the fragment — and leaves the customer on the
 * marketing homepage under a "Sign in" button. The root auth bridge now sends
 * a hash landing to the app; this pins the routing decision.
 */
import { authLandingFromHash } from "../src/lib/auth-landing";

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("Failed:\n  " + failed.join("\n  ")); process.exit(1); }
