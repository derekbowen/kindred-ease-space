/**
 * EDGE OUTAGE SIMULATION — the boundary contract, asserted.
 *
 * The rule this file exists to defend:
 *
 *   A founders.click failure may take down a founders.click SEO page.
 *   It must NOT take down the customer's actual Sharetribe marketplace.
 *
 * This runs edge/founders-edge/worker.js in-process against a fake Cloudflare
 * cache and a fake network, so every failure mode can be produced on demand:
 * control plane down, control plane returning garbage, stale config, kill
 * switch, unknown host, dead customer origin, redirect loop.
 *
 * It is NOT a substitute for running these against a real hostname at the
 * edge — cache semantics and Cloudflare's own behaviour are stubbed here. It
 * proves the ROUTING LOGIC is correct. Production behaviour still has to be
 * observed in production.
 *
 * Run: bun tests/edge-outage.test.ts
 */

const WORKER = "../edge/founders-edge/worker.js";

let pass = 0, fail = 0;
const failures: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}  ${extra}`); }
}

// ---------------------------------------------------------------------------
// Fake Cloudflare runtime
// ---------------------------------------------------------------------------
type CacheEntry = { body: string; storedAt: number; maxAge: number };

class FakeCache {
  store = new Map<string, CacheEntry>();
  deletes: string[] = [];
  async match(req: Request) {
    const e = this.store.get(req.url);
    if (!e) return undefined;
    // Honour max-age: the "fresh" copy must actually expire, or every test
    // after the first would read a cached answer and prove nothing.
    if ((Date.now() - e.storedAt) / 1000 > e.maxAge) return undefined;
    return new Response(e.body);
  }
  async put(req: Request, res: Response) {
    const cc = res.headers.get("Cache-Control") || "";
    const m = /max-age=(\d+)/.exec(cc);
    this.store.set(req.url, {
      body: await res.text(),
      storedAt: Date.now(),
      maxAge: m ? Number(m[1]) : 0,
    });
  }
  async delete(req: Request) {
    this.deletes.push(req.url);
    return this.store.delete(req.url);
  }
}

let cache: FakeCache;
let telemetry: Array<{ hostname: string; state: string; stale_age_s?: number }>;
let hits: string[];

/** How the fake network answers. Each test sets these. */
let controlPlane: (hostname: string) => Response | "THROW";
let customerOrigin: (u: URL) => Response | "THROW";
let foundersOrigin: (u: URL) => Response | "THROW";

const realFetch = globalThis.fetch;

function installFakes() {
  cache = new FakeCache();
  telemetry = [];
  hits = [];
  (globalThis as any).caches = { default: cache };
  (globalThis as any).fetch = async (input: any, init?: any): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : input.url;
    const u = new URL(urlStr);
    hits.push(urlStr);

    if (u.pathname === "/api/public/domain-config") {
      const r = controlPlane(u.searchParams.get("hostname") || "");
      if (r === "THROW") throw new Error("control plane unreachable");
      return r;
    }
    if (u.pathname === "/api/public/edge-health") {
      telemetry.push(JSON.parse(init?.body ?? "{}"));
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }
    if (u.hostname === "www.founders.click") {
      const r = foundersOrigin(u);
      if (r === "THROW") throw new Error("founders origin unreachable");
      return r;
    }
    const r = customerOrigin(u);
    if (r === "THROW") throw new Error("customer origin unreachable");
    return r;
  };
}

function resetNetwork() {
  controlPlane = (h) => new Response(JSON.stringify(configFor(h)), { status: 200 });
  customerOrigin = (u) =>
    new Response(`customer:${u.pathname}`, { status: 200 });
  foundersOrigin = (u) => new Response(`founders:${u.pathname}`, { status: 200 });
}

// Each section uses its own hostname. reportStale throttles per hostname in
// module-level state, which is correct — a real isolate keeps that map across
// requests — so a shared hostname would let one section's report suppress the
// next section's and make throttling look like a missing event.
let hostSeq = 0;
function freshHost() { return `market${++hostSeq}.example`; }
const originFor = (h: string) => `origin.${h}`;
const configFor = (h: string) => ({
  hostname: h,
  mode: "full_proxy",
  route_prefix: "/a/",
  customer_origin: originFor(h),
  active: true,
  status: "active",
  disabled: false,
  config_version: "2026-08-30T00:00:00Z",
});

let HOST = freshHost();
let ORIGIN = originFor(HOST);
/** Start a section with a clean cache, clean network, and an unused hostname. */
function section() {
  installFakes();
  resetNetwork();
  HOST = freshHost();
  ORIGIN = originFor(HOST);
}

const ctx = { waitUntil: (p: Promise<unknown>) => { void Promise.resolve(p).catch(() => {}); } };

let worker: any;
async function get(path: string, host = HOST): Promise<Response> {
  return worker.fetch(new Request(`https://${host}${path}`), {}, ctx);
}

/** Force the fresh copy to expire without waiting, leaving the stale copy. */
function expireFresh(host = HOST) {
  const k = `https://edge-config.founders.internal/fresh/${host}`;
  const e = cache.store.get(k);
  if (e) e.storedAt = 0;
}
function ageStale(seconds: number, host = HOST) {
  const k = `https://edge-config.founders.internal/stale/${host}`;
  const e = cache.store.get(k);
  if (!e) return;
  const parsed = JSON.parse(e.body);
  parsed.cached_at = Date.now() - seconds * 1000;
  e.body = JSON.stringify(parsed);
}

installFakes();
resetNetwork();
worker = (await import(WORKER)).default;
section();

// ===========================================================================
console.log("\n=== CONTROL PLANE HEALTHY ===");
// ===========================================================================
{
  const founders = await get("/a/pool-rentals-austin");
  t("founders route serves founders content",
    founders.status === 200 && (await founders.text()).startsWith("founders:"));

  const home = await get("/");
  t("customer homepage passes through",
    home.status === 200 && (await home.text()) === "customer:/");

  const search = await get("/s?address=Austin");
  t("customer search passes through",
    search.status === 200 && (await search.text()) === "customer:/s");

  const listing = await get("/l/nice-pool/abc123");
  t("customer listing passes through",
    listing.status === 200 && (await listing.text()) === "customer:/l/nice-pool/abc123");
}

// ===========================================================================
console.log("\n=== CONTROL PLANE UNAVAILABLE (the load-bearing case) ===");
// ===========================================================================
{
  expireFresh();
  controlPlane = () => "THROW";

  const home = await get("/");
  t("customer homepage SURVIVES control-plane outage",
    home.status === 200 && (await home.text()) === "customer:/");

  const search = await get("/s?address=Austin");
  t("customer search SURVIVES control-plane outage", search.status === 200);

  const listing = await get("/l/nice-pool/abc123");
  t("customer listing SURVIVES control-plane outage", listing.status === 200);

  // Our own pages are allowed to fail; theirs are not.
  ageStale(STALE_BEYOND_HARD_LIMIT());
  expireFresh();
  const ours = await get("/a/pool-rentals-austin");
  t("founders /a/* fails CLOSED once stale config is too old (502, not customer content)",
    ours.status === 502, `got ${ours.status}`);

  const stillUp = await get("/");
  t("customer traffic still flows even while /a/* is failing", stillUp.status === 200);
}
function STALE_BEYOND_HARD_LIMIT() { return 3_601; }

// ===========================================================================
console.log("\n=== CONTROL PLANE RETURNS A BAD 404 (schema drift / bad deploy) ===");
// ===========================================================================
{
  section();
  await get("/"); // prime the cache with good config
  expireFresh();

  // A 404 that is NOT the documented disconnect signal — e.g. an unmigrated
  // column making PostgREST fail, or a CDN error page.
  controlPlane = () => new Response("<html>Not Found</html>", { status: 404 });

  const home = await get("/");
  t("ambiguous 404 does NOT take the customer down",
    home.status === 200 && (await home.text()) === "customer:/",
    `got ${home.status}`);

  const staleKey = `https://edge-config.founders.internal/stale/${HOST}`;
  t("ambiguous 404 does NOT delete last-known-good config",
    cache.store.has(staleKey) && !cache.deletes.includes(staleKey));
}

// ===========================================================================
console.log("\n=== LEGITIMATE DISCONNECT still takes effect ===");
// ===========================================================================
{
  section();
  await get("/");
  expireFresh();
  controlPlane = () =>
    new Response(JSON.stringify({ error: "domain_not_found" }), { status: 404 });

  const home = await get("/");
  t("documented disconnect signal 404s the host", home.status === 404);
  t("documented disconnect signal DOES drop stale config",
    cache.deletes.includes(`https://edge-config.founders.internal/stale/${HOST}`));
}

// ===========================================================================
console.log("\n=== STALE CONFIG ===");
// ===========================================================================
{
  section();
  await get("/");
  expireFresh();
  controlPlane = () => "THROW";
  ageStale(600); // 10 min — past the 5 min alert threshold, under the 1h limit

  const home = await get("/");
  t("last-known-good origin is used for customer paths",
    home.status === 200 && (await home.text()) === "customer:/");

  t("STALE_CONFIG telemetry event recorded",
    telemetry.some((e) => e.state === "STALE_CONFIG" && e.hostname === HOST),
    JSON.stringify(telemetry));

  const before = telemetry.length;
  for (let i = 0; i < 25; i++) { expireFresh(); ageStale(600); await get(`/p${i}`); }
  t("telemetry is throttled under sustained staleness (not one report per request)",
    telemetry.length - before === 0,
    `sent ${telemetry.length - before} extra reports for 25 requests`);

  t("/a/* still served while stale is within the hard limit",
    (await (async () => { expireFresh(); ageStale(600); return get("/a/x"); })()).status === 200);
}

// ===========================================================================
console.log("\n=== KILL SWITCH (founders_disabled = true) ===");
// ===========================================================================
{
  section();
  controlPlane = () =>
    new Response(JSON.stringify({ ...configFor(HOST), disabled: true, active: false }), { status: 200 });

  const home = await get("/");
  t("kill switch: homepage passes to customer origin",
    home.status === 200 && (await home.text()) === "customer:/");

  expireFresh();
  const ours = await get("/a/pool-rentals-austin");
  t("kill switch: EVEN /a/* passes to customer origin",
    ours.status === 200 && (await ours.text()) === "customer:/a/pool-rentals-austin",
    `got ${ours.status}`);

  expireFresh();
  const listing = await get("/l/nice-pool/abc123");
  t("kill switch: no whole-domain 404", listing.status === 200);
}

// ===========================================================================
console.log("\n=== UNKNOWN HOST ===");
// ===========================================================================
{
  section();
  // Prime a real tenant, then ask for a host the control plane rejects.
  await get("/");
  controlPlane = () =>
    new Response(JSON.stringify({ error: "domain_not_found" }), { status: 404 });

  const other = await get("/", "someone-elses-domain.example");
  t("unknown host is refused", other.status === 404);
  t("unknown host NEVER resolves to another tenant's origin",
    !hits.some((h) => h.includes(ORIGIN) && h.includes("someone-elses")));

  const body = await other.text();
  t("unknown host response leaks no tenant information",
    !body.includes(ORIGIN) && !body.includes(HOST), body.slice(0, 80));
}

// ===========================================================================
console.log("\n=== BAD ORIGIN ===");
// ===========================================================================
{
  section();
  customerOrigin = () => "THROW";

  const home = await get("/");
  t("dead customer origin fails contained (502, not a hang or a wrong tenant)",
    home.status === 502, `got ${home.status}`);
  t("dead customer origin response is uncached",
    (home.headers.get("Cache-Control") || "").includes("no-store"));

  section();
  controlPlane = () =>
    new Response(JSON.stringify({ ...configFor(HOST), customer_origin: null }), { status: 200 });
  const misconfigured = await get("/");
  t("full_proxy with no stored origin fails closed rather than serving our content",
    misconfigured.status === 502);
}

// ===========================================================================
console.log("\n=== LOOP CONTAINMENT ===");
// ===========================================================================
{
  section();
  const looped = await worker.fetch(
    new Request(`https://${HOST}/`, { headers: { "x-founders-edge": "1" } }), {}, ctx);
  t("a request already through the edge is stopped with 508", looped.status === 508);

  section();
  controlPlane = () =>
    new Response(JSON.stringify({ ...configFor(HOST), customer_origin: HOST }), { status: 200 });
  const selfOrigin = await get("/");
  t("origin equal to the hostname is refused, not proxied into itself",
    selfOrigin.status === 508, `got ${selfOrigin.status}`);
}

// ===========================================================================
console.log("\n=== PLATFORM HOSTS ===");
// ===========================================================================
{
  section();
  const platform = await get("/", "www.founders.click");
  t("founders.click passes straight through and never consults domain-config",
    platform.status === 200 && !hits.some((h) => h.includes("domain-config")));
}

(globalThis as any).fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) console.log("FAILED:\n  " + failures.join("\n  ") + "\n");
process.exit(fail ? 1 : 0);
