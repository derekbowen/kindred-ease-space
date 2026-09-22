/**
 * Small pure guards on public input: JSON-LD serialisation and the login
 * `?next=` redirect. Run: bun tests/public-input-hardening.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeJsonLd } from "../src/lib/json-ld";
import { safeNextPath } from "../src/lib/safe-next";
import { isPublicPageSlug, PUBLIC_PAGE_SLUG_RE } from "../src/lib/public-tenant-page.functions";

let pass = 0, fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL  ${name}  ${extra}`); }
}

console.log("\n=== JSON-LD cannot break out of its <script> ===");
{
  const hostile = { name: 'Cabin </script><img src=x onerror="alert(1)">', n: 1 };
  const out = safeJsonLd(hostile);
  t("no raw '<' survives", !out.includes("<"), out);
  t("still valid JSON", JSON.parse(out).name === hostile.name);
  t("plain values untouched", safeJsonLd({ a: "b", c: [1, 2] }) === '{"a":"b","c":[1,2]}');
  t("line separators escaped", !/[\u2028\u2029]/.test(safeJsonLd({ s: "a\u2028b\u2029c" })));
}

console.log("\n=== login next= stays on-site ===");
t("relative path allowed", safeNextPath("/app/billing") === "/app/billing");
t("missing -> /app", safeNextPath(undefined) === "/app");
t("empty -> /app", safeNextPath("") === "/app");
t("absolute URL refused", safeNextPath("https://evil.example/") === "/app");
t("protocol-relative refused", safeNextPath("//evil.example") === "/app");
t("backslash trick refused", safeNextPath("/\\evil.example") === "/app");
t("javascript: refused", safeNextPath("javascript:alert(1)") === "/app");
t("header injection refused", safeNextPath("/app\r\nSet-Cookie:x") === "/app");
t("custom fallback honoured", safeNextPath("http://x", "/home") === "/home");

console.log("\n=== public page slugs cannot widen a PostgREST filter (P6) ===");
{
  // The redirect lookup interpolates the slug into `.or("slug.eq.<slug>,…")`.
  // A comma there starts another filter term, so the slug must be validated
  // before it reaches any query.
  t("the rule is what slugifyPage produces", String(PUBLIC_PAGE_SLUG_RE) === "/^[a-z0-9-]{1,200}$/");
  t("a normal slug passes", isPublicPageSlug("austin-pool-rentals"));
  t("the activation-test slug passes", isPublicPageSlug("founders-domain-test"));
  t("a single character passes", isPublicPageSlug("a"));
  t("200 characters pass", isPublicPageSlug("a".repeat(200)));
  t("201 characters are refused", !isPublicPageSlug("a".repeat(201)));
  t("empty is refused", !isPublicPageSlug(""));
  t("a filter-widening slug is refused", !isPublicPageSlug("x,slug.neq.zzz"));
  t("a PostgREST operator is refused", !isPublicPageSlug("x.eq.y"));
  t("parentheses are refused", !isPublicPageSlug("x)"), "or(...) grouping syntax");
  t("uppercase is refused (slugs are lowercase by construction)", !isPublicPageSlug("Austin"));
  t("a path separator is refused", !isPublicPageSlug("a/b"));
  t("whitespace is refused", !isPublicPageSlug("a b") && !isPublicPageSlug("a\n"));
  t("underscores and dots are refused", !isPublicPageSlug("a_b") && !isPublicPageSlug("a.b"));
  t("non-ASCII is refused", !isPublicPageSlug("café"));

  const src = readFileSync(join(import.meta.dir, "..", "src", "lib", "public-tenant-page.functions.ts"), "utf8");
  const handler = src.slice(src.indexOf("export const getPublicTenantPage"));
  const guardAt = handler.indexOf("if (!isPublicPageSlug(data.slug)) return { page: null, host, preview };");
  t("the handler refuses a bad slug with page: null", guardAt > 0);
  t("…before any query, including the .or(...) redirect lookup",
    guardAt < handler.indexOf(".from(") && guardAt < handler.indexOf(".or(`slug.eq.${data.slug}"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) console.log("FAILED:\n  " + failed.join("\n  ") + "\n");
process.exit(fail ? 1 : 0);
