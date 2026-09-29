/**
 * SCALE: NOTHING IS SILENTLY CUT AT 1,000. Run: bun tests/mvp-scale.test.ts
 *
 * PostgREST answers at most max-rows (1,000 on Supabase) per request —
 * table reads AND set-returning RPCs. The in-memory PostgREST here enforces
 * the same cap (FakeDb.maxRows), and the fixtures go well past it: 2,600
 * published listings in 1,300 groups, 1,500 pages. Driven through the real
 * supabase-js client and the real modules:
 *   - coverage: every group and every target, exact listing totals, every
 *     page state, and paging that covers the open list exactly once;
 *   - My Pages lists all 1,500 pages; the duplicate check reads all 1,470
 *     published siblings;
 *   - grounding counts 1,950 matching listings exactly and summarises the
 *     prices of all of them (not the first 1,000).
 * The sync's own scale (2,500 listings over 25 pages, >1,000 reconciled) is
 * tests/sharetribe-sync-run.test.ts; the sitemap's (sharding past 50,000
 * URLs and 50 MB) is tests/sitemap-chunking.test.ts.
 */
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";

import { FakeDb } from "./_support/fake-postgrest";
import {
  listingKeys,
  makeFilter,
  scopeFor,
  targetKey,
  resolveFilter,
} from "../src/lib/coverage/target";
import { contractJson } from "../src/lib/templates/contracts";

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

const db = new FakeDb();
db.maxRows = 1000;
db.install("supabase.test");

const WS = "11111111-1111-4111-8111-111111111111";
const CITIES = 650;

db.embeds = { tenant_pages: { page_templates: { table: "page_templates", fk: "template_id" } } };
for (const kind of ["city_hub", "category_page", "resource_article"] as const) {
  db.insertRow("page_templates", {
    id: `tpl-${kind}`,
    slug: kind,
    name: kind,
    is_active: true,
    config_schema: contractJson(kind),
  });
}
let n = 0;
for (let c = 0; c < CITIES; c++) {
  for (const [category, count, price] of [
    ["Pool", 3, 2500 + c],
    ["Hot tub", 1, 9000],
  ] as const) {
    for (let i = 0; i < count; i++) {
      const k = listingKeys({ country: "US", state: "TX", city: `City ${c}`, category });
      db.insertRow("tenant_listings", {
        id: `l-${String(++n).padStart(6, "0")}`,
        workspace_id: WS,
        state_published: true,
        title: `Listing ${n}`,
        city: `City ${c}`,
        state: "TX",
        country: "US",
        category,
        price_amount: price,
        price_currency: "USD",
        price_unit: "hour",
        synced_at: "2026-09-28T10:00:00Z",
        country_key: k.countryKey,
        region_key: k.regionKey,
        city_key: k.cityKey,
        category_key: k.categoryKey,
      });
    }
  }
}
const hubKey = (c: number) => {
  const k = listingKeys({ country: "US", state: "TX", city: `City ${c}` });
  return targetKey(
    "city_hub",
    resolveFilter(
      makeFilter(scopeFor("city_hub", false), k, {
        country: "US",
        region: "TX",
        city: `City ${c}`,
      }),
    )!,
  )!;
};
const hubFilter = (c: number) =>
  makeFilter(
    scopeFor("city_hub", false),
    listingKeys({ country: "US", state: "TX", city: `City ${c}` }),
    { country: "US", region: "TX", city: `City ${c}` },
  );
let p = 0;
const addPage = (over: Record<string, unknown>) =>
  db.insertRow("tenant_pages", {
    id: `p-${String(++p).padStart(6, "0")}`,
    workspace_id: WS,
    slug: `page-${p}`,
    title: `Page ${p}`,
    h1: `Page ${p}`,
    meta_description: `A distinct description for page number ${p} of this marketplace's pages.`,
    variables: {},
    noindex: false,
    generation: null,
    updated_at: `2026-09-28T10:${String(p % 60).padStart(2, "0")}:00Z`,
    published_at: null,
    ...over,
  });
for (let c = 0; c < 600; c++)
  addPage({
    template_id: "tpl-city_hub",
    status: "published",
    listing_filter: hubFilter(c),
    target_key: hubKey(c),
  });
for (let c = 600; c < 625; c++)
  addPage({
    template_id: "tpl-city_hub",
    status: "draft",
    listing_filter: hubFilter(c),
    target_key: hubKey(c),
  });
for (let c = 625; c < 630; c++)
  addPage({
    template_id: "tpl-city_hub",
    status: "archived",
    listing_filter: hubFilter(c),
    target_key: hubKey(c),
  });
for (let i = 0; i < 870; i++)
  addPage({
    template_id: "tpl-resource_article",
    status: "published",
    listing_filter: makeFilter([], listingKeys({})),
    target_key: null,
  });
db.insertRow("tenant_integrations", {
  workspace_id: WS,
  provider: "sharetribe",
  status: "connected",
  last_success_at: new Date(Date.now() - 3600_000).toISOString(),
  last_sync_at: new Date(Date.now() - 3600_000).toISOString(),
  last_sync_status: "success",
  listings_count: 2600,
  upstream_total: 2600,
});
db.insertRow("workspaces", { id: WS, name: "Big Marketplace", brand_name: null });
db.rpcs = {
  inventory_coverage_groups: (a) => {
    const groups = new Map<string, any>();
    for (const l of db
      .table("tenant_listings")
      .filter((r) => r.workspace_id === a._workspace_id && r.state_published)) {
      const key = [l.country_key, l.region_key, l.city_key, l.category_key].join("|");
      const g = groups.get(key) ?? {
        country_key: l.country_key,
        region_key: l.region_key,
        city_key: l.city_key,
        category_key: l.category_key,
        country: l.country,
        region: l.state,
        city: l.city,
        category: l.category,
        listing_count: 0,
        priced_count: 0,
        currencies: ["USD"],
        price_units: ["hour"],
        unkeyed_count: 0,
      };
      g.listing_count++;
      g.priced_count++;
      groups.set(key, g);
    }
    return [...groups.values()];
  },
};

const { loadCoverage } = await import("../src/lib/coverage/coverage.server");
const { inView } = await import("../src/lib/coverage/coverage.functions");
const { listPages } = await import("../src/lib/page-publish.server");
const { loadSiblingContext } = await import("../src/lib/seo/page-contract.server");
const { countMatchingListings, priceSummary } =
  await import("../src/lib/coverage/inventory.server");
const { supabaseAdmin } = await import("../src/integrations/supabase/client.server");

const origError = console.error;
console.error = () => {};
try {
  console.log("\n0. The fake really caps at 1,000 (so the rest proves something)");
  {
    const raw = await (supabaseAdmin as any).rpc("inventory_coverage_groups", {
      _workspace_id: WS,
    });
    t(
      "an unpaged RPC read returns only 1,000 of 1,300 groups",
      Array.isArray(raw.data) && raw.data.length === 1000,
      String(raw.data?.length),
    );
    const rawPages = await (supabaseAdmin as any)
      .from("tenant_pages")
      .select("id")
      .eq("workspace_id", WS);
    t(
      "an unpaged table read returns only 1,000 of 1,500 pages",
      rawPages.data?.length === 1000,
      String(rawPages.data?.length),
    );
  }

  console.log("\n1. Coverage past the cap");
  const report = await loadCoverage(WS);
  const hubs = report.items.filter((i) => i.kind === "city_hub");
  t("every city is a target (650)", hubs.length === CITIES, String(hubs.length));
  t(
    "both categories are targets",
    report.items.filter((i) => i.kind === "category_page").length === 2,
  );
  t(
    "the listing total is exact (2,600, not 1,000-capped)",
    report.totals.listings === 2600,
    String(report.totals.listings),
  );
  t(
    "published / draft / archived / missing are each exact (600 / 25 / 5 / 22)",
    report.totals.published === 600 &&
      report.totals.draft === 25 &&
      report.totals.archived === 5 &&
      report.totals.missing === 22,
    JSON.stringify(report.totals),
  );
  t(
    "the last city's page state is right (proves the page read went past 1,000)",
    hubs.find((h) => h.labels.city === "City 599")?.state === "published" &&
      hubs.find((h) => h.labels.city === "City 649")?.state === "missing",
  );
  const open = report.items.filter((i) => inView(i, "open"));
  const pages = [0, 1].map((k) => open.slice(k * 50, (k + 1) * 50));
  t(
    "paging the open list covers every open target exactly once",
    pages.flat().length === open.length &&
      new Set(pages.flat().map((i) => i.targetKey)).size === open.length &&
      open.length === 52,
    String(open.length),
  );

  console.log("\n2. My Pages and the duplicate check past the cap");
  const mine = await listPages(WS);
  t("My Pages lists all 1,500 pages", mine.length === 1500, String(mine.length));
  const siblings = await loadSiblingContext(WS);
  t(
    "the duplicate check compares against all 1,470 published pages",
    siblings.publishedCount === 1470,
    String(siblings.publishedCount),
  );

  console.log("\n3. Grounding past the cap");
  const pool = resolveFilter(
    makeFilter(["category"], listingKeys({ category: "Pool" }), { category: "Pool" }),
  )!;
  t("the Pool count is exact (1,950)", (await countMatchingListings(WS, pool)) === 1950);
  const prices = await priceSummary(WS, pool);
  const usdHour = prices.groups.find((g) => g.currency === "USD" && g.unit === "hour");
  t(
    "prices are summarised over all 1,950 listings (complete, max from the last city)",
    prices.complete && usdHour?.count === 1950 && usdHour.maxMinor === 2500 + CITIES - 1,
    JSON.stringify(usdHour),
  );
} finally {
  console.error = origError;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
