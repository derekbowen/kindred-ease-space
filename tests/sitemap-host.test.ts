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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  requestHost,
  normalizeHost,
  isPlatformHost,
  escapeXml,
  preferredHostMatch,
  type HostMatch,
} from "../src/lib/sitemap.server";

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

console.log("\n=== host resolution prefers proof of ownership (S2) ===");
{
  // The hole: workspace A claimed customer.com (which seeded its
  // marketplace_domain), never verified, and the claim expired. Workspace B
  // claimed and VERIFIED customer.com. Two sources now name two workspaces,
  // and "first match" used to be whichever a query returned first.
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";
  const C = "33333333-3333-3333-3333-333333333333";
  const custom = (workspaceId: string, verifiedAt: string | null): HostMatch =>
    ({ workspaceId, source: "workspace_domains", verifiedAt });
  const legacy = (workspaceId: string, verifiedAt: string | null): HostMatch =>
    ({ workspaceId, source: "marketplace_domain", verifiedAt });

  t("no candidates resolves to nothing", preferredHostMatch([]) === null);
  t("a lone legacy match still resolves", preferredHostMatch([legacy(A, "2026-01-01T00:00:00Z")])?.workspaceId === A);
  t("a lone verified custom domain resolves", preferredHostMatch([custom(B, "2026-09-01T00:00:00Z")])?.workspaceId === B);

  t("the verified custom domain wins over the legacy branch",
    preferredHostMatch([legacy(A, "2026-09-20T00:00:00Z"), custom(B, "2026-09-01T00:00:00Z")])?.workspaceId === B);
  t("…regardless of input order",
    preferredHostMatch([custom(B, "2026-09-01T00:00:00Z"), legacy(A, "2026-09-20T00:00:00Z")])?.workspaceId === B);
  t("…even when the legacy verification is more recent",
    preferredHostMatch([legacy(A, "2026-09-22T00:00:00Z"), custom(B, "2025-01-01T00:00:00Z")])?.workspaceId === B);
  t("…and even when the legacy match has no date at all",
    preferredHostMatch([legacy(A, null), custom(B, null)])?.workspaceId === B);

  t("within the legacy branch the most recent verification wins",
    preferredHostMatch([legacy(A, "2026-01-01T00:00:00Z"), legacy(B, "2026-06-01T00:00:00Z")])?.workspaceId === B);
  t("a dated verification beats an undated one (NULLS LAST)",
    preferredHostMatch([legacy(A, null), legacy(B, "2020-01-01T00:00:00Z")])?.workspaceId === B);
  t("an unparseable date counts as undated",
    preferredHostMatch([legacy(A, "not a date"), legacy(B, "2020-01-01T00:00:00Z")])?.workspaceId === B);
  t("a full tie is settled by the lowest workspace id, deterministically",
    preferredHostMatch([legacy(C, null), legacy(A, null), legacy(B, null)])?.workspaceId === A &&
      preferredHostMatch([legacy(B, null), legacy(A, null), legacy(C, null)])?.workspaceId === A);

  const input = [legacy(A, "2026-09-20T00:00:00Z"), custom(B, "2026-09-01T00:00:00Z")];
  const before = JSON.stringify(input);
  preferredHostMatch(input);
  t("the input is not reordered", JSON.stringify(input) === before);

  // The database applies the same rule; the two must not drift apart.
  const ROOT = join(import.meta.dir, "..");
  const mig = readFileSync(join(ROOT, "supabase/migrations/20260923000500_host_resolver_prefers_verified_domain.sql"), "utf8");
  t("the SQL resolver orders the same way: custom domain first, newest verification, lowest id",
    mig.includes("ORDER BY priority ASC, verified_at DESC NULLS LAST, id ASC"));
  t("the SQL gives workspace_domains priority 0 and marketplace_domain priority 1",
    /0 AS priority[\s\S]*FROM public\.workspace_domains wd[\s\S]*1 AS priority[\s\S]*FROM public\.workspaces w/.test(mig));
  const sitemapSrc = readFileSync(join(ROOT, "src/lib/sitemap.server.ts"), "utf8");
  t("workspaceIdForHost resolves through preferredHostMatch",
    /export async function workspaceIdForHost[\s\S]*preferredHostMatch\(matches\)/.test(sitemapSrc));
  t("workspaceIdForHost still reads verified rows only",
    /\.eq\("verified", true\)/.test(sitemapSrc) && /\.not\("domain_verified_at", "is", null\)/.test(sitemapSrc));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) console.log("FAILED:\n  " + failed.join("\n  ") + "\n");
process.exit(fail ? 1 : 0);
