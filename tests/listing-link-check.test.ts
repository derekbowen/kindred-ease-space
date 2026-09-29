/**
 * LISTING LINK CHECK. Run: bun tests/listing-link-check.test.ts
 *
 * The connection's certification opens ONE real synced listing at the URL the
 * adapter builds and accepts it only when the final answer is 200 AND the
 * page is that listing. Driven against a fake marketplace (no network):
 * ok / soft-404 / homepage redirect / password-protected (401/403) / 404 /
 * errors / redirect loops — and what gets recorded on tenant_integrations.
 */
import {
  probeListingLink,
  identifiesListing,
  checkListingLinks,
  checkListingLinksIfNeverChecked,
  normalizePageText,
  LINK_CHECK_SENTENCES,
  type LinkCheckDb,
} from "../src/lib/marketplace/certification.server";
import { isCustomerSentence } from "../src/lib/user-message";

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
const origError = console.error;
console.error = () => {};

const ID = "7a0d2d6e-4c3c-4b7a-9f0e-3c1c0e5a1b22";
const LISTING = { id: ID, title: "Heated Backyard Pool — Austin" };
const BASE = "https://pools.example.com";
const URL0 = `${BASE}/l/heated-backyard-pool-austin/${ID}`;

const html = (head: string, body = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const LISTING_PAGE = html(
  `<title>Heated Backyard Pool — Austin - $45 | Pools Near Me</title><link rel="canonical" href="${BASE}/l/${ID}">`,
  `<h1>Heated Backyard Pool — Austin</h1><script>window.__PRELOADED_STATE__ = {"id":{"uuid":"${ID}"}}</script>`,
);
const HOME_PAGE = html(`<title>Pools Near Me | Rent a private pool</title>`, `<h1>Find a pool near you</h1>`);
const SOFT_404 = html(
  `<title>Page not found | Pools Near Me</title><link rel="canonical" href="${URL0}"><meta property="og:url" content="${URL0}">`,
  `<h1>Oops, we couldn't find that page</h1><a href="/login?from=%2Fl%2Fheated-backyard-pool-austin%2F${ID}">Log in</a>`,
);

type Route = (req: { url: string; init: RequestInit }) => Response | "hang" | Promise<Response>;
function site(routes: Record<string, Route>) {
  const requests: Array<{ url: string; redirect?: RequestRedirect; ua: string | null }> = [];
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    requests.push({ url: input, redirect: init.redirect, ua: new Headers(init.headers).get("user-agent") });
    const route = routes[input];
    if (!route) return new Response("no route", { status: 404 });
    const out = route({ url: input, init });
    if (out === "hang") {
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }
    return out;
  };
  return { fetch, requests };
}
const page = (body: string, status = 200) => () => new Response(body, { status, headers: { "content-type": "text/html" } });
const redirect = (to: string, status = 301) => () => new Response(null, { status, headers: { location: to } });

try {
  console.log("\n=== identifying the listing on a page ===");
  t("the Web Template listing page (title leads <title>, h1, state) is the listing", identifiesListing(LISTING_PAGE, LISTING));
  t("the homepage is not", !identifiesListing(HOME_PAGE, LISTING));
  t("a soft-404 that echoes the requested URL (canonical, og:url, login link) is not", !identifiesListing(SOFT_404, LISTING));
  t("the id inside listing data (not a URL path) is enough", identifiesListing(html("<title>x</title>", `<div data-listing-id="${ID}"></div>`), { id: ID, title: null }));
  t("og:title in either attribute order", identifiesListing(html(`<meta content="Heated Backyard Pool — Austin | Pools" property="og:title">`), LISTING));
  t("HTML entities in the title are decoded", identifiesListing(html(`<title>Heated Backyard Pool &mdash; Austin | Pools</title>`), LISTING) && normalizePageText("A &amp; B&#39;s &#x2014;") === "a & b's —");
  t("a short title must LEAD the title or equal an h1 (Pool ≠ Pools Near Me)", !identifiesListing(HOME_PAGE, { id: "00000000-0000-4000-8000-000000000999", title: "Pool" }) && identifiesListing(html("<title>Pool | Pools Near Me</title>"), { id: "x", title: "Pool" }));
  t("a long title may sit anywhere in the title", identifiesListing(html("<title>Pools Near Me | Heated Backyard Pool — Austin</title>"), LISTING));

  console.log("\n=== classification ===");
  {
    const s = site({ [URL0]: page(LISTING_PAGE) });
    const r = await probeListingLink(URL0, LISTING, { fetch: s.fetch });
    t("ok: 200 and the page is the listing", r.result === "ok" && r.httpStatus === 200 && r.hops === 0, JSON.stringify(r));
    t("redirects are followed by the check itself (redirect: manual), as a named client", s.requests[0]!.redirect === "manual" && /founders\.click-link-check/.test(s.requests[0]!.ua ?? ""));
  }
  {
    const moved = `${BASE}/l/new-slug/${ID}`;
    const s = site({ [URL0]: redirect(`/l/new-slug/${ID}`), [moved]: page(LISTING_PAGE) });
    const r = await probeListingLink(URL0, LISTING, { fetch: s.fetch });
    t("ok after a redirect that still lands on the listing (slug canonicalisation)", r.result === "ok" && r.hops === 1 && r.finalUrl === moved, JSON.stringify(r));
  }
  {
    const www = URL0.replace("://pools.", "://www.pools.");
    const s = site({ [URL0]: redirect(www, 308), [www]: page(LISTING_PAGE) });
    const r = await probeListingLink(URL0, LISTING, { fetch: s.fetch });
    t("ok after apex → www", r.result === "ok" && r.hops === 1);
  }
  {
    const s = site({ [URL0]: page(SOFT_404) });
    const r = await probeListingLink(URL0, LISTING, { fetch: s.fetch });
    t("soft-404 (200 'not found' at the same URL) → not_found", r.result === "not_found" && r.httpStatus === 200 && r.hops === 0, JSON.stringify(r));
  }
  {
    const s = site({ [URL0]: redirect("/", 302), [`${BASE}/`]: page(HOME_PAGE) });
    const r = await probeListingLink(URL0, LISTING, { fetch: s.fetch });
    t("a redirect to the homepage → redirected", r.result === "redirected" && r.finalUrl === `${BASE}/` && r.hops === 1, JSON.stringify(r));
  }
  {
    const s = site({ [URL0]: () => new Response("Authentication required", { status: 401, headers: { "www-authenticate": 'Basic realm="test marketplace"' } }) });
    const r = await probeListingLink(URL0, LISTING, { fetch: s.fetch });
    t("401 (a password-protected test marketplace) → auth_required", r.result === "auth_required" && r.httpStatus === 401);
    const s2 = site({ [URL0]: page("Forbidden", 403) });
    t("403 → auth_required", (await probeListingLink(URL0, LISTING, { fetch: s2.fetch })).result === "auth_required");
  }
  {
    const s = site({ [URL0]: page("gone", 404) });
    const s2 = site({ [URL0]: page("gone", 410) });
    t("404 / 410 → not_found", (await probeListingLink(URL0, LISTING, { fetch: s.fetch })).result === "not_found" && (await probeListingLink(URL0, LISTING, { fetch: s2.fetch })).result === "not_found");
  }
  {
    const s = site({ [URL0]: page("boom", 502) });
    t("5xx → error (unverified, not 'broken')", (await probeListingLink(URL0, LISTING, { fetch: s.fetch })).result === "error");
    const s2 = site({ [URL0]: () => Promise.reject(new TypeError("fetch failed")) });
    t("network failure → error", (await probeListingLink(URL0, LISTING, { fetch: s2.fetch })).result === "error");
    const s3 = site({ [URL0]: () => "hang" });
    const started = Date.now();
    const r3 = await probeListingLink(URL0, LISTING, { fetch: s3.fetch, timeoutMs: 40 });
    t("a hung request times out (bounded) → error", r3.result === "error" && Date.now() - started < 3000 && /timed out/.test(r3.detail), JSON.stringify(r3));
  }
  {
    const a = `${BASE}/a`;
    const b = `${BASE}/b`;
    const s = site({ [URL0]: redirect(a, 302), [a]: redirect(b, 302), [b]: redirect(a, 302) });
    const r = await probeListingLink(URL0, LISTING, { fetch: s.fetch });
    t("a redirect loop stops after 5 hops → redirected", r.result === "redirected" && s.requests.length === 6, `${r.result} ${s.requests.length}`);
    const s2 = site({ [URL0]: () => new Response(null, { status: 302 }) });
    t("a redirect with no Location → error", (await probeListingLink(URL0, LISTING, { fetch: s2.fetch })).result === "error");
    for (const inward of ["http://169.254.169.254/latest/meta-data/", "http://localhost:8080/admin", "http://[::1]/", "http://intranet/"]) {
      const s3 = site({ [URL0]: redirect(inward, 302) });
      const r3 = await probeListingLink(URL0, LISTING, { fetch: s3.fetch });
      t(`a redirect to a non-public host (${new URL(inward).host}) is not followed`, r3.result === "redirected" && s3.requests.length === 1, JSON.stringify(r3));
    }
  }
  {
    // A huge page is read only up to the byte cap (the head is what matters).
    const big = LISTING_PAGE + "x".repeat(3_000_000);
    const s = site({ [URL0]: page(big) });
    const r = await probeListingLink(URL0, LISTING, { fetch: s.fetch, maxBodyBytes: 200_000 });
    t("the body read is bounded and still finds the listing in the head", r.result === "ok");
  }

  console.log("\n=== checkListingLinks: the adapter's URL, recorded on the integration ===");
  function fakeDb(opts: { integration?: any; sample?: any; saveFails?: boolean } = {}) {
    const saves: Array<{ id: string; patch: Record<string, any> }> = [];
    const db: LinkCheckDb = {
      loadIntegration: async () =>
        opts.integration === undefined
          ? { id: "int-1", marketplace_url: BASE, route_config: {}, certification_detail: {} }
          : opts.integration,
      sampleListing: async () =>
        opts.sample === undefined ? { sharetribe_listing_id: ID, slug: "heated-backyard-pool-austin", title: LISTING.title } : opts.sample,
      saveResult: async (id, patch) => {
        if (opts.saveFails) throw new Error("certification_save_failed:boom");
        saves.push({ id, patch });
      },
    };
    return { db, saves };
  }
  {
    const s = site({ [URL0]: page(LISTING_PAGE) });
    const { db, saves } = fakeDb();
    const r = await checkListingLinks("ws-1", { db, probe: { fetch: s.fetch, now: () => Date.parse("2026-09-28T12:00:00Z") } });
    t("probes exactly the URL the adapter builds for a real synced listing", s.requests[0]!.url === URL0 && r.url === URL0);
    const p = saves[0]?.patch ?? {};
    t("ok → CERTIFIED, certified_at, no error, detail.listing_link recorded", r.result === "ok" && r.saved && p.certification_status === "CERTIFIED" && p.certified_at === "2026-09-28T12:00:00.000Z" && p.certification_error === null && p.certification_detail?.listing_link?.result === "ok" && p.certification_detail?.listing_link?.url === URL0, JSON.stringify(p));
  }
  {
    const custom = `${BASE}/hunts/${ID}`;
    const s = site({ [custom]: page(LISTING_PAGE) });
    const { db } = fakeDb({ integration: { id: "int-1", marketplace_url: BASE, route_config: { listingRouteTemplate: "/hunts/{id}" }, certification_detail: {} } });
    const r = await checkListingLinks("ws-1", { db, probe: { fetch: s.fetch } });
    t("a marketplace's own listing route (route_config) is what gets checked", s.requests[0]!.url === custom && r.result === "ok");
  }
  for (const [label, route, status, result] of [
    ["soft-404", page(SOFT_404), "FAILED", "not_found"],
    ["homepage redirect", redirect("/", 302), "FAILED", "redirected"],
    ["401", page("auth", 401), "DEGRADED", "auth_required"],
    ["503", page("down", 503), "DEGRADED", "error"],
  ] as const) {
    const s = site({ [URL0]: route, [`${BASE}/`]: page(HOME_PAGE) });
    const { db, saves } = fakeDb();
    const r = await checkListingLinks("ws-1", { db, probe: { fetch: s.fetch } });
    const p = saves[0]?.patch ?? {};
    t(`${label} → ${result}, certification_status ${status}, a customer sentence as the error, no certified_at`, r.result === result && p.certification_status === status && p.certified_at === null && p.certification_error === LINK_CHECK_SENTENCES[result] && p.certification_detail?.listing_link?.result === result, JSON.stringify(p));
  }
  {
    const { db, saves } = fakeDb({ sample: null });
    const r = await checkListingLinks("ws-1", { db, probe: { fetch: site({}).fetch } });
    t("no synced listings → no_listings, nothing recorded", r.result === "no_listings" && saves.length === 0 && r.sentence === LINK_CHECK_SENTENCES.no_listings);
    const { db: db2, saves: saves2 } = fakeDb({ integration: null });
    const r2 = await checkListingLinks("ws-1", { db: db2, probe: { fetch: site({}).fetch } });
    t("not connected → not_connected, nothing recorded", r2.result === "not_connected" && saves2.length === 0);
  }
  {
    const s = site({ [URL0]: page(LISTING_PAGE) });
    const { db } = fakeDb({ saveFails: true });
    const r = await checkListingLinks("ws-1", { db, probe: { fetch: s.fetch } });
    t("a failed save is reported (saved: false), the result still returned", r.result === "ok" && r.saved === false);
  }
  {
    const s = site({ [URL0]: page(LISTING_PAGE) });
    const { db, saves } = fakeDb({ integration: { id: "int-1", marketplace_url: BASE, route_config: {}, certification_detail: { listing_link: { result: "not_found", checked_at: "2026-09-27T00:00:00Z" } } } });
    const r = await checkListingLinksIfNeverChecked("ws-1", { db, probe: { fetch: s.fetch } });
    t("after a sync: a result already on record → no new check", r === null && s.requests.length === 0 && saves.length === 0);
    const { db: db2, saves: saves2 } = fakeDb();
    const r2 = await checkListingLinksIfNeverChecked("ws-1", { db: db2, probe: { fetch: s.fetch } });
    t("after the first successful sync (nothing on record) → checked and recorded", r2?.result === "ok" && saves2.length === 1);
  }
  const bad = Object.values(LINK_CHECK_SENTENCES).filter((s) => !isCustomerSentence(s));
  t("every link-check sentence is a customer sentence", bad.length === 0, bad.join(" | "));
} finally {
  console.error = origError;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
