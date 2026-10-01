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

// Production always has the FOUNDERS_APP binding (wrangler.jsonc); here it
// delegates to the fake network, so every section below goes through it.
const ENV = {
  FOUNDERS_APP: { fetch: (input: any, init?: any) => (globalThis as any).fetch(input, init) },
};

async function get(path: string, host = HOST): Promise<Response> {
  return worker.fetch(new Request(`https://${host}${path}`), ENV, ctx);
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
const worker: any = (await import(WORKER)).default;
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
    new Request(`https://${HOST}/`, { headers: { "x-founders-edge": "1" } }), ENV, ctx);
  t("a request already through the edge is stopped with 508", looped.status === 508);

  section();
  controlPlane = () =>
    new Response(JSON.stringify({ ...configFor(HOST), customer_origin: HOST }), { status: 200 });
  const selfOrigin = await get("/");
  t("origin equal to the hostname is refused, not proxied into itself",
    selfOrigin.status === 508, `got ${selfOrigin.status}`);
}

// ===========================================================================
console.log("\n=== SAME-ZONE: THE APP IS REACHED THROUGH THE SERVICE BINDING ===");
// ===========================================================================
// founders-edge and the app (founders-click, on the route www.founders.click/*)
// share the founders.click zone. Cloudflare does not run a route's Worker for a
// global fetch() from another Worker on the same zone: the request goes to the
// zone's origin for www (the pre-cutover Lovable host, which still serves an
// old build of the app). So NOTHING bound for the app may leave through
// global fetch(), and without the binding the edge fails closed.
{
  section();
  const appCalls: Array<{ url: string; xfh: string | null; edge: string | null }> = [];
  let appConfig: "ok" | "throw" = "ok";
  const env = {
    FOUNDERS_APP: {
      fetch: async (input: any, init?: any): Promise<Response> => {
        const urlStr = typeof input === "string" ? input : input.url;
        const h = new Headers(init?.headers ?? {});
        appCalls.push({ url: urlStr, xfh: h.get("x-forwarded-host"), edge: h.get("x-founders-edge") });
        const u = new URL(urlStr);
        if (u.pathname === "/api/public/domain-config") {
          if (appConfig === "throw") throw new Error("app unreachable");
          return new Response(JSON.stringify(configFor(u.searchParams.get("hostname") || "")), { status: 200 });
        }
        if (u.pathname === "/api/public/edge-health") {
          telemetry.push(JSON.parse(init?.body ?? "{}"));
          return new Response(JSON.stringify({ ok: true }), { status: 202 });
        }
        return new Response(`app:${u.pathname}`, { status: 200 });
      },
    },
  };
  const getVia = (path: string) => worker.fetch(new Request(`https://${HOST}${path}`), env, ctx);
  const leakedToGlobal = () => hits.filter((h) => h.startsWith("https://www.founders.click"));

  const page = await getVia("/a/pool-rentals-austin");
  t("binding: /a/* is answered by the app through FOUNDERS_APP",
    page.status === 200 && (await page.text()) === "app:/a/pool-rentals-austin");
  const pageCall = appCalls.find((c) => c.url.includes("/a/pool-rentals-austin"));
  t("binding: the app is told the customer host (x-forwarded-host) and that the edge sent it",
    pageCall?.xfh === HOST && pageCall?.edge === "1", JSON.stringify(pageCall));
  t("binding: the routing config is read through FOUNDERS_APP",
    appCalls.some((c) => c.url.includes("/api/public/domain-config")));

  const home = await getVia("/");
  t("binding: customer paths still go to the customer's origin over global fetch()",
    home.status === 200 && (await home.text()) === "customer:/" && hits.some((h) => h.includes(ORIGIN)));

  expireFresh();
  ageStale(600);
  appConfig = "throw";
  await getVia("/s");
  t("binding: staleness telemetry goes through FOUNDERS_APP",
    appCalls.some((c) => c.url.includes("/api/public/edge-health")) &&
      telemetry.some((e) => e.state === "STALE_CONFIG" && e.hostname === HOST));

  t("binding: no request meant for the app left through global fetch()",
    leakedToGlobal().length === 0, leakedToGlobal().join(", "));

  const { readFileSync } = await import("node:fs");
  // JSONC: a commented-out line must not satisfy the check. "https://" inside
  // strings is preceded by ":", so it survives.
  const noComments = (txt: string) =>
    txt.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/.*$/gm, "$1");
  const edgeCfg = noComments(
    readFileSync(new URL("../edge/founders-edge/wrangler.jsonc", import.meta.url), "utf8"),
  );
  t("config: founders-edge declares the FOUNDERS_APP binding to founders-click",
    /"services"\s*:\s*\[\s*\{\s*"binding"\s*:\s*"FOUNDERS_APP"\s*,\s*"service"\s*:\s*"founders-click"\s*\}/.test(edgeCfg));
  const appCfg = noComments(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  t("config check ignores a commented-out flag",
    !/"global_fetch_strictly_public"/.test(noComments('// "compatibility_flags": ["global_fetch_strictly_public"]')));
  t("config: the app fetches its own zone's hostnames through the front door (global_fetch_strictly_public)",
    /"compatibility_flags"\s*:\s*\[[^\]]*"global_fetch_strictly_public"/.test(appCfg));
}

// ===========================================================================
console.log("\n=== NO BINDING: FAILS CLOSED, NEVER A DETOUR TO THE STALE BUILD ===");
// ===========================================================================
{
  section();
  const bare = (path: string) => worker.fetch(new Request(`https://${HOST}${path}`), {}, ctx);
  const fresh = await bare("/a/pool-rentals-austin");
  t("no binding, nothing cached: the host is refused (404), not routed",
    fresh.status === 404, `got ${fresh.status}`);

  section();
  await get("/"); // config cached through the binding
  expireFresh();
  ageStale(60);
  hits.length = 0; // only what happens WITHOUT the binding counts below
  const page = await bare("/a/pool-rentals-austin");
  t("no binding: /a/* fails closed with 502", page.status === 502, `got ${page.status}`);
  const home = await bare("/");
  t("no binding: the customer's own site still answers from last-known-good config",
    home.status === 200 && (await home.text()) === "customer:/");
  t("no binding: nothing meant for the app left through global fetch()",
    !hits.some((h) => h.startsWith("https://www.founders.click")),
    hits.filter((h) => h.startsWith("https://www.founders.click")).join(", "));
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
