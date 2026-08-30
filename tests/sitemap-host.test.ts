/**
 * Sitemap host handling.
 *
 * The bug this locks down: `www.` was stripped for workspace LOOKUP and the
 * stripped value was then used to BUILD sitemap <loc> URLs. a.$slug.tsx
 * canonicalizes to the host actually requested, so the sitemap advertised
 * https://customer.com/a/x while the page declared https://www.customer.com/a/x
 * canonical — and a customer who connected only `www` has no apex route, so
 * every URL in their sitemap failed to resolve.
 *
 * Run: bun tests/sitemap-host.test.ts
 */
import { requestHost, normalizeHost, isPlatformHost, escapeXml } from "../src/lib/sitemap.server";

let pass = 0, fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL  ${name}  ${extra}`); }
}

console.log("\n=== requestHost preserves what the visitor asked for ===");
t("www is PRESERVED for URL building",
  requestHost("www.customer.com") === "www.customer.com", requestHost("www.customer.com"));
t("apex stays apex", requestHost("customer.com") === "customer.com");
t("scheme stripped", requestHost("https://www.customer.com") === "www.customer.com");
t("port stripped", requestHost("www.customer.com:8443") === "www.customer.com");
t("path stripped", requestHost("www.customer.com/a/x") === "www.customer.com");
t("case folded", requestHost("WWW.Customer.COM") === "www.customer.com");
t("x-forwarded-host list takes the first entry",
  requestHost("www.customer.com, edge.internal") === "www.customer.com");
t("empty input is empty", requestHost("") === "");

console.log("\n=== normalizeHost is the LOOKUP key only ===");
t("www stripped for lookup", normalizeHost("www.customer.com") === "customer.com");
t("apex and www share one lookup key",
  normalizeHost("www.customer.com") === normalizeHost("customer.com"));
t("only a LEADING www is stripped",
  normalizeHost("www.www-hosting.com") === "www-hosting.com",
  normalizeHost("www.www-hosting.com"));
t("a host merely containing www is untouched",
  normalizeHost("mywww.customer.com") === "mywww.customer.com");

console.log("\n=== the two must not be the same function ===");
{
  // This is the actual regression. If these ever collapse back into one, the
  // sitemap starts emitting URLs the page does not canonicalize to.
  t("requestHost and normalizeHost DIFFER on a www host",
    requestHost("www.customer.com") !== normalizeHost("www.customer.com"));
  t("they agree on an apex host",
    requestHost("customer.com") === normalizeHost("customer.com"));
}

console.log("\n=== platform hosts never serve a tenant sitemap ===");
t("apex platform host detected", isPlatformHost("founders.click"));
t("www platform host detected", isPlatformHost("www.founders.click"));
t("platform host with port detected", isPlatformHost("www.founders.click:443"));
t("a customer domain is not a platform host", !isPlatformHost("www.customer.com"));

console.log("\n=== XML escaping ===");
t("ampersand escaped", escapeXml("a&b") === "a&amp;b");
t("angle brackets escaped", escapeXml("<x>") === "&lt;x&gt;");
t("quotes escaped", escapeXml("\"'") === "&quot;&apos;");

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) console.log("FAILED:\n  " + failed.join("\n  ") + "\n");
process.exit(fail ? 1 : 0);
