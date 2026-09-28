/**
 * INVENTORY-BACKED COVERAGE. Run: bun tests/coverage-report.test.ts
 *
 * The defects the MVP brief names in the old page-builder context, as
 * behavior: (A) a capped listing set, (B) cities cut to 40 before gaps were
 * chosen, (C) gaps cut to 12 and reported as the total, (D) drafts and
 * archived pages counted as coverage, (E) no country — plus dismissals,
 * insufficient inventory, legacy pages, sync freshness and unmapped listings.
 * buildCoverageReport is the pure core of loadCoverage (one aggregate RPC,
 * a complete page read, dismissals, the sync row).
 */
import { buildCoverageReport, STALE_AFTER_MS } from "../src/lib/coverage/coverage.server";
import { inView } from "../src/lib/coverage/coverage.functions";
import {
  listingKeys,
  makeFilter,
  resolveFilter,
  scopeFor,
  targetKey,
} from "../src/lib/coverage/target";

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

const NOW = Date.parse("2026-09-29T12:00:00Z");
const fresh = {
  status: "connected",
  last_success_at: new Date(NOW - 3600_000).toISOString(),
  last_sync_at: new Date(NOW - 3600_000).toISOString(),
  last_sync_status: "success",
  listings_count: 0,
  upstream_total: 0,
};

function group(o: {
  country?: string | null;
  state?: string | null;
  city?: string | null;
  category?: string | null;
  n: number;
  priced?: number;
  currencies?: string[];
  unkeyed?: number;
}) {
  const k = listingKeys({ country: o.country, state: o.state, city: o.city, category: o.category });
  return {
    country_key: k.countryKey,
    region_key: k.regionKey,
    city_key: k.cityKey,
    category_key: k.categoryKey,
    country: o.country ?? null,
    region: o.state ?? null,
    city: o.city ?? null,
    category: o.category ?? null,
    listing_count: o.n,
    priced_count: o.priced ?? 0,
    currencies: o.currencies ?? [],
    price_units: [],
    unkeyed_count: o.unkeyed ?? 0,
  };
}
function page(
  id: string,
  status: string,
  filter: unknown,
  kind = "city_hub",
  tk: string | null = null,
) {
  return {
    id,
    slug: id,
    title: id,
    status,
    listing_filter: filter,
    target_key: tk,
    updated_at: null,
    page_templates: { slug: kind },
  };
}
const hubKey = (country: string, state: string | null, city: string) => {
  const k = listingKeys({ country, state, city });
  return targetKey("city_hub", resolveFilter(makeFilter(scopeFor("city_hub", false), k))!)!;
};

console.log("\n1. No truncation (A, B, C)");
{
  // 60 cities × 2 categories, 2,520 listings in all — beyond every old cap.
  const groups = [];
  for (let i = 0; i < 60; i++) {
    groups.push(
      group({ country: "US", state: "TX", city: `City ${i}`, category: "Pool", n: 20 + i }),
    );
    groups.push(
      group({ country: "US", state: "TX", city: `City ${i}`, category: "Hot tub", n: 1 }),
    );
  }
  const r = buildCoverageReport({
    groups,
    pages: [],
    dismissedKeys: new Set(),
    integration: fresh,
    now: NOW,
  });
  const hubs = r.items.filter((i) => i.kind === "city_hub");
  t("every city is a target (60, not 40)", hubs.length === 60, String(hubs.length));
  t(
    "every gap is counted (60 missing hubs + 2 category pages = 62, not 12)",
    r.totals.missing === 62,
    String(r.totals.missing),
  );
  t(
    "the listing total is exact (2,550)",
    r.totals.listings === 60 * 20 + (59 * 60) / 2 + 60,
    String(r.totals.listings),
  );
  t(
    "a city's count sums its categories",
    hubs.find((h) => h.labels.city === "City 59")?.listingCount === 20 + 59 + 1,
  );
  t(
    "category pages are targets too",
    r.items
      .filter((i) => i.kind === "category_page")
      .map((i) => i.labels.category)
      .sort()
      .join(",") === "Hot tub,Pool",
  );
  t(
    "items are ordered by opportunity then size",
    r.items[0]!.state === "missing" && r.items[0]!.listingCount >= r.items[1]!.listingCount,
  );
}

console.log("\n2. Coverage states are distinct (D)");
{
  const groups = [
    group({ country: "US", state: "OR", city: "Portland", n: 10 }),
    group({ country: "US", state: "ME", city: "Portland", n: 8 }),
    group({ country: "US", state: "TX", city: "Austin", n: 6 }),
    group({ country: "US", state: "TX", city: "Dallas", n: 5 }),
    group({ country: "US", state: "TX", city: "Houston", n: 7 }),
    group({ country: "US", state: "TX", city: "Waco", n: 2 }),
  ];
  const f = (state: string, city: string) =>
    makeFilter(scopeFor("city_hub", false), listingKeys({ country: "US", state, city }));
  const pages = [
    page(
      "p-published",
      "published",
      f("OR", "Portland"),
      "city_hub",
      hubKey("US", "OR", "Portland"),
    ),
    page("p-draft", "draft", f("TX", "Austin"), "city_hub", hubKey("US", "TX", "Austin")),
    page("p-archived", "archived", f("TX", "Dallas"), "city_hub", hubKey("US", "TX", "Dallas")),
    page(
      "p-suspended",
      "billing_suspended",
      f("TX", "Houston"),
      "city_hub",
      hubKey("US", "TX", "Houston"),
    ),
  ];
  const r = buildCoverageReport({
    groups,
    pages,
    dismissedKeys: new Set(),
    integration: fresh,
    now: NOW,
  });
  const by = (city: string, st: string) =>
    r.items.find((i) => i.labels.city === city && i.labels.region === st)!;
  t(
    "a published page is published coverage",
    by("Portland", "OR").state === "published" && by("Portland", "OR").page?.id === "p-published",
  );
  t("Portland, ME is still missing (a different region)", by("Portland", "ME").state === "missing");
  t(
    "a draft is 'in progress' and offered for resuming, not duplicating",
    by("Austin", "TX").state === "draft" && by("Austin", "TX").page?.id === "p-draft",
  );
  t("an archived page is NOT live coverage", by("Dallas", "TX").state === "archived");
  t("a suspended page is its own state", by("Houston", "TX").state === "suspended");
  t(
    "under 3 listings is insufficient inventory, not an opportunity",
    by("Waco", "TX").state === "insufficient",
  );
  t(
    "totals count each state once",
    r.totals.published === 1 &&
      r.totals.draft === 1 &&
      r.totals.archived === 1 &&
      r.totals.suspended === 1 &&
      r.totals.insufficient === 1 &&
      r.totals.missing === 1,
    JSON.stringify(r.totals),
  );
}

console.log("\n3. Country and legacy pages (E)");
{
  const groups = [
    group({ country: "GB", state: null, city: "London", n: 9 }),
    group({ country: "CA", state: "ON", city: "London", n: 4 }),
  ];
  const r = buildCoverageReport({
    groups,
    pages: [],
    dismissedKeys: new Set(),
    integration: fresh,
    now: NOW,
  });
  t(
    "London, GB and London, ON, CA are two targets",
    r.items.filter((i) => i.labels.city === "London").length === 2,
  );
  // A legacy page (v1 filter, no state, no target_key) covering "London".
  const legacy = page("legacy", "published", { city: "London", limit: 24, sort: "newest" });
  const r2 = buildCoverageReport({
    groups,
    pages: [legacy],
    dismissedKeys: new Set(),
    integration: fresh,
    now: NOW,
  });
  t(
    "a legacy page with no region still covers its city everywhere (never duplicated)",
    r2.items.filter((i) => i.state === "published").length === 2,
  );
  const legacyCat = page("legacy-cat", "published", { city: "London", category: "Pool" });
  const r3 = buildCoverageReport({
    groups,
    pages: [legacyCat],
    dismissedKeys: new Set(),
    integration: fresh,
    now: NOW,
  });
  t(
    "a narrower legacy page (city + category) does not cover the whole city",
    r3.totals.missing === 2,
  );
}

console.log("\n4. Dismissals, unmapped listings, sync evidence");
{
  const groups = [
    group({ country: "US", state: "TX", city: "Austin", category: "Pool", n: 5 }),
    group({ country: "US", state: "TX", city: null, category: "Pool", n: 3 }),
    group({ country: "US", state: "TX", city: "Austin", category: null, n: 2 }),
    group({ country: null, state: null, city: null, category: null, n: 4, unkeyed: 4 }),
  ];
  const austin = hubKey("US", "TX", "Austin");
  const r = buildCoverageReport({
    groups,
    pages: [],
    dismissedKeys: new Set([austin]),
    integration: fresh,
    now: NOW,
  });
  const item = r.items.find((i) => i.targetKey === austin)!;
  t(
    "a dismissed target is flagged and left out of the open counts",
    item.dismissed &&
      r.totals.dismissed === 1 &&
      !inView(item, "open") &&
      inView(item, "dismissed"),
  );
  t("listings without a city are reported, not guessed", r.totals.withoutCity === 7);
  t("listings without a category are reported", r.totals.withoutCategory === 6);
  t("rows synced before keys existed are flagged for a resync", r.totals.needsResync === 4);

  const never = buildCoverageReport({
    groups,
    pages: [],
    dismissedKeys: new Set(),
    integration: null,
    now: NOW,
  });
  t(
    "no connection → never_synced with a next step",
    never.evidence.state === "never_synced" && /Connect Sharetribe/.test(never.evidence.message),
  );
  const incomplete = buildCoverageReport({
    groups,
    pages: [],
    dismissedKeys: new Set(),
    now: NOW,
    integration: {
      ...fresh,
      last_sync_at: new Date(NOW - 60_000).toISOString(),
      last_sync_status: "partial",
    },
  });
  t(
    "a later incomplete sync → incomplete evidence, and every item carries the warning",
    incomplete.evidence.state === "incomplete" &&
      incomplete.items.every((i) => i.warnings.length === 1),
  );
  const stale = buildCoverageReport({
    groups,
    pages: [],
    dismissedKeys: new Set(),
    now: NOW,
    integration: {
      ...fresh,
      last_success_at: new Date(NOW - STALE_AFTER_MS - 1).toISOString(),
      last_sync_at: new Date(NOW - STALE_AFTER_MS - 1).toISOString(),
    },
  });
  t("no success for over a day → stale", stale.evidence.state === "stale");
  t(
    "fresh sync → complete, no warnings",
    r.evidence.state === "complete" && item.warnings.length === 0,
  );
}

console.log("\n5. Views never change the totals");
{
  const groups = Array.from({ length: 130 }, (_, i) =>
    group({ country: "US", state: "TX", city: `C${i}`, n: 3 + (i % 5) }),
  );
  const r = buildCoverageReport({
    groups,
    pages: [],
    dismissedKeys: new Set(),
    integration: fresh,
    now: NOW,
  });
  const open = r.items.filter((i) => inView(i, "open"));
  const pageSize = 50;
  const pages = [0, 1, 2].map((p) => open.slice(p * pageSize, (p + 1) * pageSize));
  t(
    "paging covers every open item exactly once",
    pages.flat().length === open.length &&
      new Set(pages.flat().map((i) => i.targetKey)).size === open.length,
  );
  t("the totals are the whole report's", r.totals.missing === 130);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
