/**
 * PLATFORM HTTP → HTTPS AND APEX → WWW, ONE 301. Run: bun tests/platform-redirect.test.ts
 *
 * Production answered http://www.founders.click with a 200 and the apex with
 * a 302. The Worker entry now 301s both, for the platform hosts only
 * (PLATFORM_HOSTS in src/lib/security-headers.ts). Customer domains, the cron
 * and auth hooks, and non-GET requests must never be redirected.
 *
 * Offline: exercises the pure helper and the real Worker entry's redirect path
 * (which returns before the app is loaded).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLATFORM_CANONICAL_HOST,
  PLATFORM_HOSTS,
  platformRedirectFor,
} from "../src/lib/security-headers";

let pass = 0,
  fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failed.push(name);
    console.log(`  FAIL  ${name}  ${extra}`);
  }
}

const go = (href: string, method = "GET", headers?: Record<string, string>) =>
  platformRedirectFor(new URL(href), method, headers ? new Headers(headers) : undefined);

// ---------------------------------------------------------------------------
console.log("\nplatform hosts");

t("the canonical host is www.founders.click", PLATFORM_CANONICAL_HOST === "www.founders.click");
t(
  "PLATFORM_HOSTS is exactly the apex and www",
  PLATFORM_HOSTS.size === 2 && PLATFORM_HOSTS.has("founders.click") && PLATFORM_HOSTS.has("www.founders.click"),
);
t("https://www → served, no redirect", go("https://www.founders.click/pricing") === null);
t(
  "http://www → https://www, path and query kept",
  go("http://www.founders.click/help/start-here?q=sync&x=1") ===
    "https://www.founders.click/help/start-here?q=sync&x=1",
  String(go("http://www.founders.click/help/start-here?q=sync&x=1")),
);
t(
  "https://apex → https://www, path and query kept",
  go("https://founders.click/beta?ref=a") === "https://www.founders.click/beta?ref=a",
  String(go("https://founders.click/beta?ref=a")),
);
t(
  "http://apex → https://www in ONE hop",
  go("http://founders.click/") === "https://www.founders.click/",
  String(go("http://founders.click/")),
);
t(
  "the hash is not part of a request, and an empty query adds no '?'",
  go("http://founders.click/terms") === "https://www.founders.click/terms",
);
t("HEAD is redirected like GET", go("http://www.founders.click/", "HEAD") === "https://www.founders.click/");
t("method case does not matter", go("http://www.founders.click/", "get") === "https://www.founders.click/");
t(
  "an absolute-form trailing-dot host is still the platform",
  go("http://founders.click./x") === "https://www.founders.click/x",
);
t(
  "no redirect ever targets the URL it came from",
  [
    "https://www.founders.click/",
    "https://www.founders.click/a/x",
    "https://www.founders.click/app/billing?y=1",
  ].every((h) => go(h) === null),
);

// ---------------------------------------------------------------------------
console.log("\ntenant and other hosts are never redirected");

for (const href of [
  "http://www.poolrentalnearme.com/a/pools-in-austin",
  "https://poolrentalnearme.com/",
  "http://seo.customer-marketplace.com/a/x",
  "http://proxy.founders.click/a/x",
  "http://notify.www.founders.click/",
  "http://founders-click.workers.dev/",
  "http://localhost:8080/",
  "http://127.0.0.1:8080/help",
]) {
  t(`not redirected: ${href}`, go(href) === null, String(go(href)));
}
t(
  "an edge-forwarded request for a customer domain is never redirected",
  go("http://www.founders.click/a/pools-in-austin", "GET", {
    "x-forwarded-host": "www.poolrentalnearme.com",
  }) === null,
);
t(
  "a platform x-forwarded-host does not block the redirect",
  go("http://www.founders.click/", "GET", { "x-forwarded-host": "www.founders.click" }) ===
    "https://www.founders.click/",
);

// ---------------------------------------------------------------------------
console.log("\nmachine callbacks and non-GET requests are never redirected");

for (const path of [
  "/api/public/hooks/sync-sharetribe",
  "/api/public/hooks/auth-send-email",
  "/api/public/hooks/canonical-audit",
]) {
  t(`hook not redirected (GET, apex, http): ${path}`, go(`http://founders.click${path}`) === null);
  t(`hook not redirected (POST): ${path}`, go(`http://founders.click${path}`, "POST") === null);
}
for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
  t(`${method} is never redirected`, go("http://founders.click/_serverFn/x", method) === null);
}
t(
  "pg_cron's exact target is served, not redirected",
  go("https://www.founders.click/api/public/hooks/sync-sharetribe", "POST") === null,
);

// ---------------------------------------------------------------------------
console.log("\nthe Worker entry answers with a 301 before loading the app");

const server = (await import("../src/server")).default as {
  fetch: (r: Request, env: unknown, ctx: unknown) => Promise<Response>;
};
for (const [from, to] of [
  ["http://www.founders.click/help?q=1", "https://www.founders.click/help?q=1"],
  ["https://founders.click/app/billing", "https://www.founders.click/app/billing"],
  ["http://founders.click/", "https://www.founders.click/"],
] as const) {
  const res = await server.fetch(new Request(from), {}, {});
  t(`${from} → 301`, res.status === 301, String(res.status));
  t(`${from} → Location ${to}`, res.headers.get("location") === to, String(res.headers.get("location")));
}
{
  const res = await server.fetch(new Request("http://www.founders.click/"), {}, {});
  t("the redirect still carries the security headers", res.headers.get("x-content-type-options") === "nosniff");
}

const src = readFileSync(join(import.meta.dir, "../src/server.ts"), "utf8");
const fetchBody = src.slice(src.indexOf("async fetch("));
t(
  "server.ts decides the redirect before handing the request to the app",
  fetchBody.indexOf("platformRedirectFor(") > -1 &&
    fetchBody.indexOf("platformRedirectFor(") < fetchBody.indexOf("getServerEntry()"),
);
t("server.ts uses status 301 (not 302)", /status: 301/.test(fetchBody) && !/status: 302/.test(fetchBody));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
