/**
 * THE SHARETRIBE SYNC RUN, DRIVEN. Run: bun tests/sharetribe-sync-run.test.ts
 *
 * The REAL runSharetribeSyncForWorkspace against a fake Sharetribe API and an
 * in-memory store whose four lease functions have the SQL's semantics
 * (tests/_support/sharetribe-fakes.ts; the SQL itself is proven on
 * PostgreSQL 16 by tests/mvp-migrations.pg.ts). Offline, no credentials.
 *
 * What must hold: a snapshot counts as complete only when Sharetribe's
 * pagination facts are present and consistent and every listing was read;
 * only a complete snapshot removes anything (in one reconcile, no row cap);
 * anything less is PARTIAL with nothing removed and last_success_at unmoved;
 * a second run never overlaps the first; a run that loses its lease stops;
 * a confirmed-empty catalogue is removed only on the second strike, 20+
 * minutes later; Retry-After is honoured; requests time out.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runSharetribeSyncForWorkspace,
  runSharetribeSyncBounded,
  readListingPlace,
  readListingCategory,
  readPriceUnit,
  retryAfterMs,
  mapListing,
  INTEGRATION_LISTING_FIELDS,
  SHARETRIBE_UNAVAILABLE_MESSAGE,
  SYNC_SENTENCES,
  type SyncLimits,
  type SyncDb,
} from "../src/lib/sharetribe-sync.server";
import { listingKeys } from "../src/lib/coverage/target";
import { isCustomerSentence } from "../src/lib/user-message";
import { Clock, FakeSharetribe, ListingStore, iso, uuid, type FakeListing } from "./_support/sharetribe-fakes";

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

// The run logs its own failures on purpose; keep the output readable.
const origError = console.error;
console.error = () => {};

const WS = uuid(1, 0xa11ce);
const OTHER_WS = uuid(2, 0xa11ce);
const DAY = 86_400_000;
const MIN = 60_000;

let runSeq = 0;
function world(opts: { mode?: "marketplace" | "integration"; limits?: Partial<SyncLimits> } = {}) {
  const clock = new Clock();
  const store = new ListingStore(clock.now);
  const api = new FakeSharetribe(clock);
  store.addIntegration(WS, { auth_mode: opts.mode ?? "marketplace" });
  const deps = (limits: Partial<SyncLimits> = {}) => ({
    fetch: api.fetch,
    db: store.asSyncDb(),
    now: clock.now,
    sleep: clock.sleep,
    newRunId: () => uuid(++runSeq, 0x2a2a),
    limits: { requestTimeoutMs: 40, ...(opts.limits ?? {}), ...limits },
  });
  const run = (limits: Partial<SyncLimits> = {}, ws = WS) => runSharetribeSyncForWorkspace(ws, deps(limits));
  return { clock, store, api, run, deps, row: () => store.integration(WS)! };
}

const PLACES = [
  { city: "Austin", state: "TX", country: "US" },
  { city: "Portland", state: "Oregon", country: "United States" },
  { city: "Portland", state: "ME", country: "US" },
  { city: "Toronto", state: "Ontario", country: "Canada" },
  { city: "São Paulo", state: "SP", country: "Brazil" },
];
const CATEGORIES = ["Pool", "Hot tub", "pool", "Sauna"];

/** A catalogue with the public-data shapes real marketplaces use. */
function makeCatalog(n: number, group = 1): FakeListing[] {
  return Array.from({ length: n }, (_, i) => {
    const place = PLACES[i % PLACES.length]!;
    const shape = i % 4;
    const pub: Record<string, unknown> =
      shape === 0
        ? { ...place }
        : shape === 1
          ? { location: { ...place, address: "123 Main St" } }
          : shape === 2
            ? {
                addressComponents: [
                  { long_name: place.city, short_name: place.city, types: ["locality", "political"] },
                  { long_name: place.state, short_name: place.state, types: ["administrative_area_level_1"] },
                  { long_name: place.country, short_name: place.country, types: ["country", "political"] },
                ],
              }
            : { location: { address: "1 Unknown Road, Somewhere 12345" } };
    if (i % 3 === 0) pub.category = CATEGORIES[i % CATEGORIES.length];
    else if (i % 3 === 1) pub.categoryLevel1 = "hot-tubs";
    pub.unitType = i % 2 ? "Day" : "hour";
    return {
      id: uuid(i + 1, group),
      title: `Listing ${i + 1}`,
      price: { amount: 1000 + i, currency: "usd" },
      publicData: pub,
      authorId: uuid(900_000 + (i % 7), group),
      images: [{ id: uuid(500_000 + i, group), url: `https://cdn.example.com/${i}.jpg` }],
    };
  });
}

/** What the listing states, independently of the mapper. */
function expectedKeys(i: number) {
  const place = PLACES[i % PLACES.length]!;
  const stated = i % 4 === 3 ? { city: null, state: null, country: null } : place;
  const category = i % 3 === 0 ? CATEGORIES[i % CATEGORIES.length]! : i % 3 === 1 ? "hot-tubs" : null;
  return listingKeys({ ...stated, category });
}

try {
  // ==========================================================================
  console.log("\n=== 1. 2,500 listings over 25 pages: complete, keyed, stamped, reconciled ===");
  // ==========================================================================
  {
    const w = world();
    w.api.catalog = makeCatalog(2500);
    const old = iso(w.clock.now() - DAY);
    for (const l of w.api.catalog.slice(0, 2400)) w.store.seedListing(WS, l.id, old);
    const stale = Array.from({ length: 100 }, (_, i) => uuid(10_000 + i, 1));
    for (const id of stale) w.store.seedListing(WS, id, old);
    for (let i = 0; i < 5; i++) w.store.seedListing(OTHER_WS, uuid(20_000 + i, 1), old);
    const claimAt = w.clock.now();

    const r = await w.run();
    t("status success, 2,500 upserted, the 100 stale removed", r.status === "success" && r.upserted === 2500 && r.removed === 100, JSON.stringify({ ...r, sentence: undefined }));
    t("the reply counts are exact (listings_count 2,500 of upstream 2,500, 25 pages)", r.listingsCount === 2500 && r.upstreamTotal === 2500 && r.pagesRead === 25 && r.recorded);
    const reqs = w.api.listingRequests();
    t("25 listings requests, pages 1..25 in order", reqs.length === 25 && reqs.every((q, i) => q.url.searchParams.get("page") === String(i + 1)));
    t("every request asks perPage=100 (Sharetribe's parameter), never per_page", reqs.every((q) => q.url.searchParams.get("perPage") === "100" && !q.url.searchParams.has("per_page")));
    const mine = w.store.listingsOf(WS);
    t("exactly the 2,500 upstream listings remain for the workspace", mine.length === 2500 && stale.every((id) => !mine.some((l) => l.sharetribe_listing_id === id)));
    const stamps = new Set(mine.map((l) => l.synced_at));
    const startedAt = (w.row().sync_progress as any)?.started_at;
    t("every row carries the same synced_at = the run's start", stamps.size === 1 && stamps.has(startedAt) && Date.parse(startedAt) >= claimAt, [...stamps].slice(0, 3).join(","));
    t("another workspace's rows are untouched", w.store.listingsOf(OTHER_WS).length === 5 && w.store.listingsOf(OTHER_WS).every((l) => l.synced_at === old));
    const byId = new Map(mine.map((l) => [l.sharetribe_listing_id, l]));
    let keyed = 0;
    for (let i = 0; i < 2500; i++) {
      const row = byId.get(w.api.catalog[i]!.id)!;
      const k = expectedKeys(i);
      if (row.country_key === k.countryKey && row.region_key === k.regionKey && row.city_key === k.cityKey && row.category_key === k.categoryKey) keyed++;
    }
    t("all 2,500 rows carry country/region/city/category keys from listingKeys()", keyed === 2500, `${keyed} of 2500`);
    const portland = byId.get(w.api.catalog[1]!.id)!; // location object: Portland, Oregon, United States
    const saoPaulo = byId.get(w.api.catalog[4]!.id)!; // flat: São Paulo, SP, Brazil
    const components = byId.get(w.api.catalog[2]!.id)!; // address components: Portland, ME, US
    const unplaced = byId.get(w.api.catalog[3]!.id)!; // a free-form address only
    t("publicData.location.{city,state,country} → portland / or / us", portland.city_key === "portland" && portland.region_key === "or" && portland.country_key === "us", JSON.stringify([portland.city_key, portland.region_key, portland.country_key]));
    t("flat publicData.city/state/country → sao-paulo / sp / br", saoPaulo.city_key === "sao-paulo" && saoPaulo.region_key === "sp" && saoPaulo.country_key === "br");
    t("address components → portland / me / us", components.city_key === "portland" && components.region_key === "me" && components.country_key === "us");
    t("a free-form address string is never parsed: no place, no keys", unplaced.city === null && unplaced.city_key === null && unplaced.region_key === null && unplaced.country_key === null);
    t("category from publicData.categoryLevel1 when there is no category", portland.category === "hot-tubs" && portland.category_key === "hot-tubs");
    t("price_unit from publicData.unitType, lowercase", portland.price_unit === "day" && byId.get(w.api.catalog[0]!.id)!.price_unit === "hour");
    t("currency normalised to upper case", portland.price_currency === "USD");

    const log = w.store.log;
    const first = (name: string) => log.indexOf(name);
    const lastUpsert = log.map((x, i) => (x.startsWith("upsert:") ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    t("the lease is claimed before anything else is written", first("claim_listing_sync") === 1 && log[0] === "load");
    t("touched once per page (25), each before that page's upsert", log.filter((x) => x === "touch_listing_sync").length === 25 && log.every((x, i) => !x.startsWith("upsert:") || log[i - 1] === "touch_listing_sync"));
    t("reconcile runs once, after the last upsert; finish is last", log.filter((x) => x === "reconcile_listing_sync").length === 1 && first("reconcile_listing_sync") > lastUpsert && log[log.length - 1] === "finish_listing_sync");
    t("nothing is deleted outside reconcile", !log.includes("deleteAll"));
    const row = w.row();
    t("finish recorded the success: status, last_success_at, counts, no error, lease released", row.last_sync_status === "success" && row.last_success_at !== null && row.listings_count === 2500 && row.upstream_total === 2500 && row.last_sync_error === null && row.sync_lease_until === null);
    t("the reply sentence counts what happened", r.sentence === "Synced 2,500 listings and removed 100 that are no longer published." && isCustomerSentence(r.sentence), r.sentence);
    t("pages are paced (24 × 250 ms)", w.clock.sleeps.length === 24 && w.clock.sleeps.every((s) => s === 250), JSON.stringify(w.clock.sleeps.slice(0, 5)));
  }

  // ==========================================================================
  console.log("\n=== 2. Missing or malformed pagination facts → PARTIAL, nothing removed ===");
  // ==========================================================================
  for (const [label, rewrite] of [
    ["page 1 without totalPages", (p: number, m: any) => (p === 1 ? { ...m, totalPages: undefined } : m)],
    ["page 1 with totalPages null", (p: number, m: any) => (p === 1 ? { ...m, totalPages: null } : m)],
    ["paginationUnsupported", (p: number, m: any) => ({ ...m, totalItems: null, totalPages: null, paginationUnsupported: true })],
    ["no meta at all", () => ({})],
  ] as const) {
    const w = world();
    w.api.catalog = makeCatalog(250);
    w.api.meta = rewrite as any;
    const old = iso(w.clock.now() - DAY);
    for (let i = 0; i < 20; i++) w.store.seedListing(WS, uuid(30_000 + i, 1), old);
    const r = await w.run();
    t(`${label}: partial (missing_pagination) after page 1 only`, r.status === "partial" && r.reason === "missing_pagination" && w.api.listingRequests().length === 1 && r.upserted === 100, `${r.status} ${r.reason} ${w.api.listingRequests().length}`);
    t(`${label}: nothing removed, no reconcile, last_success_at unmoved`, w.store.listingsOf(WS).length === 120 && !w.store.log.includes("reconcile_listing_sync") && w.row().last_success_at === null);
    t(`${label}: recorded as partial with the reason in a customer sentence`, w.row().last_sync_status === "partial" && w.row().last_sync_error === r.sentence && /removed nothing/.test(r.sentence) && isCustomerSentence(r.sentence), r.sentence);
  }
  {
    const w = world();
    w.api.catalog = makeCatalog(250);
    w.api.meta = (p, m) => (p === 2 ? { ...m, totalPages: undefined } : m);
    const r = await w.run();
    t("a later page without totalPages also stops the run as partial", r.status === "partial" && r.reason === "missing_pagination" && w.api.listingRequests().length === 2 && !w.store.log.includes("reconcile_listing_sync"));
    const w2 = world();
    w2.api.catalog = makeCatalog(250);
    w2.api.meta = (p, m) => (p === 2 ? { ...m, page: 1 } : m);
    const r2 = await w2.run();
    t("a page that answers for the wrong page number is not trusted", r2.status === "partial" && r2.reason === "missing_pagination");
  }

  // ==========================================================================
  console.log("\n=== 3. Offset drift → PARTIAL ===");
  // ==========================================================================
  {
    const w = world();
    w.api.catalog = makeCatalog(250);
    const old = iso(w.clock.now() - DAY);
    for (let i = 0; i < 10; i++) w.store.seedListing(WS, uuid(40_000 + i, 1), old);
    w.api.beforePage = (page) => {
      if (page === 2) w.api.catalog.unshift({ id: uuid(77_777, 1), title: "Brand new", publicData: {} });
    };
    const r = await w.run();
    t("totalItems changes between pages (250 → 251) → partial (count_changed)", r.status === "partial" && r.reason === "count_changed", `${r.status} ${r.reason}`);
    t("…every page is still read and saved, nothing is removed", w.api.listingRequests().length === 3 && r.upserted === 250 && w.store.listingsOf(WS).length === 260 && !w.store.log.includes("reconcile_listing_sync"));
    t("…the sentence says the listings changed while we read them", /changed while we were reading/.test(r.sentence));
  }
  {
    const w = world();
    w.api.catalog = makeCatalog(250);
    // Same total, but the order moved: one listing is skipped, another read twice.
    w.api.beforePage = (page) => {
      if (page === 2) w.api.catalog.push(w.api.catalog.shift()!);
    };
    const r = await w.run();
    t("distinct listings read ≠ totalItems at the end → partial (count_mismatch)", r.status === "partial" && r.reason === "count_mismatch", `${r.status} ${r.reason}`);
    t("…and nothing is removed", !w.store.log.includes("reconcile_listing_sync"));
  }

  // ==========================================================================
  console.log("\n=== 4. Rate limits and server errors: Retry-After honoured, 3 tries ===");
  // ==========================================================================
  {
    const w = world();
    w.api.catalog = makeCatalog(250);
    w.api.answer = (page, attempt) =>
      page === 2 && attempt === 1 ? new Response("", { status: 429, headers: { "Retry-After": "2" } }) : undefined;
    const r = await w.run();
    t("429 with Retry-After: 2 → waits 2 s, retries, completes", r.status === "success" && w.api.attempts.get(2) === 2 && w.clock.sleeps.includes(2000), JSON.stringify(w.clock.sleeps));
    t("…and paces the rest of the run at ≥ 1.1 s per page", JSON.stringify(w.clock.sleeps) === JSON.stringify([250, 2000, 1100]), JSON.stringify(w.clock.sleeps));
  }
  {
    const w = world();
    w.api.catalog = makeCatalog(150);
    w.api.answer = (page, attempt) =>
      page === 2 && attempt === 1 ? new Response("", { status: 429, headers: { "Retry-After": "120" } }) : undefined;
    const r = await w.run();
    t("a Retry-After beyond the cap is waited for at most 10 s", r.status === "success" && w.clock.sleeps.includes(10_000) && !w.clock.sleeps.includes(120_000), JSON.stringify(w.clock.sleeps));
  }
  {
    const w = world();
    w.api.catalog = makeCatalog(150);
    w.api.answer = (page, attempt) => (page === 2 && attempt <= 2 ? new Response("down", { status: 503 }) : undefined);
    const r = await w.run();
    t("503 twice then 200 → backs off 1 s then 3 s, completes", r.status === "success" && w.api.attempts.get(2) === 3 && JSON.stringify(w.clock.sleeps) === JSON.stringify([250, 1000, 3000]), JSON.stringify(w.clock.sleeps));
  }
  {
    const w = world();
    w.api.catalog = makeCatalog(250);
    const old = iso(w.clock.now() - DAY);
    for (let i = 0; i < 7; i++) w.store.seedListing(WS, uuid(41_000 + i, 1), old);
    w.api.answer = (page) => (page === 2 ? new Response("", { status: 429 }) : undefined);
    const r = await w.run();
    t("429 on all 3 tries → partial (upstream_error) after exactly 3 tries", r.status === "partial" && r.reason === "upstream_error" && w.api.attempts.get(2) === 3, `${r.status} ${r.reason} ${w.api.attempts.get(2)}`);
    t("…keeps page 1, removes nothing, says Sharetribe stopped answering", r.upserted === 100 && w.store.listingsOf(WS).length === 107 && /Sharetribe stopped answering after 100 of 250 listings/.test(r.sentence), r.sentence);
  }
  t("retryAfterMs reads seconds and HTTP dates, ignores junk", retryAfterMs("2", 0) === 2000 && retryAfterMs("1.5", 0) === 1500 && retryAfterMs(new Date(60_000).toUTCString(), 0) === 60_000 && retryAfterMs("soon", 0) === null && retryAfterMs(null, 0) === null);

  // ==========================================================================
  console.log("\n=== 5. Per-request timeout ===");
  // ==========================================================================
  {
    const w = world();
    w.api.catalog = makeCatalog(250);
    const old = iso(w.clock.now() - DAY);
    for (let i = 0; i < 5; i++) w.store.seedListing(WS, uuid(42_000 + i, 1), old);
    w.api.answer = (page) => (page === 2 ? "hang" : undefined);
    const started = Date.now();
    const r = await w.run({ requestTimeoutMs: 30 });
    t("a page that never answers is abandoned by the per-request timeout (3 tries)", w.api.attempts.get(2) === 3 && Date.now() - started < 5000, `${w.api.attempts.get(2)} tries, ${Date.now() - started} ms`);
    t("…the run is partial: page 1 kept, nothing removed", r.status === "partial" && r.reason === "upstream_error" && r.upserted === 100 && w.store.listingsOf(WS).length === 105 && !w.store.log.includes("reconcile_listing_sync"));
    t("…with backoff between tries (1 s, 3 s)", w.clock.sleeps.includes(1000) && w.clock.sleeps.includes(3000));
  }
  {
    const w = world();
    w.api.catalog = makeCatalog(250);
    const old = iso(w.clock.now() - DAY);
    for (let i = 0; i < 5; i++) w.store.seedListing(WS, uuid(43_000 + i, 1), old);
    w.api.answer = (page) => (page === 1 ? "hang" : undefined);
    const r = await w.run({ requestTimeoutMs: 30 });
    t("page 1 timing out → failed: nothing written, nothing removed", r.status === "failed" && r.upserted === 0 && w.store.listingsOf(WS).length === 5 && !w.store.log.some((x) => x.startsWith("upsert:") || x === "reconcile_listing_sync"));
    t("…'not answering' sentence recorded; the connection is not flipped to error", r.sentence === SHARETRIBE_UNAVAILABLE_MESSAGE && w.row().last_sync_status === "failed" && w.row().last_sync_error === SHARETRIBE_UNAVAILABLE_MESSAGE && w.row().status === "connected" && w.row().last_success_at === null);
  }

  // ==========================================================================
  console.log("\n=== 6. One run at a time: a held lease → already_running, no writes ===");
  // ==========================================================================
  {
    const w = world();
    w.api.catalog = makeCatalog(50);
    const holder = uuid(4242, 0xbeef);
    Object.assign(w.row(), { sync_run_id: holder, sync_lease_until: iso(w.clock.now() + 60_000) });
    const before = JSON.stringify(w.row());
    w.store.seedListing(WS, uuid(44_000, 1), iso(w.clock.now() - DAY));
    const r = await w.run();
    t("status already_running with the polite sentence", r.status === "already_running" && r.sentence === SYNC_SENTENCES.alreadyRunning && isCustomerSentence(r.sentence));
    t("only the row read and the claim happened", JSON.stringify(w.store.log) === JSON.stringify(["load", "claim_listing_sync"]), JSON.stringify(w.store.log));
    t("Sharetribe was never called; listings and the row are untouched", w.api.requests.length === 0 && w.store.listingsOf(WS).length === 1 && JSON.stringify(w.row()) === before);
  }
  {
    const w = world();
    w.api.catalog = makeCatalog(50);
    Object.assign(w.row(), { sync_run_id: uuid(1, 0xdead), sync_lease_until: iso(w.clock.now() - 1000) });
    const r = await w.run();
    t("an EXPIRED lease (a crashed run) is taken over", r.status === "success");
  }

  // ==========================================================================
  console.log("\n=== 7. A run that loses its lease stops; disconnect mid-run cleans up ===");
  // ==========================================================================
  {
    const w = world();
    w.api.catalog = makeCatalog(350);
    const old = iso(w.clock.now() - DAY);
    for (let i = 0; i < 9; i++) w.store.seedListing(WS, uuid(45_000 + i, 1), old);
    let touches = 0;
    w.store.onCall = (name) => {
      if (name === "touch_listing_sync" && ++touches === 3) {
        // Another run took over (its claim happened after ours lapsed).
        Object.assign(w.row(), { sync_run_id: uuid(7, 0xbeef), sync_lease_until: iso(w.clock.now() + 300_000) });
      }
    };
    const r = await w.run();
    t("lease lost at page 3 → the run stops (partial, lease_lost)", r.status === "partial" && r.reason === "lease_lost" && r.upserted === 200 && w.api.listingRequests().length === 3, `${r.status} ${r.reason} ${r.upserted}`);
    t("…page 3 is never written, nothing is reconciled", w.store.log.filter((x) => x.startsWith("upsert:")).length === 2 && !w.store.log.includes("reconcile_listing_sync"));
    t("…its finish is refused (not recorded) and the other run's lease stands", !r.recorded && w.row().sync_run_id === uuid(7, 0xbeef) && w.row().sync_lease_until !== null);
    t("…the row still exists, so nothing is cleaned up", !r.cleanedUp && !w.store.log.includes("deleteAll") && w.store.listingsOf(WS).length === 209);
  }
  {
    const w = world();
    w.api.catalog = makeCatalog(350);
    let upserts = 0;
    w.store.onCall = (name) => {
      if (name.startsWith("upsert:") && ++upserts === 3) {
        // The owner pressed Disconnect between this run's touch and its upsert.
        w.store.listings = w.store.listings.filter((l) => l.workspace_id !== WS);
        w.store.removeIntegration(WS);
      }
    };
    const r = await w.run();
    t("disconnect mid-run: the next touch fails and the run stops", r.status === "partial" && r.reason === "lease_lost" && w.api.listingRequests().length === 4);
    t("…finding the row gone, it deletes what it wrote (no orphaned listings)", r.cleanedUp && w.store.listingsOf(WS).length === 0 && w.store.log.includes("deleteAll"));
  }

  // ==========================================================================
  console.log("\n=== 8. A confirmed-empty catalogue: two strikes, 20+ minutes apart ===");
  // ==========================================================================
  {
    const w = world();
    w.api.catalog = [];
    const old = iso(w.clock.now() - DAY);
    for (let i = 0; i < 50; i++) w.store.seedListing(WS, uuid(46_000 + i, 1), old);
    const t1 = w.clock.now();
    const r1 = await w.run();
    t("strike 1: warning, nothing removed", r1.status === "warning" && w.store.listingsOf(WS).length === 50 && !w.store.log.includes("reconcile_listing_sync"));
    t("…with the clear sentence customers are told about", /^Sharetribe returned no published listings/.test(r1.sentence) && w.row().last_sync_error === r1.sentence && isCustomerSentence(r1.sentence), r1.sentence);
    t("…strike recorded in sync_state; last_success_at unmoved", JSON.stringify(w.row().sync_state) === JSON.stringify({ empty_strikes: 1, first_empty_at: iso(t1) }) && w.row().last_success_at === null && w.row().listings_count === 50, JSON.stringify(w.row().sync_state));
    w.clock.advance(5 * MIN);
    const r2 = await w.run();
    t("5 minutes later: still a warning, still nothing removed, the first strike's time kept", r2.status === "warning" && w.store.listingsOf(WS).length === 50 && (w.row().sync_state as any).first_empty_at === iso(t1) && (w.row().sync_state as any).empty_strikes === 2);
    w.clock.advance(16 * MIN);
    const r3 = await w.run();
    t("21 minutes after the first: the old listings are removed (reconcile), success", r3.status === "success" && r3.removed === 50 && w.store.listingsOf(WS).length === 0 && w.store.log.includes("reconcile_listing_sync"));
    t("…listings_count 0, strikes reset, last_success_at set", w.row().listings_count === 0 && (w.row().sync_state as any).empty_strikes === 0 && w.row().last_success_at !== null && w.row().last_sync_error === null);
    t("…and the sentence says why they went", /again returned no published listings/.test(r3.sentence) && isCustomerSentence(r3.sentence), r3.sentence);
  }
  {
    const w = world();
    w.api.catalog = [];
    const old = iso(w.clock.now() - DAY);
    for (let i = 0; i < 4; i++) w.store.seedListing(WS, uuid(47_000 + i, 1), old);
    await w.run(); // strike 1
    w.clock.advance(10 * MIN);
    w.api.catalog = makeCatalog(3);
    const r = await w.run();
    t("a non-empty snapshot in between resets the strikes", r.status === "success" && (w.row().sync_state as any).empty_strikes === 0);
    w.clock.advance(30 * MIN);
    w.api.catalog = [];
    const r2 = await w.run();
    t("…so the next empty answer is strike 1 again (nothing removed), even 40 minutes after the first", r2.status === "warning" && w.store.listingsOf(WS).length === 3);
  }
  {
    const w = world();
    w.api.catalog = [];
    const r = await w.run();
    t("empty upstream AND nothing stored → success, no warning", r.status === "success" && r.sentence === SYNC_SENTENCES.emptyBoth && w.row().listings_count === 0 && w.row().last_success_at !== null);
  }
  {
    const w = world();
    w.api.catalog = makeCatalog(5);
    w.api.meta = (p, m) => ({ ...m, totalItems: 0, totalPages: 0 });
    w.store.seedListing(WS, uuid(48_000, 1), iso(w.clock.now() - DAY));
    const r = await w.run();
    t("'0 listings' with listings attached is not a confirmed-empty answer → partial", r.status === "partial" && w.store.listingsOf(WS).length === 6 && !w.store.log.includes("reconcile_listing_sync"));
  }

  // ==========================================================================
  console.log("\n=== 9. Reconcile has no row cap: 1,500 stale local rows all go ===");
  // ==========================================================================
  {
    const w = world();
    w.api.catalog = makeCatalog(120);
    const old = iso(w.clock.now() - DAY);
    for (let i = 0; i < 1500; i++) w.store.seedListing(WS, uuid(50_000 + i, 1), old);
    for (const l of w.api.catalog) w.store.seedListing(WS, l.id, old);
    const r = await w.run();
    t("1,500 stale rows removed in one reconcile, the 120 current ones kept", r.status === "success" && r.removed === 1500 && w.store.listingsOf(WS).length === 120 && w.store.log.filter((x) => x === "reconcile_listing_sync").length === 1, `${r.removed}`);
    const src = readFileSync(join(import.meta.dir, "..", "src", "lib", "sharetribe-sync.server.ts"), "utf8");
    t("the old capped stale lookup is gone (no id list, no .in() delete)", !/\.in\("sharetribe_listing_id"/.test(src) && !/select\("sharetribe_listing_id"\)/.test(src));
  }

  // ==========================================================================
  console.log("\n=== 10. Integration API mode: sparse public fields only; no affiliate sync ===");
  // ==========================================================================
  {
    const w = world({ mode: "integration" });
    w.store.secrets.set(WS, "s3cr3t-integration-secret");
    w.api.catalog = makeCatalog(30).map((l) => ({
      ...l,
      privateData: { gateCode: "PRIVATE-MARKER-1234" },
      protectedData: { phone: "PROTECTED-MARKER-5678" },
    }));
    const r = await w.run();
    t("integration run completes", r.status === "success" && r.upserted === 30, `${r.status} ${r.sentence}`);
    const tok = w.api.requests[0]!;
    t("token: Integration API, scope integ, the Vault secret", tok.url.href === "https://flex-integ-api.sharetribe.com/v1/auth/token" && /scope=integ/.test(tok.body) && /client_secret=s3cr3t-integration-secret/.test(tok.body));
    const q = w.api.listingRequests()[0]!.url.searchParams;
    t("listings: fields.listing = title,description,price,publicData,geolocation,state", q.get("fields.listing") === "title,description,price,publicData,geolocation,state" && INTEGRATION_LISTING_FIELDS.join(",") === q.get("fields.listing"), String(q.get("fields.listing")));
    t("listings: author profile displayName only; published only; perPage=100", q.get("fields.user") === "profile.displayName" && q.get("states") === "published" && q.get("perPage") === "100" && q.get("include") === "author,images");
    const stored = JSON.stringify(w.store.listingsOf(WS));
    t("no private or protected data is stored, even if an API sent it", !stored.includes("PRIVATE-MARKER") && !stored.includes("PROTECTED-MARKER") && !stored.includes("AUTHOR-PRIVATE") && !/@example\.com/.test(stored));
    t("the author's display name is kept", w.store.listingsOf(WS)[0]!.author_name?.startsWith("Host "));
    t("no request goes anywhere but Sharetribe's listing/token endpoints (no affiliate transactions sync)", w.api.requests.every((x) => /\/(auth\/token|listings\/query)$/.test(x.url.pathname)));
    const src = readFileSync(join(import.meta.dir, "..", "src", "lib", "sharetribe-sync.server.ts"), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
    t("the sync no longer chains the affiliate referral sync", !/affiliate/i.test(src) && !/runAffiliateReferralSync/.test(src));
  }
  {
    const w = world({ mode: "integration" });
    w.api.catalog = makeCatalog(3);
    const r = await w.run();
    t("integration mode with no stored secret → failed, secret sentence, connection needs attention", r.status === "failed" && /couldn't read the stored Integration API secret/.test(r.sentence) && w.row().status === "error" && w.api.requests.length === 0);
  }
  {
    const w = world();
    w.api.catalog = makeCatalog(3);
    const r = await w.run();
    const mq = w.api.listingRequests()[0]!.url.searchParams;
    t("marketplace mode (the default) asks the Marketplace API, no states filter, no listing fieldset", r.status === "success" && w.api.listingRequests()[0]!.url.origin === "https://flex-api.sharetribe.com" && !mq.has("states") && !mq.has("fields.listing") && mq.get("fields.user") === "profile.displayName");
  }

  // ==========================================================================
  console.log("\n=== 11. Honest statuses: auth, bad pages, saves, budgets ===");
  // ==========================================================================
  {
    const w = world();
    w.api.catalog = makeCatalog(3);
    w.api.tokenAnswer = () => new Response('{"error":"invalid_client"}', { status: 401 });
    w.store.seedListing(WS, uuid(51_000, 1), iso(w.clock.now() - DAY));
    const r = await w.run();
    t("a rejected Client ID → failed, the connection needs attention, nothing touched", r.status === "failed" && w.row().status === "error" && /didn't accept that Client ID/.test(r.sentence) && w.store.listingsOf(WS).length === 1 && w.api.listingRequests().length === 0);
    t("…the lease is released by finish", w.row().sync_lease_until === null && w.row().last_sync_status === "failed");
  }
  {
    const w = world();
    w.api.catalog = makeCatalog(3);
    w.row().status = "error";
    const r = await w.run();
    t("a later successful sync puts a needs-attention connection back to connected", r.status === "success" && w.row().status === "connected");
  }
  {
    const w = world();
    w.api.catalog = makeCatalog(3);
    w.api.answer = (page) => (page === 1 ? new Response("<html>oops</html>", { status: 200 }) : undefined);
    const r = await w.run();
    t("an unreadable page 1 → failed, nothing written", r.status === "failed" && r.upserted === 0 && !w.store.log.some((x) => x.startsWith("upsert:")));
  }
  {
    const w = world();
    w.api.catalog = makeCatalog(250);
    w.store.failOn = { upsert: 2 };
    const r = await w.run();
    t("a failed save on page 2 → partial (save_failed), page 1 kept, nothing removed", r.status === "partial" && r.reason === "save_failed" && r.upserted === 100 && !w.store.log.includes("reconcile_listing_sync"), `${r.status} ${r.reason}`);
    const w2 = world();
    w2.api.catalog = makeCatalog(50);
    w2.store.failOn = { upsert: 1 };
    const r2 = await w2.run();
    t("a failed save on page 1 → failed, 'couldn't save' sentence", r2.status === "failed" && /couldn't save the synced listings/.test(r2.sentence));
  }
  {
    const w = world();
    w.api.catalog = makeCatalog(2500);
    w.api.latencyMs = 10_000;
    const r = await w.run();
    t("out of time (90 s budget, 10 s per request) → partial (time_budget), nothing removed", r.status === "partial" && r.reason === "time_budget" && r.pagesRead < 25 && !w.store.log.includes("reconcile_listing_sync"), `${r.status} ${r.reason} ${r.pagesRead}`);
    t("…and the sentence says how far it got", new RegExp(`after ${(r.upserted).toLocaleString("en-US")} of 2,500 listings`).test(r.sentence), r.sentence);
  }
  {
    const w = world();
    w.api.catalog = makeCatalog(350);
    const r = await w.run({ maxPages: 2 });
    t("the page cap stops a run as partial (page_cap)", r.status === "partial" && r.reason === "page_cap" && w.api.listingRequests().length === 2);
    const w2 = world();
    w2.api.catalog = makeCatalog(350);
    w2.api.paginationLimit = 2;
    const r2 = await w2.run();
    t("Sharetribe's paginationLimit below totalPages → partial (pagination_limit)", r2.status === "partial" && r2.reason === "pagination_limit" && w2.api.listingRequests().length === 2);
  }
  {
    const w = world();
    w.store.removeIntegration(WS);
    const r = await w.run();
    t("no connection → not_connected, nothing claimed", r.status === "not_connected" && JSON.stringify(w.store.log) === JSON.stringify(["load"]));
  }

  // ==========================================================================
  console.log("\n=== 12. The bounded 'all' mode reports every run honestly ===");
  // ==========================================================================
  {
    const clock = new Clock();
    const store = new ListingStore(clock.now);
    const api = new FakeSharetribe(clock);
    api.catalog = makeCatalog(5);
    const A = uuid(1, 0xb0b), B = uuid(2, 0xb0b), C = uuid(3, 0xb0b), D = uuid(4, 0xb0b);
    store.addIntegration(A, { last_sync_at: iso(clock.now() - 2 * DAY) });
    store.addIntegration(B, { status: "pending", auth_mode: "integration" }); // no secret → fails
    store.addIntegration(C, { last_sync_at: iso(clock.now() - 60_000) });
    store.addIntegration(D, { status: "error" });
    const deps = { fetch: api.fetch, db: store.asSyncDb(), now: clock.now, sleep: clock.sleep, limits: { requestTimeoutMs: 40 } };
    const r = await runSharetribeSyncBounded(3, deps);
    t("connected + pending only, never-synced first", r.eligible === 3 && r.ran.map((x) => x.workspace_id).join() === [B, A, C].join(), JSON.stringify(r.ran));
    t("the failure is counted as a failure, the others as successes", r.failed === 1 && r.succeeded === 2 && r.ran[0]!.status === "failed" && !r.ran[0]!.ok);
    const broken: SyncDb = { ...store.asSyncDb(), listSyncCandidates: async () => { throw new Error("candidate_read_failed:boom"); } };
    const r2 = await runSharetribeSyncBounded(3, { ...deps, db: broken });
    t("an unreadable candidate list is reported as such, not as 'nothing to do'", r2.readFailed && r2.ran.length === 0);
  }

  // ==========================================================================
  console.log("\n=== 13. Reading real public-data variations (never guessed) ===");
  // ==========================================================================
  {
    t("flat fields", JSON.stringify(readListingPlace({ city: " Austin ", state: "TX", country: "US" })) === JSON.stringify({ city: "Austin", state: "TX", country: "US" }));
    t("publicData.location.{city,state,country}", readListingPlace({ location: { city: "Leeds", state: "England", country: "GB" } }).city === "Leeds");
    t("a structured address object", readListingPlace({ address: { locality: "Lyon", region: "Auvergne-Rhône-Alpes", countryCode: "FR" } }).country === "FR");
    t("Google-style address components", readListingPlace({ location: { address_components: [{ long_name: "Denver", types: ["locality"] }, { short_name: "CO", long_name: "Colorado", types: ["administrative_area_level_1"] }] } }).state === "CO");
    t("flat fields win over components", readListingPlace({ city: "Austin", addressComponents: [{ long_name: "Dallas", types: ["locality"] }] }).city === "Austin");
    t("a free-form address string is not parsed", JSON.stringify(readListingPlace({ location: { address: "500 Congress Ave, Austin, TX 78701" } })) === JSON.stringify({ city: null, state: null, country: null }));
    t("numbers, URLs, markup and empty strings are not places", readListingPlace({ city: 12345, state: "https://evil.example", country: "<b>US</b>" }).city === null && readListingPlace({ city: "   " }).city === null && readListingPlace({ state: "https://x.y" }).state === null && readListingPlace({ country: "<b>US</b>" }).country === null);
    t("category: publicData.category first", readListingCategory({ category: "Pool", categoryLevel1: "spas" }) === "Pool");
    t("category: else the top of the nested categories (categoryLevel1)", readListingCategory({ categoryLevel1: "hot-tubs", categoryLevel2: "cedar" }) === "hot-tubs");
    t("category: a one-value list is that value; several are not ours to pick", readListingCategory({ category: ["pool"] }) === "pool" && readListingCategory({ category: ["pool", "spa"] }) === null);
    t("category: an object with a string id", readListingCategory({ category: { id: "saunas", label: "Saunas" } }) === "saunas");
    t("category: nothing stated → null (never invented)", readListingCategory({}) === null && readListingCategory({ category: 7 }) === null && readListingCategory({ category: "!!" }) === null);
    t("unitType lower-cased; junk refused", readPriceUnit({ unitType: "Night" }) === "night" && readPriceUnit({ unitType: "per night!" }) === null && readPriceUnit({}) === null);
    const row = mapListing(WS, "https://m.example.com", { id: { uuid: uuid(1) }, attributes: { title: "  Quiet   Pool ", price: { amount: 12.5, currency: "US" }, geolocation: { lat: 999, lng: 10 }, publicData: {} } }, [], { mode: "marketplace", syncedAt: "2026-09-28T12:00:00.000Z" });
    t("a fractional amount or bad currency is not a price; impossible coordinates are dropped", row.price_amount === null && row.price_currency === null && row.lat === null && row.lng === 10 && row.title === "Quiet Pool" && row.synced_at === "2026-09-28T12:00:00.000Z");
    t("unmapped place and category stay null (with null keys)", row.city === null && row.category === null && row.city_key === null && row.category_key === null);
    const huge = mapListing(WS, "https://m.example.com", { id: { uuid: uuid(2) }, attributes: { title: "Villa", price: { amount: 3_000_000_000, currency: "USD" }, publicData: {} } }, [], { mode: "marketplace", syncedAt: "2026-09-28T12:00:00.000Z" });
    const max = mapListing(WS, "https://m.example.com", { id: { uuid: uuid(3) }, attributes: { title: "Villa", price: { amount: 2_147_483_647, currency: "USD" }, publicData: {} } }, [], { mode: "marketplace", syncedAt: "2026-09-28T12:00:00.000Z" });
    t("a price past the column's int4 range is stored unpriced (never a failed page upsert); the maximum itself fits", huge.price_amount === null && max.price_amount === 2_147_483_647);
  }

  // ==========================================================================
  console.log("\n=== 14. Every sentence the run can record is a customer sentence (≤ 200 chars) ===");
  // ==========================================================================
  {
    const { partialSentence, successSentence, emptyConfirmedSentence } = await import("../src/lib/sharetribe-sync.server");
    const reasons = ["missing_pagination", "count_changed", "count_mismatch", "pagination_limit", "page_cap", "time_budget", "upstream_error", "save_failed", "reconcile_failed", "malformed_response", "lease_lost"] as const;
    const all = [
      ...reasons.flatMap((r) => [partialSentence(r, 1, 2500), partialSentence(r, 12_345, null)]),
      successSentence(1, 0), successSentence(2500, 1), successSentence(2500, 20),
      emptyConfirmedSentence(1), emptyConfirmedSentence(50),
      ...Object.values(SYNC_SENTENCES),
    ];
    const bad = all.filter((s) => !isCustomerSentence(s) || s.length > 200);
    t(`all ${all.length} sentences pass isCustomerSentence and fit the stored-error display`, bad.length === 0, bad.join(" | "));
    t("singular wording for one listing", successSentence(1, 1) === "Synced 1 listing and removed 1 that is no longer published.");
  }
} finally {
  console.error = origError;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
