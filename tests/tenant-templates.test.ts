/**
 * THE THREE PAGE TEMPLATES, RENDERED. Run: bun tests/tenant-templates.test.ts
 *
 * Server-renders City Hub, Category Page and Resource Article from realistic
 * data — listings converted from tenant_listings rows by the real
 * toTemplateListing (formatMoney + perUnit + the marketplace adapter) — and
 * asserts what a visitor and a crawler get:
 *
 *  1. the registry: exactly three renderable kinds, and an unknown or retired
 *     template renders the error path, never City Hub;
 *  2. each layout: one <h1>, one <main>, the body, real listing cards with
 *     formatted prices and units (USD minor units, JPY without decimals,
 *     unknown units and missing currencies), followed links to the customer's
 *     marketplace (never nofollow), brand colour and name, the neutral
 *     fallback, sections in the contract's order;
 *  3. the head: title, description, canonical on the verified host, robots
 *     from the page's switch and the shared thin rule (text only for
 *     articles), Open Graph from the page's own listing photo;
 *  4. structured data consistent with what is shown: BreadcrumbList, an
 *     ItemList of the shown listings, an Offer only where a price is shown
 *     (with its currency), an Article for a Resource Article — never
 *     availability / InStock / ratings / reviews / Product;
 *  5. the tenant document shell: no platform identity, absolute stylesheet,
 *     no client script;
 *  6. the thin rule and the keyed listing counter the sitemap can share.
 * Offline.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RENDERABLE_KINDS,
  TEMPLATE_COMPONENTS,
  TemplateRenderer,
  isRenderableKind,
  templateComponentFor,
} from "../src/components/templates/registry";
import { CityHub } from "../src/components/templates/CityHub";
import type {
  TemplateData,
  TemplateKind,
  TemplateListing,
  TemplatePage,
} from "../src/components/templates/types";
import {
  PREVIEW_PAGE_HEADERS,
  PUBLIC_PAGE_HEADERS,
  buildPreviewHead,
  buildTenantPageHead,
  pageIsNoindex,
  tenantCanonicalUrl,
} from "../src/components/templates/head";
import {
  NEUTRAL_BRAND_COLOR,
  accentOnWhite,
  brandPalette,
  contrastRatio,
  safeHttpUrl,
  sanitizeBrandColor,
} from "../src/components/templates/theme";
import {
  isTenantSurfacePath,
  tenantAssetHref,
  tenantHeadTags,
  tenantRootHead,
} from "../src/components/templates/tenant-shell";
import { stripLeadingH1 } from "../src/components/templates/format";
import { TEMPLATE_CONTRACTS } from "../src/lib/templates/contracts";
import { resolveRouteConfig } from "../src/lib/marketplace/adapter";
import { toTemplateListing } from "../src/lib/tenant-page-data.server";
import type { PublicListingRow } from "../src/lib/coverage/inventory.server";
import {
  buildKeyedListingCounter,
  isNoindexPage,
  isThinPage,
  isThinPageMeasured,
} from "../src/lib/thin-page";
import { cityKeyOf, makeFilter, listingKeys } from "../src/lib/coverage/target";

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
const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

// ---------------------------------------------------------------------------
// Fixtures: tenant_listings rows as the sync writes them, converted by the
// real server conversion.
// ---------------------------------------------------------------------------
const MARKET = "https://www.splash-pools.example";
const CFG = resolveRouteConfig(MARKET, null);
function row(p: Partial<PublicListingRow> & { id: string; title: string }): PublicListingRow {
  return {
    sharetribe_listing_id: `6f1c${p.id.replace(/[^a-z0-9]/g, "")}-0000-4000-8000-000000000000`,
    description: "A lovely pool.",
    price_amount: null,
    price_currency: null,
    price_unit: null,
    city: "Portland",
    state: "OR",
    country: "US",
    category: "pool_rental",
    images: [],
    marketplace_url: `${MARKET}/l/stored/${p.id}`,
    // What the sync stores today — it claims InStock. Never emitted.
    structured_data: {
      "@context": "https://schema.org",
      "@type": "Product",
      offers: { "@type": "Offer", availability: "https://schema.org/InStock" },
      aggregateRating: { "@type": "AggregateRating", ratingValue: 5 },
    },
    synced_at: "2026-09-27T12:00:00Z",
    ...p,
  };
}
const ROWS: PublicListingRow[] = [
  row({
    id: "l-usd",
    title: "Sunny heated pool",
    price_amount: 12500,
    price_currency: "USD",
    price_unit: "night",
    images: [{ url: "https://img.example/sunny.jpg", width: 480, height: 360, alt: "Heated pool at dusk" }],
  }),
  row({
    id: "l-cents",
    title: "Lap pool </script><script>alert(1)</script>",
    price_amount: 8950,
    price_currency: "usd",
    price_unit: "hour",
    images: [{ url: "https://img.example/lap.jpg", width: 480, height: 360, alt: "" }],
  }),
  row({
    id: "l-jpy",
    title: "Onsen-style pool",
    price_amount: 5000,
    price_currency: "JPY",
    price_unit: "day",
    city: "Kyoto",
    state: null,
    country: "JP",
    images: [{ url: "javascript:alert(1)" }, { url: "https://img.example/onsen.jpg" }],
  }),
  row({ id: "l-odd", title: "Party pool", price_amount: 20000, price_currency: "USD", price_unit: "session" }),
  row({ id: "l-nocur", title: "Mystery pool", price_amount: 9900, price_currency: null }),
  row({ id: "l-noprice", title: "Ask-for-price pool", price_amount: null, price_currency: "USD" }),
];
const LISTINGS: TemplateListing[] = ROWS.map((r) => toTemplateListing(r, CFG));
const byId = (id: string) => LISTINGS.find((l) => l.id === id)!;

const BODY = [
  "# Private pool rentals in Portland",
  "",
  "Portland summers are short, so a private pool is booked fast. Owners list heated pools, lap pools and family pools across the city, most by the hour.",
  "",
  "## What to expect",
  "",
  "- Heated water from May to September",
  "- [Hourly booking](https://www.splash-pools.example/s) with instant confirmation",
  "- Changing rooms at most pools",
  "",
  "## House rules",
  "",
  "Bring towels and sunscreen. Glass is not allowed around the water, and children must be supervised at all times.",
].join("\n");

function page(kind: TemplateKind, over: Partial<TemplatePage> = {}): TemplatePage {
  return {
    id: `page-${kind}`,
    kind,
    slug: `${kind.replace(/_/g, "-")}-portland-or`,
    title: "Pool rentals in Portland, OR",
    seoTitle: "Private pool rentals in Portland, OR | Splash",
    h1: "Private pool rentals in Portland",
    metaDescription: "Rent a private pool by the hour in Portland, Oregon.",
    intro: "Rent a private pool by the hour in Portland, Oregon.",
    bodyMarkdown: BODY,
    noindex: false,
    publishedAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-20T16:30:00.000Z",
    place: { city: "Portland", region: "OR", country: "US" },
    category: "pool_rental",
    listingNoun: null,
    matchingListings: 31,
    legacy: false,
    ...over,
  };
}
function dataFor(kind: TemplateKind, over: Partial<TemplateData> = {}, pageOver: Partial<TemplatePage> = {}): TemplateData {
  return {
    page: page(kind, pageOver),
    listings: LISTINGS,
    related: [
      { slug: "hot-tubs-portland-or", title: "Hot tubs in Portland", kind: "city_hub", place: "Portland, OR", category: "hot_tub", relation: "same_city" },
      { slug: "pool-rentals-salem-or", title: "Pool rentals in Salem", kind: "city_hub", place: "Salem, OR", category: null, relation: "same_region" },
      { slug: "pool-safety-guide", title: "Pool safety guide", kind: "resource_article", place: null, category: null, relation: "other" },
    ],
    branding: { name: "Splash", color: "#0ea5e9", logoUrl: "https://cdn.splash-pools.example/logo.png" },
    marketplace: { homeUrl: `${MARKET}/`, browseUrl: `${MARKET}/s` },
    ...over,
  };
}
const render = (d: TemplateData, basePath?: string | null) =>
  renderToStaticMarkup(createElement(TemplateRenderer, { ...d, ...(basePath !== undefined ? { basePath } : {}) }));
const KINDS: TemplateKind[] = ["city_hub", "category_page", "resource_article"];

// ---------------------------------------------------------------------------
console.log("\n1. the registry: three kinds, nothing drawn as another template");
t("exactly three renderable kinds", JSON.stringify(RENDERABLE_KINDS) === JSON.stringify(["city_hub", "category_page", "resource_article"]), JSON.stringify(RENDERABLE_KINDS));
t("the registry and the template contracts name the same kinds",
  JSON.stringify(Object.keys(TEMPLATE_COMPONENTS).sort()) === JSON.stringify(Object.keys(TEMPLATE_CONTRACTS).sort()));
t("each kind is renderable", KINDS.every((k) => isRenderableKind(k) && templateComponentFor(k) === TEMPLATE_COMPONENTS[k]));
for (const bad of ["neighborhood", "comparison", "", "City_Hub", "CITY_HUB", "toString", "__proto__", "constructor", null, undefined, 3]) {
  t(`not renderable: ${JSON.stringify(bad)}`, !isRenderableKind(bad) && templateComponentFor(bad) === null);
}
{
  const d = dataFor("city_hub");
  const unknown = render({ ...d, page: { ...d.page, kind: "neighborhood" as TemplateKind } });
  t("an unknown template renders the error path", unknown.includes('data-template-error="unsupported"'), unknown.slice(0, 200));
  t("…and never City Hub (or any template)", !unknown.includes("data-template=") && !unknown.includes("<h1") && !unknown.includes("Sunny heated pool"));
  const explicit = renderToStaticMarkup(createElement(TemplateRenderer, { ...d, kind: "comparison" }));
  t("an explicit unsupported kind renders the error path too", explicit.includes('data-template-error="unsupported"') && !explicit.includes('data-template="city_hub"'));
  const asArticle = renderToStaticMarkup(createElement(TemplateRenderer, { ...d, kind: "resource_article" }));
  t("an explicit kind renders that template (an editor's picker)", asArticle.includes('data-template="resource_article"'));
}

// ---------------------------------------------------------------------------
console.log("\n2. three distinct layouts from the same facts");
const HTML: Record<TemplateKind, string> = {
  city_hub: render(dataFor("city_hub")),
  category_page: render(dataFor("category_page")),
  resource_article: render(dataFor("resource_article")),
};
for (const kind of KINDS) {
  const html = HTML[kind];
  t(`${kind}: its own component rendered`, html.includes(`data-template="${kind}"`));
  t(`${kind}: exactly one <h1>, the page heading`, count(html, /<h1[\s>]/g) === 1 && /<h1[^>]*>Private pool rentals in Portland<\/h1>/.test(html));
  t(`${kind}: exactly one <main>`, count(html, /<main[\s>]/g) === 1);
  t(`${kind}: the body's own leading "# heading" is not a second h1`, !/<h2[^>]*>Private pool rentals in Portland<\/h2>/.test(html));
  t(`${kind}: body markdown rendered with its headings`, /<h2[^>]*id="what-to-expect"[^>]*>What to expect<\/h2>/.test(html) && html.includes("Portland summers are short") && /<li[^>]*>Changing rooms at most pools<\/li>/.test(html));
  t(`${kind}: the lede is shown`, html.includes("Rent a private pool by the hour in Portland, Oregon."));
  const sections = [...html.matchAll(/data-section="([a-z_]+)"/g)].map((m) => m[1]!);
  const contract = TEMPLATE_CONTRACTS[kind].sections;
  let at = 0;
  for (const s of sections) if (s === contract[at]) at++;
  t(`${kind}: sections in the contract's order (${contract.join(" → ")})`, at === contract.length, sections.join(","));
  t(`${kind}: a marketplace call to action`, html.includes('data-cta="marketplace"') && html.includes(`href="${MARKET}/s"`));
  t(`${kind}: a "Browse all" link to the marketplace`, /<a href="https:\/\/www\.splash-pools\.example\/s"[^>]*data-cta="browse-all"[^>]*>Browse all listings on Splash/.test(html));
  t(`${kind}: no platform name, no platform orange`, !/founders\.click/i.test(html) && !/orange|bg-primary|text-primary|border-primary/.test(html));
  t(`${kind}: nothing is nofollow`, !/nofollow/i.test(html));
  const outbound = [...html.matchAll(/<a ([^>]*)href="https?:\/\/[^"]+"([^>]*)>/g)].map((m) => `${m[1]} ${m[2]}`);
  t(`${kind}: every absolute link (marketplace, brand, body) opens beside the page with rel=noopener`,
    outbound.length >= 5 && outbound.every((a) => /target="_blank"/.test(a) && /rel="noopener"/.test(a)), outbound.filter((a) => !/target="_blank"/.test(a)).join(" | "));
  t(`${kind}: no microdata`, !/itemscope|itemprop|itemtype/i.test(html));
  t(`${kind}: the brand colour drives the palette`, html.includes("--tp-brand:#0ea5e9"));
  t(`${kind}: the brand name and logo`, html.includes('alt="Splash"') && html.includes('src="https://cdn.splash-pools.example/logo.png"'));
}
t("the three layouts differ", HTML.city_hub !== HTML.category_page && HTML.category_page !== HTML.resource_article);
t("City Hub: the place, and the exact matching count", HTML.city_hub.includes("Portland, OR") && HTML.city_hub.includes("31 listings") && HTML.city_hub.includes("available in Portland"));
t("Category Page: the category, humanised", HTML.category_page.includes(">Pool rental<") && HTML.category_page.includes("31 listings"));
t("Category Page: cities are grouped", HTML.category_page.includes("Pool rental by city"));
t("Resource Article: an article with a byline and both dates",
  HTML.resource_article.includes("<article") && HTML.resource_article.includes("By Splash") &&
    HTML.resource_article.includes('Published <time dateTime="2026-09-01T10:00:00.000Z">September 1, 2026</time>') &&
    HTML.resource_article.includes('Updated <time dateTime="2026-09-20T16:30:00.000Z">September 20, 2026</time>'));
t("Resource Article: no listing grid, a strip instead", !HTML.resource_article.includes('data-section="listing_grid"') && HTML.resource_article.includes('data-section="related_listings"'));
{
  const noStrip = render(dataFor("resource_article", { listings: [] }));
  t("Resource Article without listings: no strip at all", !noStrip.includes('data-section="related_listings"') && !noStrip.includes("data-listing-id"));
  t("…but still its call to the marketplace", noStrip.includes('data-cta="marketplace"'));
  const empty = render(dataFor("city_hub", { listings: [] }, { matchingListings: 0 }));
  t("City Hub with no listings says so plainly and points to the marketplace",
    empty.includes("There are no listings in Portland right now.") && empty.includes('data-cta="browse-all"') && !empty.includes("0 listings"));
  const unknownTotal = render(dataFor("city_hub", {}, { matchingListings: null }));
  t("no total is claimed when the server did not count one", !/\d+ listings<\/strong>/.test(unknownTotal));
}

console.log("\n   the listing cards");
{
  const html = HTML.city_hub;
  const cards = [...html.matchAll(/<li class="list-none" data-listing-id="([^"]+)">([\s\S]*?)<\/li>/g)].map((m) => ({ id: m[1]!, html: m[2]! }));
  const card = (id: string) => cards.find((c) => c.id === id)?.html ?? "";
  t("one card per listing, in order", cards.map((c) => c.id).join(",") === ROWS.map((r) => r.id).join(","));
  t("USD minor units: 12500 → $125 per night", /<span class="text-base font-semibold">\$125<\/span><span class="text-slate-600"> per night<\/span>/.test(card("l-usd")), card("l-usd"));
  t("USD cents: 8950 → $89.50 per hour (currency code case-folded)", card("l-cents").includes(">$89.50<") && card("l-cents").includes(" per hour<") && card("l-cents").includes('data-price="USD"'));
  t("JPY has no minor unit: 5000 → ¥5,000 per day (not ¥50)", card("l-jpy").includes(">¥5,000<") && card("l-jpy").includes(" per day<") && !card("l-jpy").includes("¥50<"));
  t("an unknown unit shows the price without inventing one", card("l-odd").includes(">$200<") && !/per /.test(card("l-odd")));
  t("no currency → no price text at all", !card("l-nocur").includes("data-price") && !/\$|99/.test(card("l-nocur")));
  t("no amount → no price text at all", !card("l-noprice").includes("data-price"));
  const listingUrl = `${MARKET}/l/sunny-heated-pool/${ROWS[0]!.sharetribe_listing_id}`;
  t("the link is the listing on the customer's marketplace (derived by the adapter)", card("l-usd").includes(`href="${listingUrl}"`), card("l-usd").slice(0, 200));
  t("…followed: rel=noopener, never nofollow", /<a href="[^"]+" target="_blank" rel="noopener"/.test(card("l-usd")) && !/nofollow/.test(html));
  t("a real image: src, alt, lazy, sizes, dimensions",
    /<img src="https:\/\/img\.example\/sunny\.jpg"[^>]*sizes="[^"]+"[^>]*alt="Heated pool at dusk"[^>]*width="480"[^>]*height="360"[^>]*loading="lazy"/.test(card("l-usd")), card("l-usd"));
  t("an image without alt text falls back to the listing title", /alt="Lap pool &lt;\/script&gt;/.test(card("l-cents")));
  t("an unsafe image URL is skipped for the next safe one", card("l-jpy").includes('src="https://img.example/onsen.jpg"') && !html.includes("javascript:"));
  t("the place on the card", card("l-usd").includes(">Portland, OR<") && card("l-jpy").includes(">Kyoto, JP<"));
  t("a hostile title is escaped text, not markup", !html.includes("<script>alert(1)</script>") && html.includes("&lt;/script&gt;"));
  const noUrl = renderToStaticMarkup(createElement(CityHub, dataFor("city_hub", { listings: [{ ...byId("l-usd"), url: null }] })));
  t("a listing with no URL is a card without a link", noUrl.includes('data-listing-id="l-usd"') && !noUrl.includes("/l/sunny-heated-pool/"));
}

console.log("\n   branding and the neutral fallback");
{
  const neutral = render(dataFor("city_hub", { branding: { name: "", color: null, logoUrl: null } }));
  t("no brand colour → the neutral palette", neutral.includes(`--tp-brand:${NEUTRAL_BRAND_COLOR}`) && !neutral.includes("#f97316"));
  t("no brand name → no invented one", !neutral.includes("Splash") && neutral.includes("Browse all listings on this marketplace"));
  t("a hostile colour never reaches the style attribute", sanitizeBrandColor("red;background:url(javascript:alert(1))") === null && sanitizeBrandColor("#0EA5E9") === "#0ea5e9" && sanitizeBrandColor("#abc") === "#aabbcc" && sanitizeBrandColor("rgb(0,0,0)") === null);
  t("unsafe URLs are refused", safeHttpUrl("javascript:alert(1)") === null && safeHttpUrl("data:text/html,x") === null && safeHttpUrl("/relative") === null && safeHttpUrl(" https://ok.example/x ") === "https://ok.example/x");
  const pale = brandPalette("#fde047");
  t("a pale brand gets dark text on its buttons and a readable accent", pale.onBrand === "#0f172a" && contrastRatio(pale.accent, "#ffffff") >= 4.5);
  t("a dark brand gets white text on its buttons", brandPalette("#1d4ed8").onBrand === "#ffffff");
  t("an accent that already reads well is kept", accentOnWhite("#1d4ed8") === "#1d4ed8");
  const bareLogo = render(dataFor("category_page", { branding: { name: "Splash", color: "#123456", logoUrl: null } }));
  t("no logo → the brand name as text", /<span class="text-lg font-bold[^"]*">Splash<\/span>/.test(bareLogo));
}

console.log("\n   related pages stay on the right host");
{
  t("default: /a/{slug}", HTML.city_hub.includes('href="/a/hot-tubs-portland-or"') && HTML.city_hub.includes('href="/a/pool-safety-guide"'));
  const preview = render(dataFor("city_hub"), "/s/splash");
  t("the platform preview passes /s/{ws}", preview.includes('href="/s/splash/hot-tubs-portland-or"') && !preview.includes('href="/a/'));
  const inert = render(dataFor("city_hub"), null);
  t("basePath null (an editor preview): related pages as plain text", inert.includes(">Hot tubs in Portland<") && !inert.includes('href="/a/hot-tubs') && !inert.includes("/s/"));
  t("City Hub groups same-city/region pages first", HTML.city_hub.indexOf("More around Portland") < HTML.city_hub.indexOf("More from Splash"));
  t("no link anywhere to the platform's own root", !/href="\/"/.test(preview) && !/href="\/"/.test(HTML.city_hub));
}

// ---------------------------------------------------------------------------
console.log("\n3. the head: title, description, canonical, robots, Open Graph");
const HOST = "www.splash-pools.example";
const head = (d: TemplateData, host: string | null = HOST) => buildTenantPageHead(d, { host });
const metaOf = (h: ReturnType<typeof head>, key: string) =>
  h.meta.find((m) => m.name === key || m.property === key)?.content;
const titleOf = (h: ReturnType<typeof head>) => h.meta.find((m) => m.title)?.title;
{
  const h = head(dataFor("city_hub"));
  t("<title> is the SEO title", titleOf(h) === "Private pool rentals in Portland, OR | Splash");
  t("…else the page title", titleOf(head(dataFor("city_hub", {}, { seoTitle: null }))) === "Pool rentals in Portland, OR");
  t("meta description", metaOf(h, "description") === "Rent a private pool by the hour in Portland, Oregon.");
  t("no meta description → the start of the body, not the title",
    (metaOf(head(dataFor("city_hub", {}, { metaDescription: null, intro: null })), "description") ?? "").startsWith("Portland summers are short"));
  const canonical = "https://www.splash-pools.example/a/city-hub-portland-or";
  t("canonical = https://{verified host}/a/{slug}", h.links.length === 1 && h.links[0]!.rel === "canonical" && h.links[0]!.href === canonical);
  t("og:url is the canonical", metaOf(h, "og:url") === canonical);
  t("no host → no canonical (never the platform's)", head(dataFor("city_hub"), null).links.length === 0);
  t("the canonical helper refuses junk hosts", tenantCanonicalUrl("evil.example/x?", "a") === null && tenantCanonicalUrl("localhost", "a") === null && tenantCanonicalUrl("A.Example.COM", "p") === "https://a.example.com/a/p");
  t("og:image is the page's own first listing photo", metaOf(h, "og:image") === "https://img.example/sunny.jpg" && metaOf(h, "twitter:card") === "summary_large_image");
  t("no photo → no og:image, a summary card", metaOf(head(dataFor("resource_article", { listings: [] })), "og:image") === undefined && metaOf(head(dataFor("resource_article", { listings: [] })), "twitter:card") === "summary");
  t("og:site_name is the brand", metaOf(h, "og:site_name") === "Splash");
  t("og:type: website for inventory pages, article for guides", metaOf(h, "og:type") === "website" && metaOf(head(dataFor("resource_article")), "og:type") === "article");
  t("nothing in the head names the platform", !/founders\.click/i.test(JSON.stringify(h)));
  t("an indexable page carries no robots tag", metaOf(h, "robots") === undefined);
}
console.log("\n   robots: the page's switch and the shared thin rule");
{
  const short = "A short body.";
  const long = "x".repeat(300);
  t("page.noindex → noindex, follow", metaOf(head(dataFor("city_hub", {}, { noindex: true })), "robots") === "noindex, follow");
  t("City Hub with no listings and a short body → noindex", metaOf(head(dataFor("city_hub", { listings: [] }, { bodyMarkdown: short })), "robots") === "noindex, follow");
  t("City Hub with no listings but a real body → indexable", metaOf(head(dataFor("city_hub", { listings: [] }, { bodyMarkdown: long })), "robots") === undefined);
  t("City Hub with listings and a short body → indexable (listings rescue it)", metaOf(head(dataFor("city_hub", {}, { bodyMarkdown: short })), "robots") === undefined);
  t("Resource Article: listings never rescue a short body (text only)", metaOf(head(dataFor("resource_article", {}, { bodyMarkdown: short })), "robots") === "noindex, follow");
  t("Resource Article with a real body and no listings → indexable", metaOf(head(dataFor("resource_article", { listings: [] }, { bodyMarkdown: long })), "robots") === undefined);
  t("the head and pageIsNoindex agree", pageIsNoindex(dataFor("resource_article", {}, { bodyMarkdown: short })) && !pageIsNoindex(dataFor("city_hub")));
}

// ---------------------------------------------------------------------------
console.log("\n4. structured data states only what the page shows");
const ld = (d: TemplateData) => head(d).scripts.map((s) => ({ raw: s.children, obj: JSON.parse(s.children) as Record<string, any> }));
{
  const blocks = ld(dataFor("city_hub"));
  t("every block is ld+json and parses", head(dataFor("city_hub")).scripts.every((s) => s.type === "application/ld+json") && blocks.length === 2);
  const types = blocks.map((b) => b.obj["@type"]);
  t("City Hub: BreadcrumbList + ItemList", JSON.stringify(types) === JSON.stringify(["BreadcrumbList", "ItemList"]), JSON.stringify(types));
  const crumbs = blocks[0]!.obj;
  t("the breadcrumb is the visible trail: brand home → this page",
    crumbs.itemListElement.length === 2 && crumbs.itemListElement[0].name === "Splash" && crumbs.itemListElement[0].item === `${MARKET}/` &&
      crumbs.itemListElement[1].item === "https://www.splash-pools.example/a/city-hub-portland-or");
  const list = blocks[1]!.obj;
  t("ItemList: one entry per shown listing, in order", list.numberOfItems === LISTINGS.length && list.itemListElement.length === LISTINGS.length && list.itemListElement.every((e: any, i: number) => e.position === i + 1));
  const items = list.itemListElement.map((e: any) => e.item);
  t("…each with the card's name, link and photo", items[0].name === "Sunny heated pool" && items[0].url === byId("l-usd").url && items[0].image === "https://img.example/sunny.jpg");
  t("a priced card → an Offer with price and currency", items[0]["@type"] === "Offer" && items[0].price === "125.00" && items[0].priceCurrency === "USD");
  t("…with the unit the card names", items[0].priceSpecification?.["@type"] === "UnitPriceSpecification" && items[0].priceSpecification.unitText === "night");
  t("USD cents stay exact: 8950 → 89.50", items[1].price === "89.50" && items[1].priceCurrency === "USD");
  t("JPY: 5000 → 5000 (no decimals invented)", items[2].price === "5000" && items[2].priceCurrency === "JPY");
  t("an unknown unit → an Offer without a unit", items[3]["@type"] === "Offer" && items[3].price === "200.00" && items[3].priceSpecification === undefined);
  t("no shown price (no currency / no amount) → no Offer, no price", ["Thing", "Thing"].join() === [items[4]["@type"], items[5]["@type"]].join() && !("price" in items[4]) && !("priceCurrency" in items[5]));
  const all = blocks.map((b) => b.raw).join("\n");
  t("never availability / InStock / ratings / reviews / Product", !/availability|InStock|aggregateRating|AggregateRating|"review|"Review|"Product"/.test(all), all.slice(0, 300));
  t("the stored per-listing structured_data is not emitted", !/AggregateRating|InStock/.test(JSON.stringify(dataFor("city_hub"))));
  t("a </script> in a title cannot close the element", !/<\/script/i.test(all) && all.includes("\\u003c/script>"));
  const noPrices = ld(dataFor("category_page", { listings: LISTINGS.filter((l) => !l.price) }));
  t("a page whose cards show no prices has no Offer at all", !JSON.stringify(noPrices.map((b) => b.obj)).includes('"Offer"'));
  const none = ld(dataFor("city_hub", { listings: [] }));
  t("no listings → no ItemList", none.every((b) => b.obj["@type"] !== "ItemList"));
  const noHome = ld(dataFor("city_hub", { marketplace: { homeUrl: null, browseUrl: null } }));
  t("no marketplace home → no breadcrumb claiming one", noHome.every((b) => b.obj["@type"] !== "BreadcrumbList"));
}
{
  const blocks = ld(dataFor("resource_article"));
  const article = blocks.find((b) => b.obj["@type"] === "Article")?.obj;
  t("Resource Article: an Article", !!article);
  t("…headline = the visible heading", article?.headline === "Private pool rentals in Portland");
  t("…dateModified and datePublished as shown", article?.dateModified === "2026-09-20T16:30:00.000Z" && article?.datePublished === "2026-09-01T10:00:00.000Z");
  t("…publisher = the brand (with its logo)", article?.publisher?.["@type"] === "Organization" && article?.publisher?.name === "Splash" && article?.publisher?.logo?.url === "https://cdn.splash-pools.example/logo.png");
  t("…mainEntityOfPage is the canonical", article?.mainEntityOfPage?.["@id"] === "https://www.splash-pools.example/a/resource-article-portland-or");
  t("…plus the ItemList of its strip and the breadcrumb", blocks.some((b) => b.obj["@type"] === "ItemList") && blocks.some((b) => b.obj["@type"] === "BreadcrumbList"));
  t("inventory pages carry no Article", ld(dataFor("city_hub")).every((b) => b.obj["@type"] !== "Article"));
}
{
  const p = buildPreviewHead(dataFor("city_hub"));
  t("the preview head: its own title, noindex nofollow, no canonical, no structured data",
    p.meta.some((m) => m.title === "Private pool rentals in Portland, OR | Splash — preview") &&
      p.meta.some((m) => m.name === "robots" && m.content === "noindex, nofollow") && p.links.length === 0 && p.scripts.length === 0);
  t("public pages: fresh for a minute, varied by host", PUBLIC_PAGE_HEADERS["Cache-Control"] === "public, max-age=60, s-maxage=60" && PUBLIC_PAGE_HEADERS.Vary === "Host, X-Forwarded-Host");
  t("previews: never stored", PREVIEW_PAGE_HEADERS["Cache-Control"] === "no-store" && PREVIEW_PAGE_HEADERS["X-Robots-Tag"] === "noindex, nofollow");
}

// ---------------------------------------------------------------------------
console.log("\n5. the tenant document shell");
{
  t("/a/* is a tenant surface; app paths are not", isTenantSurfacePath("/a/pool-rentals") && isTenantSurfacePath("/a") && isTenantSurfacePath("/a/x/y") && !isTenantSurfacePath("/app") && !isTenantSurfacePath("/about") && !isTenantSurfacePath("/s/ws/x") && !isTenantSurfacePath("/"));
  t("a built asset is served from the platform origin", tenantAssetHref("/assets/styles-abc.css") === "https://www.founders.click/assets/styles-abc.css");
  t("dev modules and absolute URLs are left alone", tenantAssetHref("/src/styles.css") === "/src/styles.css" && tenantAssetHref("https://cdn.example/x.css") === "https://cdn.example/x.css");
  const rh = tenantRootHead("/assets/styles-abc.css");
  const rhs = JSON.stringify(rh);
  t("the tenant root head: charset, viewport, the absolute stylesheet", rh.links.some((l) => l.rel === "stylesheet" && l.href === "https://www.founders.click/assets/styles-abc.css") && rh.meta.some((m) => m.charSet === "utf-8") && rh.meta.some((m) => m.name === "viewport"));
  t("…and none of the platform's identity", !/google-site-verification|product-demo-poster|favicon|og:|twitter:|"author"|Growth tools/.test(rhs) && !rh.meta.some((m) => m.title === "founders.click"));
  const tags = tenantHeadTags([
    { tag: "link", attrs: { rel: "modulepreload", href: "/assets/main.js" } },
    { tag: "link", attrs: { rel: "stylesheet", href: "/assets/route.css" } },
    { tag: "link", attrs: { rel: "icon", href: "/favicon.svg" } },
    { tag: "script", attrs: { type: "module", src: "/assets/entry.js" } },
    { tag: "script", attrs: { type: "application/ld+json" }, children: "{}" },
    { tag: "meta", attrs: { name: "description", content: "x" } },
  ]);
  t("head tags on a tenant page: no module preloads, scripts or icons; route CSS absolute; JSON-LD and meta kept",
    JSON.stringify(tags) === JSON.stringify([
      { tag: "link", attrs: { rel: "stylesheet", href: "https://www.founders.click/assets/route.css" } },
      { tag: "script", attrs: { type: "application/ld+json" }, children: "{}" },
      { tag: "meta", attrs: { name: "description", content: "x" } },
    ]), JSON.stringify(tags));
  const root = read("src/routes/__root.tsx");
  t("__root decides the tenant surface from the path in beforeLoad", /beforeLoad: \(\{ location \}\) => \(\{ tenantSurface: isTenantSurfacePath\(location\.pathname\) \}\)/.test(root));
  t("__root head: tenant → tenantRootHead(appCss), otherwise the platform head", /tenantSurface\s*\?[\s\S]*?tenantRootHead\(appCss\)\s*:\s*platformHead\(\)/.test(root));
  t("__root shell: tenant pages get no <Scripts /> and filtered head tags", /\{tenant \? null : <Scripts \/>\}/.test(root) && /tenant \? <TenantHeadContent \/> : <HeadContent \/>/.test(root) && /tenantHeadTags\(useTags\(\)\)/.test(root));
  t("the platform head (verification tag, favicon, poster) is unchanged for the app", /google-site-verification/.test(root) && /\{ rel: "icon", href: "\/favicon\.svg", type: "image\/svg\+xml" \}/.test(root) && /product-demo-poster/.test(root));
  t("__root 404/error on a tenant surface are white-labelled", /if \(tenant\) return <TenantStatusPage \{\.\.\.TENANT_NOT_FOUND\} \/>;/.test(root) && /if \(tenant\) \{\s*return \(\s*<TenantStatusPage/.test(root));
}

// ---------------------------------------------------------------------------
console.log("\n6. the thin rule (shared with the sitemap) and the keyed counter");
{
  t("unchanged for inventory pages and callers that pass no kind",
    isThinPageMeasured({ listingCount: 0, bodyChars: 299 }) && !isThinPageMeasured({ listingCount: 1, bodyChars: 0 }) && !isThinPageMeasured({ listingCount: 0, bodyChars: 300, kind: "city_hub" }) && !isThinPageMeasured({ listingCount: 2, bodyChars: 10, kind: "category_page" }));
  t("a Resource Article is judged on its text alone", isThinPageMeasured({ listingCount: 12, bodyChars: 299, kind: "resource_article" }) && !isThinPageMeasured({ listingCount: 0, bodyChars: 300, kind: "resource_article" }));
  t("isThinPage passes the kind through", isThinPage({ listingCount: 5, bodyMarkdown: "short", kind: "resource_article" }) && !isThinPage({ listingCount: 5, bodyMarkdown: "short", kind: "city_hub" }));
  t("isNoindexPage: the owner's switch wins", isNoindexPage({ noindex: true, listingCount: 50, bodyChars: 5000, kind: "city_hub" }) && !isNoindexPage({ noindex: false, listingCount: 50, bodyChars: 5000 }) && isNoindexPage({ noindex: null, listingCount: 0, bodyChars: 10 }));
  const keys = (city: string, state: string, country = "US", category = "pool") => {
    const k = listingKeys({ city, state, country, category });
    return { country_key: k.countryKey, region_key: k.regionKey, city_key: k.cityKey, category_key: k.categoryKey };
  };
  const counter = buildKeyedListingCounter([
    keys("Portland", "Oregon"),
    keys("Portland", "OR"),
    keys("Portland", "ME"),
    keys("Salem", "OR"),
    { country_key: null, region_key: null, city_key: null, category_key: "pool" },
  ]);
  const or = makeFilter(["country", "region", "city"], listingKeys({ city: "Portland", state: "OR", country: "US" }));
  const me = makeFilter(["country", "region", "city"], listingKeys({ city: "Portland", state: "ME", country: "US" }));
  t("keyed counter: Portland, OR is not Portland, ME", counter(or) === 2 && counter(me) === 1, `${counter(or)} / ${counter(me)}`);
  t("keyed counter: a legacy v1 filter keeps its meaning (no state = any)", counter({ city: "portland" }) === 3 && counter({ city: "Portland", state: "OR" }) === 2);
  t("keyed counter: an invalid filter matches nothing (the page shows none)", counter({ v: 2, scope: ["city"] }) === 0);
  t("keyed counter: a null key means 'has no value'", counter(makeFilter(["city"], { countryKey: null, regionKey: null, cityKey: null, categoryKey: null })) === 1);
  t("keyed counter: an empty legacy filter counts everything", counter({}) === 5 && counter(null) === 5);
  t("keyed counter: category only", counter(makeFilter(["category"], { countryKey: null, regionKey: null, cityKey: cityKeyOf("x"), categoryKey: "pool" })) === 5);
}

console.log("\n   markdown");
{
  t("a leading '# Title' is dropped", stripLeadingH1("# Title\n\nBody") === "Body" && stripLeadingH1("Body\n\n# Later") === "Body\n\n# Later" && stripLeadingH1("## Sub\n\nx") === "## Sub\n\nx");
  const md = render(dataFor("resource_article", {}, { bodyMarkdown: "Intro paragraph that is long enough.\n\n# A second top heading\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1)) and ![p](https://img.example/p.jpg)" }));
  t("a later level-1 heading renders as <h2>", /<h2[^>]*>A second top heading<\/h2>/.test(md) && count(md, /<h1[\s>]/g) === 1);
  t("raw HTML in the body is never rendered", !md.includes("<script>alert(1)</script>"));
  t("unsafe link protocols are removed", !md.includes("javascript:"));
  t("body images are lazy", /<img alt="p" loading="lazy"[^>]*src="https:\/\/img\.example\/p\.jpg"|<img[^>]*loading="lazy"[^>]*src="https:\/\/img\.example\/p\.jpg"/.test(md), md.slice(md.indexOf("<img"), md.indexOf("<img") + 200));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
