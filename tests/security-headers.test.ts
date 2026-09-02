/**
 * Response security-header policy. Run: bun tests/security-headers.test.ts
 */
import { securityHeadersFor, withSecurityHeaders, isTenantPath } from "../src/lib/security-headers";

let pass = 0, fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL  ${name}  ${extra}`); }
}

console.log("\n=== platform routes ===");
{
  const h = securityHeadersFor(new URL("https://www.founders.click/app/billing"));
  t("nosniff", h["X-Content-Type-Options"] === "nosniff");
  t("referrer policy", h["Referrer-Policy"] === "strict-origin-when-cross-origin");
  t("dashboard cannot be framed", h["X-Frame-Options"] === "DENY");
  t("HSTS on the platform host", /^max-age=\d+$/.test(h["Strict-Transport-Security"] ?? ""));
  t("HSTS does not pin delegated subdomains", !/includeSubDomains/i.test(h["Strict-Transport-Security"] ?? ""));
  t("permissions policy disables sensors", (h["Permissions-Policy"] ?? "").includes("camera=()"));
  t("apex host also gets HSTS",
    !!securityHeadersFor(new URL("https://founders.click/"))["Strict-Transport-Security"]);
}

console.log("\n=== tenant pages ===");
{
  const h = securityHeadersFor(new URL("https://pages.customer-marketplace.com/a/best-rentals-in-austin"));
  t("tenant path detected", isTenantPath("/a/best-rentals-in-austin"));
  t("tenant page may be framed (no X-Frame-Options)", !("X-Frame-Options" in h));
  t("no HSTS on a hostname we do not own", !("Strict-Transport-Security" in h));
  t("still nosniff", h["X-Content-Type-Options"] === "nosniff");
  t("preview path counts as tenant", isTenantPath("/s/ws123/some-page"));
  t("legacy /p/ path counts as tenant", isTenantPath("/p/slug"));
  t("affiliate apply page counts as tenant", isTenantPath("/apply/prog"));
  t("/app is not a tenant path", !isTenantPath("/app/pages"));
  t("/a alone (no trailing slash) is not a tenant path", !isTenantPath("/about"));
}

console.log("\n=== wrapping a response ===");
{
  const url = new URL("https://www.founders.click/");
  const original = new Response("hello", {
    status: 201,
    statusText: "Created",
    headers: { "content-type": "text/plain", "X-Frame-Options": "SAMEORIGIN" },
  });
  const wrapped = withSecurityHeaders(original, url);
  t("status preserved", wrapped.status === 201 && wrapped.statusText === "Created");
  t("existing header not overridden", wrapped.headers.get("X-Frame-Options") === "SAMEORIGIN");
  t("content-type preserved", wrapped.headers.get("content-type") === "text/plain");
  t("policy headers added", wrapped.headers.get("Strict-Transport-Security") !== null);
  const upgrade = new Response(null, { status: 101 });
  t("101 responses passed through untouched", withSecurityHeaders(upgrade, url) === upgrade);
}
// Body survives wrapping (streams are moved, not copied).
{
  const wrapped = withSecurityHeaders(new Response("body-bytes"), new URL("https://www.founders.click/x"));
  const text = await wrapped.text();
  t("body readable after wrapping", text === "body-bytes");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) console.log("FAILED:\n  " + failed.join("\n  ") + "\n");
process.exit(fail ? 1 : 0);
