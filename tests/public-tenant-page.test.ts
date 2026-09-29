/**
 * THE PUBLIC PAGE LOADER, DRIVEN. Run: bun tests/public-tenant-page.test.ts
 *
 * Runs the real loadPublicTenantPage (what getPublicTenantPage serves) and
 * buildTenantPageData against an in-memory PostgREST behind the real
 * supabase-js service-role client (tests/_support/fake-postgrest.ts): the
 * queries the code builds — applyFilter's key filters included — are applied
 * to fixture tables, so what is asserted is what the database would return.
 *
 *  - listings come only from the page's own filter: Portland, OR never shows
 *    Portland, ME, another tenant's listings or an unpublished one; a legacy
 *    v1 filter keeps its meaning; an invalid filter renders no listings;
 *  - only the listing's public columns are read, and its stored
 *    structured_data (InStock) never reaches the page;
 *  - drafts, suspended pages and pages whose template has no active renderer
 *    are never served — publicly or in the preview; a redirect row is a
 *    permanent move; an unknown host or a lapsed workspace serves nothing;
 *  - branding, the marketplace's URLs, related pages (bounded, one read,
 *    same city first) and the exact matching count;
 *  - a failed read is an error, never "no listings" and never a 404.
 * Offline.
 */
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";

import { FakeBackend } from "./_support/fake-backend";
import { applyPostgrestQuery, serveTables, type Row, type Tables } from "./_support/fake-postgrest";
import { LISTING_PUBLIC_COLUMNS } from "../src/lib/coverage/inventory.server";
import { listingKeys, makeFilter, resolveFilter } from "../src/lib/coverage/target";

const { loadPublicTenantPage, redirectTarget } = await import("../src/lib/public-tenant-page.functions");
const { buildTenantPageData, rankRelatedPages, RELATED_PAGES_MAX, listingPrice, minorToDecimal } = await import(
  "../src/lib/tenant-page-data.server"
);

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const WS = "11111111-1111-4111-8111-111111111111";
const WS2 = "22222222-2222-4222-8222-222222222222";
const WS3 = "33333333-3333-4333-8333-333333333333";
const HOST = "www.splash-pools.example";
const HOST2 = "other-market.example";
const HOST3 = "lapsed.example";
const FUTURE = new Date(Date.now() + 20 * 86_400_000).toISOString();

const TPL = {
  city: { slug: "city_hub", is_active: true },
  category: { slug: "category_page", is_active: true },
  article: { slug: "resource_article", is_active: true },
  neighborhood: { slug: "neighborhood", is_active: false },
  cityOff: { slug: "city_hub", is_active: false },
};
const BRAND = { name: "Splash Pools Inc", brand_name: "Splash", brand_color: "#0EA5E9", logo_url: "https://cdn.splash-pools.example/logo.png" };
const BRAND2 = { name: "Other Market", brand_name: null, brand_color: "orange", logo_url: "javascript:alert(1)" };

const placeFilter = (city: string, state: string, country = "US", limit?: number) =>
  makeFilter(["country", "region", "city"], listingKeys({ city, state, country }), { city, region: state, country }, limit);

let seq = 0;
function page(ws: string, slug: string, tpl: object, filter: unknown, over: Row = {}): Row {
  seq++;
  return {
    id: `page-${seq}`,
    workspace_id: ws,
    slug,
    status: "published",
    title: `${slug} title`,
    seo_title: null,
    h1: `${slug} heading`,
    meta_description: `About ${slug}.`,
    body_markdown: "Body text ".repeat(40),
    variables: {},
    listing_filter: filter,
    noindex: false,
    template_id: `tpl-${(tpl as { slug: string }).slug}`,
    published_at: new Date(Date.UTC(2026, 8, 1, 0, seq)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 8, 20, 0, seq)).toISOString(),
    page_templates: tpl,
    workspaces: ws === WS ? BRAND : BRAND2,
    ...over,
  };
}

function listing(ws: string, id: string, p: Row): Row {
  const keys = listingKeys({ city: p.city, state: p.state, country: p.country, category: p.category });
  return {
    id,
    workspace_id: ws,
    sharetribe_listing_id: `5c7d0000-0000-4000-8000-${id.replace(/[^0-9]/g, "").padStart(12, "0")}`,
    title: `Listing ${id}`,
    description: "desc",
    price_amount: 12500,
    price_currency: "USD",
    price_unit: "hour",
    images: [{ url: `https://img.example/${id}.jpg`, width: 400, height: 300, alt: "" }],
    marketplace_url: `https://stale.example/l/x/${id}`,
    structured_data: { "@type": "Product", offers: { availability: "https://schema.org/InStock" } },
    custom_fields: { privateNote: "never public" },
    author_name: "Owner Name",
    state_published: true,
    country_key: keys.countryKey,
    region_key: keys.regionKey,
    city_key: keys.cityKey,
    category_key: keys.categoryKey,
    ...p,
  };
}

function freshTables(): Tables {
  seq = 0;
  const extraOther = Array.from({ length: 12 }, (_, i) =>
    page(WS, `extra-page-${i + 1}`, TPL.city, placeFilter(`Town ${i + 1}`, "WA")),
  );
  return {
    workspaces: [
      { id: WS, slug: "splash", ...BRAND, subscription_status: "active", trial_ends_at: null, current_period_end: FUTURE },
      { id: WS2, slug: "other", ...BRAND2, subscription_status: "active", trial_ends_at: null, current_period_end: FUTURE },
      { id: WS3, slug: "lapsed", name: "Lapsed", subscription_status: "canceled", trial_ends_at: null, current_period_end: null },
    ],
    tenant_integrations: [
      { workspace_id: WS, provider: "sharetribe", marketplace_url: "https://www.splash-pools.example", route_config: null },
      { workspace_id: WS2, provider: "sharetribe", marketplace_url: "https://other-market.example/", route_config: { listingRouteTemplate: "/listing/{id}", searchPath: "/search" } },
    ],
    tenant_pages: [
      page(WS, "pool-rentals-portland-or", TPL.city, placeFilter("Portland", "Oregon"), { seo_title: "Pool rentals in Portland, OR | Splash", variables: { intro: "Private pools across Portland." } }),
      page(WS, "pool-rentals-portland-me", TPL.city, placeFilter("Portland", "ME")),
      page(WS, "legacy-portland", TPL.city, { city: "Portland", state: "OR", limit: 24, sort: "newest" }, { variables: { city: "Portland", state: "OR", category_plural: "pool rentals" } }),
      page(WS, "broken-filter", TPL.city, { v: 2, scope: ["city"] }),
      page(WS, "one-per-page", TPL.city, placeFilter("Portland", "OR", "US", 1)),
      page(WS, "pool-guide", TPL.article, placeFilter("Portland", "OR")),
      page(WS, "general-guide", TPL.article, makeFilter([], { countryKey: null, regionKey: null, cityKey: null, categoryKey: null })),
      page(WS, "pools", TPL.category, makeFilter(["category"], listingKeys({ category: "Pool" }), { category: "Pool" })),
      page(WS, "draft-page", TPL.city, placeFilter("Portland", "OR"), { status: "draft" }),
      page(WS, "suspended-page", TPL.city, placeFilter("Portland", "OR"), { status: "billing_suspended" }),
      page(WS, "neighborhood-page", TPL.neighborhood, placeFilter("Portland", "OR")),
      page(WS, "inactive-template", TPL.cityOff, placeFilter("Portland", "OR")),
      ...extraOther,
      page(WS2, "pool-rentals-portland-or", TPL.city, placeFilter("Portland", "OR"), { title: "Other market's Portland page" }),
      page(WS3, "pool-rentals-portland-or", TPL.city, placeFilter("Portland", "OR")),
    ],
    tenant_listings: [
      listing(WS, "l-or-1", { city: "Portland", state: "OR", country: "US", category: "Pool", synced_at: "2026-09-27T10:00:00Z" }),
      listing(WS, "l-or-2", { city: "Portland", state: "Oregon", country: "USA", category: "Pool", synced_at: "2026-09-27T11:00:00Z", price_amount: 5000, price_currency: "JPY", price_unit: "day" }),
      listing(WS, "l-or-off", { city: "Portland", state: "OR", country: "US", category: "Pool", state_published: false, synced_at: "2026-09-27T12:00:00Z" }),
      listing(WS, "l-or-nocountry", { city: "Portland", state: "OR", country: null, category: "Pool", synced_at: "2026-09-26T09:00:00Z" }),
      listing(WS, "l-me-1", { city: "Portland", state: "ME", country: "US", category: "Pool", synced_at: "2026-09-27T09:00:00Z" }),
      listing(WS, "l-me-2", { city: "Portland", state: "Maine", country: "US", category: "Hot tub", synced_at: "2026-09-27T08:00:00Z" }),
      listing(WS, "l-salem", { city: "Salem", state: "OR", country: "US", category: "Pool", synced_at: "2026-09-27T07:00:00Z" }),
      listing(WS2, "l-other-or", { city: "Portland", state: "OR", country: "US", category: "Pool", synced_at: "2026-09-28T07:00:00Z" }),
    ],
    content_pages: [
      { id: "cp-1", workspace_id: WS, slug: "old-pool-page", url_path: "/p/old-pool-page", status: "redirect", redirect_to: "/a/pool-rentals-portland-or" },
      { id: "cp-2", workspace_id: WS, slug: "loop-page", url_path: null, status: "redirect", redirect_to: "/a/loop-page" },
      { id: "cp-3", workspace_id: WS, slug: "legacy-guide", url_path: "/p/legacy-guide", status: "published", title: "Legacy guide", seo_title: "Legacy guide | Splash", seo_description: "An old guide.", body_markdown: "Old body ".repeat(50), updated_at: "2026-05-01T00:00:00Z", workspaces: BRAND },
      { id: "cp-4", workspace_id: WS, slug: "legacy-draft", url_path: null, status: "draft", title: "Hidden", body_markdown: "x" },
    ],
    content_404_log: [],
  };
}

const backend = new FakeBackend();
backend.install();
let tables: Tables = freshTables();
function reset(errors: Partial<Record<string, string>> = {}) {
  tables = freshTables();
  backend.hits = [];
  serveTables(backend, tables, errors);
  backend.rpc = {
    current_workspace_id_by_host: (a: { _host: string }) =>
      ({ [HOST]: WS, [HOST2]: WS2, [HOST3]: WS3 } as Record<string, string>)[a._host] ?? null,
    workspace_granted_pages: () => 0,
  };
}
const reads = (table: string) => backend.hits.filter((h) => h.kind === "rest" && h.name === table && (h.method === "GET" || h.method === "HEAD"));
const ids = (r: { page: { listings: Array<{ id: string }> } | null }) => (r.page?.listings ?? []).map((l) => l.id).join(",");

// ---------------------------------------------------------------------------
console.log("\n1. listings come from the page's own filter, and nowhere else");
{
  reset();
  const r = await loadPublicTenantPage({ slug: "pool-rentals-portland-or" }, HOST);
  t("the page is served with its template", r.page?.page.kind === "city_hub" && r.page.page.slug === "pool-rentals-portland-or" && !r.redirect && !r.billingBlocked);
  t("Portland, OR: only the published OR listings, newest first", ids(r) === "l-or-2,l-or-1", ids(r));
  t("…never Portland, ME, never unpublished, never another tenant's", !/l-me|l-or-off|l-other/.test(ids(r)));
  const q = reads("tenant_listings")[0]?.query;
  t("the listing query is the key filter (applyFilter)", q?.get("city_key") === "eq.portland" && q?.get("region_key") === "eq.or" && q?.get("country_key") === "eq.us" && q?.get("state_published") === "eq.true" && q?.get("workspace_id") === `eq.${WS}`, q?.toString());
  t("…reading only the public columns", q?.get("select") === LISTING_PUBLIC_COLUMNS.replace(/ /g, "") || q?.get("select") === LISTING_PUBLIC_COLUMNS, q?.get("select") ?? "");
  t("…and nothing private reaches the page", !/never public|Owner Name|custom_fields|author_name/.test(JSON.stringify(r)));
  t("the stored structured_data (InStock) is dropped", !/InStock|structured_data|"Product"/.test(JSON.stringify(r)));
  t("fewer listings than the limit → the exact count without a count query", r.page?.page.matchingListings === 2 && reads("tenant_listings").filter((h) => h.method === "HEAD").length === 0);
  const me = await loadPublicTenantPage({ slug: "pool-rentals-portland-me" }, HOST);
  t("Portland, ME: only the ME listings", ids(me) === "l-me-1,l-me-2", ids(me));
  const other = await loadPublicTenantPage({ slug: "pool-rentals-portland-or" }, HOST2);
  t("the same slug on another tenant's host is that tenant's page and listings", other.page?.page.title === "Other market's Portland page" && ids(other) === "l-other-or", ids(other));
}
{
  reset();
  const legacy = await loadPublicTenantPage({ slug: "legacy-portland" }, HOST);
  t("a legacy v1 filter keeps its meaning (city + state, any country)", ids(legacy) === "l-or-2,l-or-1,l-or-nocountry", ids(legacy));
  t("…its legacy noun and labels ride along", legacy.page?.page.listingNoun === "pool rentals" && legacy.page?.page.place.city === "Portland" && legacy.page?.page.place.region === "OR");
  reset();
  const broken = await loadPublicTenantPage({ slug: "broken-filter" }, HOST);
  t("an invalid filter: the page renders, with no listings (never a guess)", broken.page?.page.slug === "broken-filter" && broken.page.listings.length === 0);
  t("…and no listing query is made at all", reads("tenant_listings").length === 0);
  reset();
  const capped = await loadPublicTenantPage({ slug: "one-per-page" }, HOST);
  t("a full page counts the exact total (one HEAD count; the country-less listing is not in a US filter)", capped.page?.listings.length === 1 && capped.page.page.matchingListings === 2 && reads("tenant_listings").filter((h) => h.method === "HEAD").length === 1, String(capped.page?.page.matchingListings));
  reset();
  const cat = await loadPublicTenantPage({ slug: "pools" }, HOST);
  t("a Category Page: every published Pool listing of this workspace", ids(cat) === "l-or-2,l-or-1,l-me-1,l-salem,l-or-nocountry", ids(cat));
}

console.log("\n   the listings as the cards show them");
{
  reset();
  const r = await loadPublicTenantPage({ slug: "pool-rentals-portland-or" }, HOST);
  const l2 = r.page!.listings[0]!;
  const l1 = r.page!.listings[1]!;
  t("links are derived by the adapter from the marketplace URL, not the stale stored one",
    l1.url === `https://www.splash-pools.example/l/listing-l-or-1/${tables.tenant_listings![0]!.sharetribe_listing_id}` && !JSON.stringify(r).includes("stale.example"), l1.url ?? "");
  t("USD minor units → $125 per hour", l1.price?.text === "$125" && l1.price.unitText === "per hour" && l1.price.amount === "125.00" && l1.price.currency === "USD");
  t("JPY → ¥5,000 per day", l2.price?.text === "¥5,000" && l2.price.unitText === "per day" && l2.price.amount === "5000");
  t("images carry alt text (the title when the image has none)", l1.image?.url === "https://img.example/l-or-1.jpg" && l1.image.alt === "Listing l-or-1" && l1.image.width === 400);
  reset();
  const other = await loadPublicTenantPage({ slug: "pool-rentals-portland-or" }, HOST2);
  t("a customised route template is honoured", other.page?.listings[0]?.url === `https://other-market.example/listing/${tables.tenant_listings![7]!.sharetribe_listing_id}`, other.page?.listings[0]?.url ?? "");
  t("…and the browse link uses its search path", other.page?.marketplace.browseUrl === "https://other-market.example/search" && other.page.marketplace.homeUrl === "https://other-market.example/");
}

// ---------------------------------------------------------------------------
console.log("\n2. branding and the marketplace");
{
  reset();
  const r = await loadPublicTenantPage({ slug: "pool-rentals-portland-or" }, HOST);
  t("brand name, colour (normalised) and logo", JSON.stringify(r.page?.branding) === JSON.stringify({ name: "Splash", color: "#0ea5e9", logoUrl: "https://cdn.splash-pools.example/logo.png" }), JSON.stringify(r.page?.branding));
  t("marketplace home and unfiltered search from tenant_integrations", r.page?.marketplace.homeUrl === "https://www.splash-pools.example/" && r.page.marketplace.browseUrl === "https://www.splash-pools.example/s");
  t("seo_title and the lede (variables.intro) are read", r.page?.page.seoTitle === "Pool rentals in Portland, OR | Splash" && r.page.page.intro === "Private pools across Portland.");
  const other = await loadPublicTenantPage({ slug: "pool-rentals-portland-or" }, HOST2);
  t("no brand name → the workspace name; an invalid colour or logo → none (neutral)", JSON.stringify(other.page?.branding) === JSON.stringify({ name: "Other Market", color: null, logoUrl: null }), JSON.stringify(other.page?.branding));
  reset({ tenant_integrations: "boom" });
  const noCfg = await loadPublicTenantPage({ slug: "pool-rentals-portland-or" }, HOST);
  t("a failed marketplace read degrades: stored listing URLs, no CTA URL — never a broken page",
    noCfg.page?.listings[0]?.url === "https://stale.example/l/x/l-or-2" && noCfg.page.marketplace.homeUrl === null && noCfg.page.marketplace.browseUrl === null);
}

// ---------------------------------------------------------------------------
console.log("\n3. related pages: bounded, one read, same city first");
{
  reset();
  const r = await loadPublicTenantPage({ slug: "pool-rentals-portland-or" }, HOST);
  const rel = r.page!.related;
  t(`at most ${RELATED_PAGES_MAX}`, rel.length === RELATED_PAGES_MAX, String(rel.length));
  t("never the page itself", !rel.some((x) => x.slug === "pool-rentals-portland-or"));
  t("never a draft, a suspended page, or a template with no renderer", !rel.some((x) => /draft-page|suspended-page|neighborhood-page|inactive-template/.test(x.slug)));
  t("same city (Portland, OR) first — Portland, ME is not the same city",
    rel.slice(0, 3).map((x) => x.slug).sort().join(",") === "legacy-portland,one-per-page,pool-guide" && rel.slice(0, 3).every((x) => x.relation === "same_city") && rel.find((x) => x.slug === "pool-rentals-portland-me")?.relation !== "same_city",
    rel.map((x) => `${x.slug}:${x.relation}`).join(" "));
  t("link text is the page heading", rel.find((x) => x.slug === "pool-guide")?.title === "pool-guide heading");
  const pageReads = reads("tenant_pages");
  t("two tenant_pages reads per view: the page and ONE related read (no per-page queries)", pageReads.length === 2, String(pageReads.length));
  const relQ = pageReads[1]!.query;
  t("the related read is bounded and published-only", relQ.get("limit") === "200" && relQ.get("status") === "eq.published" && relQ.get("slug") === "neq.pool-rentals-portland-or" && relQ.get("workspace_id") === `eq.${WS}`);
  const ranked = rankRelatedPages(resolveFilter(placeFilter("Portland", "OR")), [
    { slug: "a-me", h1: "ME", listing_filter: placeFilter("Portland", "ME"), page_templates: TPL.city },
    { slug: "b-cat", h1: "Pools", listing_filter: makeFilter(["category"], listingKeys({ category: "pool" })), page_templates: TPL.category },
    { slug: "c-or", h1: "OR", listing_filter: { city: "Portland", state: "OR" }, page_templates: TPL.article },
    { slug: "d-salem", h1: "Salem", listing_filter: placeFilter("Salem", "OR"), page_templates: TPL.city },
    { slug: "BAD SLUG", h1: "x", listing_filter: {}, page_templates: TPL.city },
  ]);
  t("ranking: same city, then same region, then the rest (in read order)", ranked.map((x) => `${x.slug}:${x.relation}`).join(",") === "c-or:same_city,d-salem:same_region,a-me:other,b-cat:other", ranked.map((x) => `${x.slug}:${x.relation}`).join(","));
}

// ---------------------------------------------------------------------------
console.log("\n4. what is never served");
for (const slug of ["draft-page", "suspended-page"]) {
  reset();
  const r = await loadPublicTenantPage({ slug }, HOST);
  t(`${slug}: not served publicly`, r.page === null && !r.redirect);
  const q = reads("tenant_pages")[0]?.query;
  t(`${slug}: the read asks for published pages only`, q?.get("status") === "eq.published");
  reset();
  const pv = await loadPublicTenantPage({ slug, workspaceSlug: "splash" }, "www.founders.click");
  t(`${slug}: not served in the preview either`, pv.page === null && pv.preview === true);
  t(`${slug}: the preview records no 404`, tables.content_404_log!.length === 0);
}
{
  reset();
  await loadPublicTenantPage({ slug: "draft-page" }, HOST);
  t("a public miss is recorded in the 404 log", tables.content_404_log!.some((r) => r.url_path === "/a/draft-page" && r.workspace_id === WS));
  reset();
  const legacyDraft = await loadPublicTenantPage({ slug: "legacy-draft" }, HOST);
  t("a legacy draft is not served either", legacyDraft.page === null);
  for (const [slug, kind] of [["neighborhood-page", "neighborhood"], ["inactive-template", "city_hub"]] as const) {
    reset();
    const r = await loadPublicTenantPage({ slug }, HOST);
    t(`${slug}: a template with no active renderer is not served (never as City Hub)`, r.page === null && r.unsupportedTemplate === kind, JSON.stringify(r).slice(0, 120));
    t(`${slug}: …and no listing read is spent on it`, reads("tenant_listings").length === 0);
  }
  reset();
  const unknown = await loadPublicTenantPage({ slug: "pool-rentals-portland-or" }, "stranger.example");
  t("an unknown host serves nothing", unknown.page === null && reads("tenant_pages").length === 0 && tables.content_404_log!.length === 0);
  reset();
  const noHost = await loadPublicTenantPage({ slug: "pool-rentals-portland-or" }, null);
  t("no host at all serves nothing", noHost.page === null && backend.hits.length === 0);
  reset();
  const lapsed = await loadPublicTenantPage({ slug: "pool-rentals-portland-or" }, HOST3);
  t("a lapsed workspace is withheld (billing gate) before any page read", lapsed.page === null && lapsed.billingBlocked === true && reads("tenant_pages").length === 0);
  reset();
  const lapsedPreview = await loadPublicTenantPage({ slug: "pool-rentals-portland-or", workspaceSlug: "lapsed" }, "www.founders.click");
  t("…in the preview too", lapsedPreview.billingBlocked === true && lapsedPreview.page === null);
  reset();
  const bad = await loadPublicTenantPage({ slug: "x,slug.neq.zzz" }, HOST);
  t("a non-slug is refused before any request", bad.page === null && backend.hits.length === 0);
}

console.log("\n5. redirects are permanent moves");
{
  reset();
  const r = await loadPublicTenantPage({ slug: "old-pool-page" }, HOST);
  t("a redirect row answers with its target (the route sends 301)", r.redirect === "/a/pool-rentals-portland-or" && r.page === null);
  t("…found through the validated .or(slug, /a/, /p/) lookup", reads("content_pages")[0]?.query.get("or") === "(slug.eq.old-pool-page,url_path.eq./a/old-pool-page,url_path.eq./p/old-pool-page)");
  reset();
  const pv = await loadPublicTenantPage({ slug: "old-pool-page", workspaceSlug: "splash" }, "www.founders.click");
  t("in the preview a move to another /a/ page stays in the preview", pv.redirect === "/s/splash/pool-rentals-portland-or");
  reset();
  const loop = await loadPublicTenantPage({ slug: "loop-page" }, HOST);
  t("a redirect to itself is ignored (no loop)", !loop.redirect);
  t("redirect targets: same-site paths and http(s) only",
    redirectTarget("https://elsewhere.example/x", "a") === "https://elsewhere.example/x" &&
      redirectTarget("//evil.example/x", "a") === null &&
      redirectTarget("javascript:alert(1)", "a") === null &&
      redirectTarget("/a/a/", "a") === null &&
      redirectTarget("/p/a?x=1", "a") === null &&
      redirectTarget("/a/b", "a") === "/a/b" &&
      redirectTarget("", "a") === null &&
      redirectTarget(null, "a") === null);
}

console.log("\n6. the legacy content_pages fallback (read-only)");
{
  reset();
  const r = await loadPublicTenantPage({ slug: "legacy-guide" }, HOST);
  t("a published legacy page renders as a Resource Article", r.page?.page.kind === "resource_article" && r.page.page.legacy === true);
  t("…with its own title, SEO title and description", r.page?.page.h1 === "Legacy guide" && r.page.page.seoTitle === "Legacy guide | Splash" && r.page.page.metaDescription === "An old guide.");
  t("…the brand, and no listing read", r.page?.branding.name === "Splash" && reads("tenant_listings").length === 0);
  t("…and nothing is written", backend.hits.every((h) => h.method === "GET" || h.method === "HEAD" || h.kind === "rpc"));
}

console.log("\n7. Resource Articles");
{
  reset();
  const r = await loadPublicTenantPage({ slug: "pool-guide" }, HOST);
  t("a guide naming a place: a small strip of that place's listings", r.page?.page.kind === "resource_article" && ids(r) === "l-or-2,l-or-1", ids(r));
  t("…at most four, read with limit 4", reads("tenant_listings")[0]?.query.get("limit") === "4");
  t("…and no total is counted for an article", r.page?.page.matchingListings === null);
  reset();
  const general = await loadPublicTenantPage({ slug: "general-guide" }, HOST);
  t("a guide with no filter: no strip, and no listing read", general.page?.listings.length === 0 && reads("tenant_listings").length === 0);
}

console.log("\n8. a failed read is an error — never 'no listings', never a 404");
{
  reset({ tenant_listings: "listing read exploded" });
  let threw = "";
  try {
    await loadPublicTenantPage({ slug: "pool-rentals-portland-or" }, HOST);
  } catch (e) {
    threw = (e as Error).message;
  }
  t("City Hub: a failed listing read throws", /listing read failed/.test(threw), threw);
  t("…and records no 404", tables.content_404_log!.length === 0);
  reset({ tenant_listings: "listing read exploded" });
  const guide = await loadPublicTenantPage({ slug: "pool-guide" }, HOST);
  t("Resource Article: the optional strip is dropped, the article still serves", guide.page?.page.kind === "resource_article" && guide.page.listings.length === 0);
  reset({ tenant_pages: "page read exploded" });
  let pageThrew = "";
  try {
    await loadPublicTenantPage({ slug: "pool-rentals-portland-or" }, HOST);
  } catch (e) {
    pageThrew = (e as Error).message;
  }
  t("a failed page read throws (a 500, never a 404 that deindexes the page)", /page read failed/.test(pageThrew) && tables.content_404_log!.length === 0, pageThrew);
}

console.log("\n9. the conversions");
{
  t("minor units to an exact decimal", minorToDecimal(12500, 2) === "125.00" && minorToDecimal(8950, 2) === "89.50" && minorToDecimal(5, 2) === "0.05" && minorToDecimal(5000, 0) === "5000" && minorToDecimal(1234, 3) === "1.234");
  t("no price without a positive whole amount and a currency code",
    listingPrice(null, "USD", null) === null && listingPrice(12500, null, null) === null && listingPrice(12500, "US", null) === null && listingPrice(0, "USD", null) === null && listingPrice(12.5, "USD", null) === null);
  t("KWD has three minor digits", listingPrice(1234, "KWD", "night")?.amount === "1.234" && listingPrice(1234, "KWD", "night")?.unitText === "per night");
  const data = await (async () => {
    reset();
    return buildTenantPageData(WS, { id: null, slug: "draft-preview", title: "Draft", listing_filter: placeFilter("Portland", "ME"), page_templates: TPL.city, workspaces: BRAND }, { kind: "city_hub" });
  })();
  t("buildTenantPageData serves an editor's draft row the same way (id null allowed)", data.page.id === null && data.listings.map((l) => l.id).join(",") === "l-me-1,l-me-2" && data.branding.name === "Splash");
  t("the fake PostgREST applies filters faithfully (self-check)", applyPostgrestQuery([{ a: 1, b: null }, { a: 2, b: "x" }], new URLSearchParams("b=is.null")).length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
