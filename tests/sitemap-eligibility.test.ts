/**
 * TENANT SITEMAP ELIGIBILITY. Run: bun tests/sitemap-eligibility.test.ts
 *
 * The real generator (src/lib/sitemap.server.ts) through the real supabase-js
 * client against a fake PostgREST (tests/_support/fake-postgrest.ts): which
 * pages are listed, every reason a page is left out, the one inventory
 * aggregation, row-derived <lastmod>, tenant isolation, the billing pause and
 * the fail-safe on any failed or partial read. Offline.
 */
import { FakePostgrest, coverageGroupsOf, harness, type Row } from "./_support/fake-postgrest-sitemap";

const ORIGIN = "http://sitemap-eligibility.test";
process.env.SUPABASE_URL = ORIGIN;
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
const fake = new FakePostgrest(ORIGIN);
fake.install();

const sm = await import("../src/lib/sitemap.server");
const { makeFilter } = await import("../src/lib/coverage/target");
const { t, done } = harness();

// ---------------------------------------------------------------------------
// Fixtures
const WS_A = "aaaaaaaa-0000-4000-8000-000000000001";
const WS_B = "bbbbbbbb-0000-4000-8000-000000000002";
const HOST_A = "pools.example";
const HOST_B = "www.pools.example"; // a different host, verified by another workspace
const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T_CITY = uuid("7e000000", 1);
const T_CAT = uuid("7e000000", 2);
const T_RES = uuid("7e000000", 3);
const T_OFF = uuid("7e000000", 4);
const T_MYSTERY = uuid("7e000000", 5);
const LONG = "x".repeat(700);
const MEDIUM = "y".repeat(400);

const place = (city: string, region: string, country = "us") =>
  makeFilter(["country", "region", "city"], { countryKey: country, regionKey: region, cityKey: city, categoryKey: null });
const category = (key: string) =>
  makeFilter(["category"], { countryKey: null, regionKey: null, cityKey: null, categoryKey: key });

let seq = 0;
function page(ws: string, slug: string, template: string, extra: Row = {}): Row {
  seq++;
  const at = new Date(Date.UTC(2026, 0, 1) + seq * 86_400_000).toISOString();
  return {
    id: uuid("a0000000", seq),
    workspace_id: ws,
    template_id: template,
    slug,
    title: slug,
    status: "published",
    noindex: false,
    listing_filter: place("austin", "tx"),
    body_markdown: "",
    published_at: at,
    created_at: at,
    updated_at: at,
    ...extra,
  };
}
let lseq = 0;
function legacy(ws: string, slug: string | null, extra: Row = {}): Row {
  lseq++;
  const at = new Date(Date.UTC(2025, 0, 1) + lseq * 86_400_000).toISOString();
  return {
    id: uuid("c0000000", lseq),
    workspace_id: ws,
    slug,
    url_path: slug ? `/p/${slug}` : null,
    status: "published",
    in_sitemap: true,
    redirect_to: null,
    body_markdown: MEDIUM,
    title: slug,
    created_at: at,
    updated_at: at,
    ...extra,
  };
}
let nseq = 0;
function listing(ws: string, k: { country?: string | null; region?: string | null; city?: string | null; category?: string | null }, extra: Row = {}): Row {
  nseq++;
  return {
    id: uuid("d0000000", nseq),
    workspace_id: ws,
    state_published: true,
    country: k.country ?? null,
    state: k.region ?? null,
    city: k.city ?? null,
    category: k.category ?? null,
    country_key: k.country ?? null,
    region_key: k.region ?? null,
    city_key: k.city ?? null,
    category_key: k.category ?? null,
    ...extra,
  };
}

const P1_UPDATED = "2026-09-20T10:00:00.123456+00:00";

function seed() {
  seq = 0;
  lseq = 0;
  nseq = 0;
  fake.set("workspace_domains", [
    { id: uuid("e0000000", 1), workspace_id: WS_A, hostname: HOST_A, verified: true, verified_at: "2026-09-01T00:00:00Z", status: "active" },
    { id: uuid("e0000000", 2), workspace_id: WS_B, hostname: HOST_B, verified: true, verified_at: "2026-09-02T00:00:00Z", status: "active" },
  ]);
  fake.set("workspaces", [
    { id: WS_A, marketplace_domain: HOST_A, domain_verified_at: "2026-09-01T00:00:00Z", subscription_status: "active", trial_ends_at: null, current_period_end: "2099-01-01T00:00:00Z" },
    { id: WS_B, marketplace_domain: HOST_B, domain_verified_at: "2026-09-02T00:00:00Z", subscription_status: "active", trial_ends_at: null, current_period_end: "2099-01-01T00:00:00Z" },
  ]);
  fake.set("page_templates", [
    { id: T_CITY, slug: "city_hub", is_active: true },
    { id: T_CAT, slug: "category_page", is_active: true },
    { id: T_RES, slug: "resource_article", is_active: true },
    { id: T_OFF, slug: "landing_v2", is_active: false },
    { id: T_MYSTERY, slug: "mystery_page", is_active: true },
  ]);
  fake.set("tenant_listings", [
    listing(WS_A, { country: "us", region: "tx", city: "austin", category: "pool" }),
    listing(WS_A, { country: "us", region: "tx", city: "austin", category: "pool" }),
    listing(WS_A, { country: "us", region: "tx", city: "austin", category: "cabin" }),
    listing(WS_A, { country: "us", region: "or", city: "portland", category: "pool" }),
    // Synced before the keys existed: city text, no city key.
    listing(WS_A, { country: "us", region: "tx", city: null, category: "pool" }, { city: "Houston" }),
    // Not published: never counts.
    listing(WS_A, { country: "us", region: "tx", city: "dallas", category: "pool" }, { state_published: false }),
    // Another workspace's Dallas inventory must not rescue A's Dallas page.
    listing(WS_B, { country: "us", region: "tx", city: "dallas", category: "pool" }),
  ]);
  fake.set("tenant_pages", [
    page(WS_A, "austin-pools", T_CITY, { published_at: "2026-09-01T00:00:00+00:00", updated_at: P1_UPDATED }),
    page(WS_A, "dallas-pools", T_CITY, { listing_filter: place("dallas", "tx"), body_markdown: "d".repeat(2000) }),
    page(WS_A, "pool-rentals", T_CAT, { listing_filter: category("pool") }),
    page(WS_A, "hot-tubs", T_CAT, { listing_filter: category("hot-tub"), body_markdown: LONG }),
    page(WS_A, "pool-safety-guide", T_RES, { listing_filter: makeFilter([], { countryKey: null, regionKey: null, cityKey: null, categoryKey: null }), body_markdown: LONG }),
    page(WS_A, "short-guide", T_RES, { body_markdown: "too short to stand alone" }),
    page(WS_A, "austin-legacy-filter", T_CITY, { listing_filter: { city: "Austin", state: "TX", limit: 12 } }),
    page(WS_A, "hidden-austin", T_CITY, { noindex: true }),
    page(WS_A, "old-template", T_OFF),
    page(WS_A, "mystery-page", T_MYSTERY),
    page(WS_A, "moved-page", T_CITY),
    page(WS_A, "moved-by-path", T_CITY),
    page(WS_A, "moved-by-p-path", T_CITY),
    page(WS_A, "founders-domain-test", T_CITY),
    page(WS_A, "Bad_Slug", T_CITY),
    page(WS_A, "broken-filter", T_CITY, { listing_filter: { v: 2, scope: ["nope"] } }),
    page(WS_A, "not-redirected", T_CITY),
    page(WS_A, "houston-pools", T_CITY, { listing_filter: place("houston", "tx") }),
    page(WS_A, "portland-pools", T_CITY, { listing_filter: place("portland", "or") }),
    page(WS_A, "portland-me", T_CITY, { listing_filter: place("portland", "me") }),
    page(WS_A, "draft-austin", T_CITY, { status: "draft", published_at: null }),
    page(WS_A, "draft-two", T_CITY, { status: "draft", published_at: null }),
    page(WS_A, "archived-austin", T_CITY, { status: "archived" }),
    page(WS_A, "suspended-austin", T_CITY, { status: "billing_suspended" }),
    page(WS_B, "b-only-page", T_CITY, { listing_filter: place("dallas", "tx") }),
  ]);
  fake.set("content_pages", [
    legacy(WS_A, "legacy-guide"),
    legacy(WS_A, "legacy-short", { body_markdown: "short" }),
    legacy(WS_A, "austin-pools"),
    legacy(WS_A, "hidden-austin"),
    legacy(WS_A, "twin"),
    legacy(WS_A, "twin", { in_sitemap: false }),
    legacy(WS_A, "not-listed", { in_sitemap: false }),
    legacy(WS_A, "legacy-draft", { status: "draft" }),
    legacy(WS_A, "legacy-moved"),
    legacy(WS_A, "/leading-slash"),
    legacy(WS_A, "draft-austin"), // the tenant page with this slug is a draft: the legacy page serves
    legacy(WS_A, "moved-page", { status: "redirect", url_path: null, redirect_to: "/a/austin-pools", in_sitemap: false }),
    legacy(WS_A, null, { status: "redirect", url_path: "/a/moved-by-path", redirect_to: "https://elsewhere.example/x", in_sitemap: false }),
    legacy(WS_A, null, { status: "redirect", url_path: "/p/moved-by-p-path", redirect_to: "/a/pool-rentals", in_sitemap: false }),
    legacy(WS_A, "not-redirected", { status: "redirect", url_path: null, redirect_to: "", in_sitemap: false }),
    legacy(WS_A, "legacy-moved", { status: "redirect", url_path: null, redirect_to: "/a/legacy-guide", in_sitemap: false }),
    legacy(WS_B, "b-legacy"),
  ]);
  fake.rpcs = {
    workspace_granted_pages: () => 0,
    inventory_coverage_groups: (args) => coverageGroupsOf(fake.rows("tenant_listings"), String(args._workspace_id)),
  };
  fake.failWhen = null;
}

const locsOf = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
const lastmodFor = (xml: string, loc: string) =>
  new RegExp(`<loc>${loc.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}</loc><lastmod>([^<]+)</lastmod>`).exec(xml)?.[1] ?? null;
const get = (host: string, query = "") => sm.tenantSitemapResponse(host, `https://${host}/a/sitemap.xml${query}`);
const A = (slug: string) => `https://${HOST_A}/a/${slug}`;

// ---------------------------------------------------------------------------
console.log("\nwhat is listed, on the exact verified host");
seed();
fake.clearHits();
const r = await get(HOST_A);
const aggregationCallsForOneBuild = fake.count("inventory_coverage_groups");
const listingReadsForOneBuild = fake.count("tenant_listings");
const listed = locsOf(r.body);
const EXPECTED = [
  "austin-pools",
  "pool-rentals",
  "pool-safety-guide",
  "austin-legacy-filter",
  "not-redirected",
  "portland-pools",
  "legacy-guide",
  "draft-austin",
].map(A);
t("200 with a <urlset>", r.status === 200 && r.body.includes("<urlset"), `${r.status} ${r.body.slice(0, 80)}`);
t(
  "exactly the eligible pages are listed",
  JSON.stringify([...listed].sort()) === JSON.stringify([...EXPECTED].sort()),
  JSON.stringify(listed),
);
t("every URL is https://{verified host}/a/{slug}", listed.every((l) => l.startsWith(`https://${HOST_A}/a/`)));
t("no preview or platform URL", !listed.some((l) => /\/s\/|founders\.click/.test(l)));
t("a city hub whose listings exist is listed", listed.includes(A("austin-pools")));
t("a category page whose listings exist is listed", listed.includes(A("pool-rentals")));
t("a resource article needs no listings, only its text", listed.includes(A("pool-safety-guide")));
t("a legacy (v1) listing filter still finds its listings", listed.includes(A("austin-legacy-filter")));
t("Portland, OR is not Portland, ME", listed.includes(A("portland-pools")) && !listed.includes(A("portland-me")));
t("a redirect row with no redirect_to redirects nothing", listed.includes(A("not-redirected")));
t("a compatible legacy content page stays", listed.includes(A("legacy-guide")));
t("a legacy page whose tenant twin is only a draft serves, so it is listed", listed.includes(A("draft-austin")));

console.log("\nevery reason a page is left out");
const c = await sm.collectSitemap(WS_A, { statusCounts: true });
const ex = c.excluded;
t("the collection is complete", c.complete && c.problems.length === 0, JSON.stringify(c.problems));
t("drafts are counted, not listed (2)", ex.draft === 2 && !listed.some((l) => /draft-two/.test(l)), String(ex.draft));
t("archived pages are counted, not listed (1)", ex.archived === 1 && !listed.includes(A("archived-austin")));
t("billing-suspended pages are counted, not listed (1)", ex.suspended === 1 && !listed.includes(A("suspended-austin")));
t("noindex pages are left out (1)", ex.noindex === 1 && !listed.includes(A("hidden-austin")), String(ex.noindex));
t(
  "thin / no matching listings (7): Dallas (another tenant's listings don't count), hot tubs, short guide, broken filter, Houston (unkeyed), Portland ME, short legacy",
  ex.thin === 7 &&
    ["dallas-pools", "hot-tubs", "short-guide", "broken-filter", "houston-pools", "portland-me", "legacy-short"].every(
      (s) => !listed.includes(A(s)),
    ),
  String(ex.thin),
);
t("a listing template with 2,000 characters but no listings is still left out", !listed.includes(A("dallas-pools")));
t(
  "template not available (2): an inactive template and one with no renderer",
  ex.template_unavailable === 2 && !listed.includes(A("old-template")) && !listed.includes(A("mystery-page")),
  String(ex.template_unavailable),
);
t(
  "redirected (4): by slug, by /a/ path, by /p/ path, and a legacy page",
  ex.redirected === 4 &&
    ["moved-page", "moved-by-path", "moved-by-p-path", "legacy-moved"].every((s) => !listed.includes(A(s))),
  String(ex.redirected),
);
t("reserved (1): /a/founders-domain-test belongs to the domain test", ex.reserved === 1 && !listed.includes(A("founders-domain-test")));
t(
  "unservable slugs (2): uppercase/underscore and a leading slash",
  ex.invalid_slug === 2 && !listed.some((l) => /Bad_Slug|leading-slash/.test(l)),
  String(ex.invalid_slug),
);
t(
  "duplicate slug (3): legacy twins of a published tenant page (even a noindex one) and a doubled legacy slug",
  ex.duplicate_slug === 3 &&
    listed.filter((l) => l === A("austin-pools")).length === 1 &&
    !listed.includes(A("hidden-austin")) &&
    !listed.includes(A("twin")),
  String(ex.duplicate_slug),
);
t("in_sitemap=false legacy pages are neither listed nor counted", !listed.includes(A("not-listed")));
t("a legacy draft is never read as published", !listed.includes(A("legacy-draft")));
t(
  "included + every exclusion accounts for all 24 tenant pages and all 8 published in_sitemap legacy rows",
  c.urls.length + Object.values(ex).reduce((a, b) => a + b, 0) === 24 + 8,
  `${c.urls.length} + ${Object.values(ex).reduce((a, b) => a + b, 0)}`,
);
t("the unkeyed listing is reported, not hidden", c.warnings.some((w) => /1 published listing hasn't been matched/.test(w)), JSON.stringify(c.warnings));
t("the unreadable filter is reported", c.warnings.some((w) => /1 page has a listing filter that can't be read/.test(w)));

console.log("\none bounded aggregation, never a query per page");
t("inventory_coverage_groups was called once for the build", aggregationCallsForOneBuild === 1, String(aggregationCallsForOneBuild));
t(
  "no per-page listing read: tenant_listings is never queried by the sitemap",
  listingReadsForOneBuild === 0 && fake.count("tenant_listings") === 0,
  String(fake.count("tenant_listings")),
);
t(
  "the aggregation asked for an exact count (so a capped response is detected)",
  fake.hits.filter((h) => h.name === "inventory_coverage_groups").every((h) => /count=exact/.test(h.prefer)),
);
t(
  "bodies are read only for pages judged on their text (the resource-article template)",
  fake.hits.some((h) => h.name === "tenant_pages" && h.params.get("select") === "id,body_markdown" && h.params.get("template_id") === `in.(${T_RES})`),
);
t(
  "the page read never selects bodies",
  fake.hits
    .filter((h) => h.name === "tenant_pages" && h.params.get("status") === "eq.published" && !h.params.has("template_id"))
    .every((h) => !(h.params.get("select") ?? "").includes("body_markdown")),
);
t("content_pages is only ever read (no write of any kind)", fake.hits.filter((h) => h.name === "content_pages").every((h) => h.method === "GET"));
t("nothing is written anywhere by the sitemap", fake.hits.every((h) => h.method === "GET" || h.method === "HEAD" || (h.kind === "rpc" && h.method === "POST")));

for (const n of [1, 40, 3000]) {
  seed();
  const extra: Row[] = Array.from({ length: n }, (_, i) =>
    page(WS_A, `bulk-${i}`, i % 2 ? T_CITY : T_CAT, { listing_filter: i % 2 ? place("austin", "tx") : category("pool") }),
  );
  fake.set("tenant_pages", [...fake.rows("tenant_pages"), ...extra]);
  fake.clearHits();
  const res = await get(HOST_A);
  t(
    `${n} more listing pages → still exactly one aggregation call (and all listed)`,
    fake.count("inventory_coverage_groups") === 1 && locsOf(res.body).filter((l) => /\/a\/bulk-/.test(l)).length === n,
    `${fake.count("inventory_coverage_groups")} calls, ${locsOf(res.body).filter((l) => /\/a\/bulk-/.test(l)).length} listed`,
  );
}
{
  seed();
  fake.set("tenant_pages", [page(WS_A, "only-an-article", T_RES, { body_markdown: LONG })]);
  fake.clearHits();
  const res = await get(HOST_A);
  t(
    "no page needs a listing count → no aggregation call at all",
    fake.count("inventory_coverage_groups") === 0 && locsOf(res.body).includes(A("only-an-article")),
    `${fake.count("inventory_coverage_groups")} ${JSON.stringify(locsOf(res.body))}`,
  );
  t(
    "…and legacy pages whose tenant twins are gone are listed again",
    locsOf(res.body).includes(A("austin-pools")) && locsOf(res.body).includes(A("hidden-austin")),
  );
}
{
  // More groups than one PostgREST response carries: the SAME aggregation, in ranges.
  seed();
  const many: Row[] = Array.from({ length: 2500 }, (_, i) => ({
    country_key: "us", region_key: "tx", city_key: `city-${String(i).padStart(4, "0")}`, category_key: "pool",
    listing_count: 1, unkeyed_count: 0,
  }));
  fake.rpcs.inventory_coverage_groups = () => many;
  fake.set("tenant_pages", [page(WS_A, "city-2499-pools", T_CITY, { listing_filter: place("city-2499", "tx") })]);
  fake.clearHits();
  const res = await get(HOST_A);
  t(
    "2,500 groups (past the 1,000-row cap) are read in 3 ranges of the one aggregation, and the last group counts",
    fake.count("inventory_coverage_groups") === 3 && locsOf(res.body).includes(A("city-2499-pools")),
    `${fake.count("inventory_coverage_groups")} calls; ${res.status}`,
  );
  const offsets = fake.hits.filter((h) => h.name === "inventory_coverage_groups").map((h) => h.params.get("offset"));
  t("…at offsets 0 / 1000 / 2000, in a total order", JSON.stringify(offsets) === '["0","1000","2000"]' &&
    fake.hits.filter((h) => h.name === "inventory_coverage_groups").every((h) => h.params.get("order") === "country_key.asc.nullsfirst,region_key.asc.nullsfirst,city_key.asc.nullsfirst,category_key.asc.nullsfirst"),
    JSON.stringify(offsets));
  let call = 0;
  fake.rpcs.inventory_coverage_groups = () => (++call === 1 ? many : many.slice(0, 2400));
  const changed = await get(HOST_A);
  t("inventory that changes between ranges is not trusted: 503", changed.status === 503, String(changed.status));
}

console.log("\n<lastmod> is the row's own timestamp");
seed();
const first = await get(HOST_A);
// Move the clock years ahead — `new Date()` and Date.now() both — and ask again.
const RealDate = Date;
const FUTURE = RealDate.UTC(2031, 5, 1);
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(FUTURE);
    else super(...(args as [string]));
  }
  static now() {
    return FUTURE;
  }
}
globalThis.Date = FrozenDate as unknown as DateConstructor;
const second = await get(HOST_A);
globalThis.Date = RealDate;
t("the clock really moved for the second request", new FrozenDate().getTime() === FUTURE);
t("the same request twice (with the clock moved years ahead) returns the same bytes", first.body === second.body);
t("lastmod is updated_at to the second, not the request time", lastmodFor(first.body, A("austin-pools")) === "2026-09-20T10:00:00Z", String(lastmodFor(first.body, A("austin-pools"))));
t(
  "a legacy page's lastmod is its own updated_at",
  lastmodFor(first.body, A("legacy-guide")) === new Date(String(fake.rows("content_pages").find((p) => p.slug === "legacy-guide")!.updated_at)).toISOString().replace(/\.\d{3}Z$/, "Z"),
);
t("no lastmod is the current year's today", !/<lastmod>2031/.test(second.body));
{
  // A row with no usable timestamp gets no <lastmod> at all (optional in the protocol) — never "now".
  seed();
  fake.update("tenant_pages", (p) => p.slug === "pool-rentals", { updated_at: "not a date", published_at: null });
  const res = await get(HOST_A);
  t("a page with no usable timestamp is listed without <lastmod>", res.body.includes(`<url><loc>${A("pool-rentals")}</loc></url>`), res.body.slice(0, 400));
}
{
  seed();
  const before = locsOf((await get(HOST_A)).body);
  fake.update("tenant_pages", (p) => p.slug === "austin-pools", { updated_at: "2026-09-27T00:00:00Z" });
  const after = await get(HOST_A);
  t("editing a page changes its lastmod…", lastmodFor(after.body, A("austin-pools")) === "2026-09-27T00:00:00Z");
  t("…but not the order of the URLs (ordered by first publication, then id)", JSON.stringify(before) === JSON.stringify(locsOf(after.body)));
  const orderAts = locsOf(after.body);
  t("the legacy page (created 2025) comes before the 2026 pages", orderAts.indexOf(A("legacy-guide")) < orderAts.indexOf(A("austin-pools")));
}

console.log("\nanother tenant's pages never leak");
seed();
const b = await get(HOST_B);
t("B's host lists B's page", locsOf(b.body).includes(`https://${HOST_B}/a/b-only-page`), b.body.slice(0, 300));
t("…and B's legacy page", locsOf(b.body).includes(`https://${HOST_B}/a/b-legacy`));
t("…and nothing of A's", !locsOf(b.body).some((l) => /austin|legacy-guide|pool-rentals/.test(l)));
t("A's host never lists B's pages", !locsOf((await get(HOST_A)).body).some((l) => /b-only-page|b-legacy/.test(l)));

console.log("\nthe billing pause: an empty sitemap, never someone else's");
{
  seed();
  fake.update("workspaces", (w) => w.id === WS_A, { subscription_status: "canceled", current_period_end: "2020-01-01T00:00:00Z" });
  fake.clearHits();
  const res = await get(HOST_A);
  t("a workspace whose pages do not serve gets 200 with an empty <urlset>", res.status === 200 && res.body.includes("<urlset") && locsOf(res.body).length === 0, `${res.status} ${res.body}`);
  t("…without reading any page", fake.count("tenant_pages") === 0 && fake.count("inventory_coverage_groups") === 0);
  const paused = await sm.collectSitemap(WS_A, { statusCounts: true });
  t("the screen's collection still counts everything, and says the pages are paused", paused.complete && paused.serving?.serve === false && paused.urls.length === 8);
  fake.rpcs.workspace_granted_pages = () => 25;
  const granted = await get(HOST_A);
  t("a grant keeps the pages (and the sitemap) serving, as on the page path", locsOf(granted.body).length === 8);
}

console.log("\nany failed or partial read: 503, never a shorter sitemap");
const failCases: Array<[string, (h: import("./_support/fake-postgrest-sitemap").Hit) => boolean]> = [
  ["the host lookup", (h) => h.name === "workspace_domains"],
  ["the legacy host branch", (h) => h.name === "workspaces" && (h.params.get("marketplace_domain") ?? "").startsWith("ilike.")],
  ["billing", (h) => h.name === "workspaces" && h.params.get("id") === `eq.${WS_A}`],
  ["the grant", (h) => h.name === "workspace_granted_pages"],
  ["the templates", (h) => h.name === "page_templates"],
  ["the first page of published pages", (h) => h.name === "tenant_pages" && !h.params.has("id")],
  ["a later page of published pages", (h) => h.name === "tenant_pages" && (h.params.get("id") ?? "").startsWith("gt.") && !h.params.has("template_id")],
  ["the article bodies", (h) => h.name === "tenant_pages" && h.params.has("template_id")],
  ["the legacy pages", (h) => h.name === "content_pages" && h.params.get("status") === "eq.published"],
  ["the redirects", (h) => h.name === "content_pages" && h.params.get("status") === "eq.redirect"],
  ["the inventory aggregation", (h) => h.name === "inventory_coverage_groups"],
];
for (const [label, when] of failCases) {
  seed();
  fake.failWhen = (h) => (when(h) ? "statement timeout" : null);
  const quiet = console.error;
  console.error = () => {};
  const res = await get(HOST_A);
  console.error = quiet;
  t(
    `${label} failing → 503 (no-store, Retry-After), no XML`,
    res.status === 503 && res.headers["Cache-Control"] === "no-store" && res.headers["Retry-After"] === "300" && !res.body.includes("<urlset"),
    `${res.status} ${res.body.slice(0, 60)}`,
  );
}
{
  seed();
  fake.failWhen = (h) => (h.name === "tenant_pages" ? "boom" : null);
  const quiet = console.error;
  console.error = () => {};
  const c2 = await sm.collectSitemap(WS_A, { statusCounts: true });
  console.error = quiet;
  t("the screen's collection says incomplete, in words, and lists nothing", !c2.complete && c2.urls.length === 0 && c2.problems.some((p) => /published pages/.test(p)), JSON.stringify(c2.problems));
  fake.failWhen = null;
}
{
  seed();
  // A page read that stops short of the table: every row is still read (keyset past the cap).
  fake.maxRows = 3;
  const res = await get(HOST_A);
  fake.maxRows = 1000;
  t("a server that caps every response at 3 rows still yields the full sitemap", JSON.stringify(locsOf(res.body).sort()) === JSON.stringify([...EXPECTED].sort()), JSON.stringify(locsOf(res.body)));
}

done();
