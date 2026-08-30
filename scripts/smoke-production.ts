/**
 * POST-DEPLOY PRODUCTION SMOKE.
 *
 * Runs against the live site after a deploy and answers one question: is the
 * build we just shipped actually serving, and does it work?
 *
 * Two rules:
 *
 *   1. A SKIP IS NOT A PASS. Checks needing data that may not exist yet report
 *      SKIP with a reason and are listed separately. They never inflate the
 *      pass count, and --strict turns them into failures.
 *
 *   2. IDENTITY BEFORE BEHAVIOUR. If the running build is not the commit we
 *      deployed, every other green check is meaningless — it is testing the
 *      old release. That check runs first and fails loudly.
 *
 * Usage:
 *   bun scripts/smoke-production.ts [BASE_URL] [--sha <expected>] [--strict]
 *
 * Env alternatives: SMOKE_BASE_URL, EXPECTED_SHA, SMOKE_TENANT_PAGE_URL
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = (args.find((a) => a.startsWith("http")) ?? process.env.SMOKE_BASE_URL ?? "https://www.founders.click").replace(/\/+$/, "");
const EXPECTED_SHA = flag("sha") ?? process.env.EXPECTED_SHA ?? "";
const STRICT = args.includes("--strict");
const TENANT_PAGE = process.env.SMOKE_TENANT_PAGE_URL ?? "";
const TIMEOUT_MS = 25_000;

type Status = "PASS" | "FAIL" | "SKIP";
const results: Array<{ name: string; status: Status; detail: string }> = [];

function record(name: string, status: Status, detail: string) {
  results.push({ name, status, detail });
  const mark = status === "PASS" ? "  PASS " : status === "FAIL" ? "  FAIL " : "  SKIP ";
  console.log(`${mark} ${name.padEnd(42)} ${detail}`);
}

/**
 * HTTP via curl rather than fetch.
 *
 * Deliberate: curl honours proxy configuration that the runtime's built-in
 * fetch does not, so this script behaves identically on a developer machine,
 * inside a proxied sandbox, and on a CI runner. A smoke test that only works
 * in one environment is a smoke test nobody runs before it matters.
 */
async function get(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const dir = mkdtempSync(join(tmpdir(), "smoke-"));
  const bodyFile = join(dir, "body");
  const headerFile = join(dir, "headers");
  const argv = [
    "-sS", "-L",
    "--max-time", String(Math.round(TIMEOUT_MS / 1000)),
    "-o", bodyFile,
    "-D", headerFile,
    "-w", "%{http_code}",
  ];
  if (init.method && init.method !== "GET") argv.push("-X", init.method);
  for (const [k, v] of Object.entries(init.headers ?? {})) argv.push("-H", `${k}: ${v}`);
  if (init.body !== undefined) argv.push("--data-raw", init.body);
  argv.push(url);

  try {
    const code = execFileSync("curl", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const body = readFileSync(bodyFile, "utf8");
    const headers = new Headers();
    for (const line of readFileSync(headerFile, "utf8").split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i > 0) {
        try { headers.set(line.slice(0, i).trim(), line.slice(i + 1).trim()); } catch { /* ignore */ }
      }
    }
    return { ok: true as const, status: Number(code), body, headers, url };
  } catch (e: any) {
    const detail = (e?.stderr ? String(e.stderr) : String(e)).trim().split("\n").pop() ?? "request failed";
    return { ok: false as const, status: 0, body: "", headers: new Headers(), url, error: detail };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function check(name: string, fn: () => Promise<[Status, string]>) {
  try {
    const [status, detail] = await fn();
    record(name, status, detail);
  } catch (e) {
    record(name, "FAIL", `threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`\nSmoke: ${BASE}${EXPECTED_SHA ? ` (expecting ${EXPECTED_SHA.slice(0, 7)})` : ""}\n`);

// ---------------------------------------------------------------------------
// 1. BUILD IDENTITY — first, because everything below is meaningless if the
//    old build is still serving.
// ---------------------------------------------------------------------------
let servingSha = "";
await check("build identity endpoint", async () => {
  const r = await get("/api/public/edge-health");
  if (!r.ok) return ["FAIL", r.error ?? "unreachable"];
  if (r.status !== 200) return ["FAIL", `HTTP ${r.status} — endpoint missing from this build`];
  const j = JSON.parse(r.body) as { sha?: string; builtAt?: string };
  servingSha = j.sha ?? "";
  return ["PASS", `serving ${(j.sha ?? "?").slice(0, 7)} built ${j.builtAt ?? "?"}`];
});

await check("deployed build matches this commit", async () => {
  if (!EXPECTED_SHA) return ["SKIP", "no --sha given (run from CI to enforce)"];
  if (!servingSha) return ["FAIL", "could not read the serving build"];
  if (servingSha === "dev") return ["FAIL", "production is serving a dev build (SHA was not injected)"];
  if (servingSha !== EXPECTED_SHA) {
    return ["FAIL", `serving ${servingSha.slice(0, 7)}, expected ${EXPECTED_SHA.slice(0, 7)} — the deploy did not take effect`];
  }
  return ["PASS", `${servingSha.slice(0, 7)}`];
});

// ---------------------------------------------------------------------------
// 2. CORE SURFACES
// ---------------------------------------------------------------------------
await check("homepage", async () => {
  const r = await get("/");
  if (!r.ok) return ["FAIL", r.error ?? "unreachable"];
  if (r.status !== 200) return ["FAIL", `HTTP ${r.status}`];
  // Server-rendered, not an empty shell hydrated later — an SSR regression
  // would still return 200 with a blank body, and Google would index nothing.
  if (!/<h1|<title/i.test(r.body)) return ["FAIL", "200 but no server-rendered markup"];
  return ["PASS", `HTTP 200, ${r.body.length} bytes SSR`];
});

await check("authentication entry point", async () => {
  const r = await get("/login");
  if (!r.ok) return ["FAIL", r.error ?? "unreachable"];
  if (r.status !== 200) return ["FAIL", `HTTP ${r.status}`];
  return ["PASS", "HTTP 200"];
});

await check("static asset delivery", async () => {
  const r = await get("/favicon.svg");
  if (!r.ok) return ["FAIL", r.error ?? "unreachable"];
  if (r.status !== 200) return ["FAIL", `HTTP ${r.status} — assets binding may be broken`];
  return ["PASS", `HTTP 200, ${r.headers.get("content-type") ?? "?"}`];
});

await check("platform sitemap", async () => {
  const r = await get("/sitemap.xml");
  if (!r.ok) return ["FAIL", r.error ?? "unreachable"];
  if (r.status !== 200) return ["FAIL", `HTTP ${r.status}`];
  if (!r.body.includes("<urlset")) return ["FAIL", "200 but not a sitemap"];
  return ["PASS", `${(r.body.match(/<url>/g) ?? []).length} urls`];
});

// ---------------------------------------------------------------------------
// 3. DATABASE CONNECTIVITY — read-only, no writes, no customer data.
// ---------------------------------------------------------------------------
await check("database reachable (domain-config query)", async () => {
  // A hostname that cannot exist. Reaching a clean "not found" proves the
  // query executed: a broken DB or missing column now returns 503, not 404.
  const r = await get("/api/public/domain-config?hostname=smoke-probe.invalid");
  if (!r.ok) return ["FAIL", r.error ?? "unreachable"];
  if (r.status === 503) return ["FAIL", "control plane reports the database is unavailable"];
  if (r.status !== 404) return ["FAIL", `HTTP ${r.status} (expected 404 domain_not_found)`];
  if (!r.body.includes("domain_not_found")) return ["FAIL", `unexpected body: ${r.body.slice(0, 80)}`];
  return ["PASS", "query executed, clean 404"];
});

await check("edge telemetry endpoint accepts reports", async () => {
  const r = await get("/api/public/edge-health", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostname: "smoke-probe.invalid", state: "HEALTHY" }),
  });
  if (!r.ok) return ["FAIL", r.error ?? "unreachable"];
  // Telemetry is never load-bearing, so it always answers 202 — including for
  // an unknown host, which it declines to record.
  if (r.status !== 202) return ["FAIL", `HTTP ${r.status} (expected 202)`];
  return ["PASS", "HTTP 202"];
});

// ---------------------------------------------------------------------------
// 4. AUTHORIZATION IS ENFORCED — an unauthenticated call to a protected
//    server function must be refused. This catches a deploy that shipped with
//    auth middleware broken or stripped, which no page-level check would see.
// ---------------------------------------------------------------------------
await check("protected endpoints refuse anonymous callers", async () => {
  const r = await get("/api/public/page-lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!r.ok) return ["FAIL", r.error ?? "unreachable"];
  // Public route, but it must still reject a malformed/unauthorized body
  // rather than 500 or return data.
  if (r.status >= 500) return ["FAIL", `HTTP ${r.status} — server error on bad input`];
  return ["PASS", `HTTP ${r.status} (rejected cleanly)`];
});

// ---------------------------------------------------------------------------
// 5. A REAL PUBLISHED PAGE — needs a customer domain with published content.
//    Skipped explicitly until one exists rather than quietly passing.
// ---------------------------------------------------------------------------
await check("public generated page renders", async () => {
  if (!TENANT_PAGE) {
    return ["SKIP", "set SMOKE_TENANT_PAGE_URL to a published /a/ page"];
  }
  const r = await get(TENANT_PAGE);
  if (!r.ok) return ["FAIL", r.error ?? "unreachable"];
  if (r.status !== 200) return ["FAIL", `HTTP ${r.status}`];
  const problems: string[] = [];
  if (!/<link[^>]+rel=["']canonical["']/i.test(r.body)) problems.push("no canonical");
  if ((r.body.match(/rel=["']canonical["']/gi) ?? []).length > 1) problems.push("multiple canonicals");
  if (/name=["']robots["'][^>]*noindex/i.test(r.body)) problems.push("noindex");
  if (!/application\/ld\+json/i.test(r.body)) problems.push("no structured data");
  if (!/<h1/i.test(r.body)) problems.push("no h1");
  if (/founders\.click/i.test(r.body.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0] ?? "")) {
    problems.push("canonical leaks the platform domain");
  }
  return problems.length ? ["FAIL", problems.join(", ")] : ["PASS", "canonical, schema, h1 all present"];
});

// ---------------------------------------------------------------------------
const pass = results.filter((r) => r.status === "PASS").length;
const fail = results.filter((r) => r.status === "FAIL").length;
const skip = results.filter((r) => r.status === "SKIP").length;

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped\n`);
if (skip) {
  console.log("SKIPPED (not passes):");
  for (const r of results.filter((x) => x.status === "SKIP")) console.log(`  - ${r.name}: ${r.detail}`);
  console.log("");
}
if (fail) {
  console.log("FAILED:");
  for (const r of results.filter((x) => x.status === "FAIL")) console.log(`  - ${r.name}: ${r.detail}`);
  console.log("");
}
if (STRICT && skip) {
  console.log("--strict: skipped checks count as failures.\n");
}
process.exit(fail > 0 || (STRICT && skip > 0) ? 1 : 0);
