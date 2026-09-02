/**
 * Small pure guards on public input: JSON-LD serialisation and the login
 * `?next=` redirect. Run: bun tests/public-input-hardening.test.ts
 */
import { safeJsonLd } from "../src/lib/json-ld";
import { safeNextPath } from "../src/lib/safe-next";

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

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) console.log("FAILED:\n  " + failed.join("\n  ") + "\n");
process.exit(fail ? 1 : 0);
