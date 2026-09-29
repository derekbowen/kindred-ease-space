/**
 * TENANT SITEMAP PAST POSTGREST'S ROW CAP, AND PAST ONE FILE. Run: bun tests/sitemap-chunking.test.ts
 *
 * Round-4 release review M4: one `.limit(50_000)` read per table came back
 * capped at PostgREST's max-rows (~1,000) and a 2,400-page tenant had 1,000
 * URLs. Every read is now keyset-paged on id (`id > last`, never an offset, so
 * a row removed mid-read cannot make another row vanish) and read to an empty
 * page (a server capping below 1,000 is still read completely). Above 50,000
 * URLs — or 50 MB — the sitemap is a <sitemapindex> of /a/sitemap.xml?page=N,
 * cut in a stable order so editing a page never moves a URL between files.
 *
 * The real generator through the real supabase-js client against a fake
 * PostgREST that caps EVERY response (tests/_support/fake-postgrest.ts). Offline.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakePostgrest, coverageGroupsOf, harness, type Row } from "./_support/fake-postgrest-sitemap";

const ORIGIN = "http://sitemap-chunk.test";
process.env.SUPABASE_URL = ORIGIN;
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
const fake = new FakePostgrest(ORIGIN);
fake.install();

const sm = await import("../src/lib/sitemap.server");
const { makeFilter } = await import("../src/lib/coverage/target");
const { t, done } = harness();
const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const WS = "11111111-1111-4111-8111-111111111111";
const HOST = "www.pools.example";
const T_CAT = "7e000000-0000-4000-8000-000000000002";
const pad = (n: number, w = 6) => String(n).padStart(w, "0");
const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${pad(n, 12)}`;
const hour = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 3_600_000).toISOString();
const pool = makeFilter(["category"], { countryKey: null, regionKey: null, cityKey: null, categoryKey: "pool" });

/** `tenant` category pages (published in slug order) and `legacy` content pages. */
function seed(tenant: number, legacy: number, slugOf: (i: number) => string = (i) => `page-${pad(i)}`) {
  fake.set("workspace_domains", [
    { id: "d1", workspace_id: WS, hostname: HOST, verified: true, verified_at: "2026-09-01T00:00:00Z", status: "active" },
  ]);
  fake.set("workspaces", [
    { id: WS, marketplace_domain: HOST, domain_verified_at: "2026-09-01T00:00:00Z", subscription_status: "active", current_period_end: "2099-01-01T00:00:00Z" },
  ]);
  fake.set("page_templates", [{ id: T_CAT, slug: "category_page", is_active: true }]);
  // ids deliberately NOT in publication order, so the id-ordered reads and the
  // publication-ordered sitemap are different orders.
  fake.set(
    "tenant_pages",
    Array.from({ length: tenant }, (_, i) => ({
      id: uuid("a0000000", (i * 7919) % Math.max(tenant, 1)),
      workspace_id: WS,
      template_id: T_CAT,
      slug: slugOf(i),
      status: "published",
      noindex: false,
      listing_filter: pool,
      published_at: hour(i),
      created_at: hour(i),
      updated_at: hour(i),
    })),
  );
  fake.set(
    "content_pages",
    Array.from({ length: legacy }, (_, i) => ({
      id: uuid("b0000000", (i * 104729) % Math.max(legacy, 1)),
      workspace_id: WS,
      slug: `legacy-${pad(i)}`,
      url_path: `/p/legacy-${pad(i)}`,
      status: "published",
      in_sitemap: true,
      redirect_to: null,
      body_markdown: "x".repeat(400),
      created_at: hour(-100_000 + i),
      updated_at: hour(-100_000 + i),
    })),
  );
  fake.set("tenant_listings", [
    { id: uuid("c0000000", 1), workspace_id: WS, state_published: true, category: "pool", category_key: "pool" },
  ]);
  fake.rpcs = {
    workspace_granted_pages: () => 0,
    inventory_coverage_groups: (args) => coverageGroupsOf(fake.rows("tenant_listings"), String(args._workspace_id)),
  };
  fake.failWhen = null;
  fake.maxRows = 1000;
}

const get = (query = "", limits?: import("../src/lib/sitemap.server").SitemapLimits) =>
  sm.tenantSitemapResponse(HOST, `https://www.founders.click/a/sitemap.xml${query}`, limits ? { limits } : {});
const locs = (xml: string) => [...xml.matchAll(/<url><loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
const pageReads = () =>
  fake.hits.filter((h) => h.name === "tenant_pages" && h.params.get("status") === "eq.published" && !h.params.has("template_id"));

// ---------------------------------------------------------------------------
console.log("\na tenant past 1,000 pages gets all of them");
seed(2400, 1500);
fake.clearHits();
{
  const res = await get();
  const listed = locs(res.body);
  t("200 and a <urlset> (under 50,000 URLs)", res.status === 200 && res.body.includes("<urlset") && !res.body.includes("<sitemapindex"));
  t("all 2,400 tenant pages are listed (was capped at 1,000)", listed.filter((l) => /\/a\/page-/.test(l)).length === 2400, String(listed.filter((l) => /\/a\/page-/.test(l)).length));
  t("all 1,500 legacy pages are listed", listed.filter((l) => /\/a\/legacy-/.test(l)).length === 1500);
  t("no URL twice", new Set(listed).size === listed.length);
  t("URLs are on the requested host, www kept", listed.every((l) => l.startsWith(`https://${HOST}/a/`)));
  t("legacy pages (created earlier) come first, then pages in publication order",
    listed[0] === `https://${HOST}/a/legacy-000000` && listed[1500] === `https://${HOST}/a/page-000000` && listed[listed.length - 1] === `https://${HOST}/a/page-002399`);
  const reads = pageReads();
  t("tenant_pages: 3 full pages, a short one… then an empty page ends the read (4 reads)", reads.length === 4, String(reads.length));
  t("keyset, not offsets: no read carries an offset", reads.every((h) => !h.params.has("offset")));
  t("every read is ordered by id with a 1,000-row limit", reads.every((h) => h.params.get("order") === "id.asc" && h.params.get("limit") === "1000"));
  t("the first read has no cursor; each later one starts after the last id seen", !reads[0]!.params.has("id") && reads.slice(1).every((h) => /^gt\.[0-9a-f-]{36}$/.test(h.params.get("id") ?? "")));
  t("every page read keeps the workspace and published filters", reads.every((h) => h.params.get("workspace_id") === `eq.${WS}`));
  t("content_pages published: 2 pages of 1,000/500, then empty (3 reads)", fake.hits.filter((h) => h.name === "content_pages" && h.params.get("status") === "eq.published").length === 3);
}

console.log("\na server that caps below the page size is still read completely");
{
  seed(2400, 0);
  fake.maxRows = 500;
  fake.clearHits();
  const res = await get();
  t("every page is listed with a 500-row cap", locs(res.body).length === 2400, String(locs(res.body).length));
  t("…because a short page is not taken as the end (read until empty)", pageReads().length === 6, String(pageReads().length));
  fake.maxRows = 1000;
}

console.log("\na row removed mid-read cannot make another row vanish");
{
  seed(2400, 0);
  let n = 0;
  fake.failWhen = (h) => {
    if (h.name === "tenant_pages" && h.params.get("status") === "eq.published" && !h.params.has("template_id") && ++n === 2) {
      // Between page 1 and page 2: unpublish a page that page 1 already returned.
      const first = [...fake.rows("tenant_pages")].sort((a, b) => String(a.id).localeCompare(String(b.id)))[10]!;
      fake.update("tenant_pages", (p) => p.id === first.id, { status: "draft" });
    }
    return null;
  };
  const res = await get();
  fake.failWhen = null;
  const listed = new Set(locs(res.body));
  const byId = [...fake.rows("tenant_pages")].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const boundary = byId[1000]!; // the row an offset read (offset=1000) would have skipped
  t("the row right after the first page is still listed (an offset read would have skipped it)", listed.has(`https://${HOST}/a/${boundary.slug}`));
  t("every page is accounted for", listed.size === 2400, String(listed.size));
}

// ---------------------------------------------------------------------------
console.log("\nabove 50,000 URLs: a sitemap index of /a/sitemap.xml?page=N");
seed(60_001, 0);
{
  fake.clearHits();
  const index = await get();
  const children = [...index.body.matchAll(/<sitemap><loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod><\/sitemap>/g)];
  t("the main document is a <sitemapindex>", index.status === 200 && index.body.includes(`<sitemapindex xmlns="${sm.SITEMAP_NS}">`));
  t("two parts, under /a/ on the requested host", children.length === 2 &&
    children[0]![1] === `https://${HOST}/a/sitemap.xml?page=1` && children[1]![1] === `https://${HOST}/a/sitemap.xml?page=2`,
    children.map((c) => c[1]).join(", "));
  t("60,001 pages took 62 keyset reads (61 pages + the empty end), still one aggregation", pageReads().length === 62 && fake.count("inventory_coverage_groups") === 1, `${pageReads().length} / ${fake.count("inventory_coverage_groups")}`);
  const p1 = await get("?page=1");
  const p2 = await get("?page=2");
  const l1 = locs(p1.body);
  const l2 = locs(p2.body);
  t("part 1 holds exactly 50,000 URLs", l1.length === 50_000, String(l1.length));
  t("part 2 holds the rest (10,001)", l2.length === 10_001, String(l2.length));
  const s1 = new Set(l1);
  t("the parts never share a URL, and together list every page", !l2.some((l) => s1.has(l)) && new Set([...l1, ...l2]).size === 60_001);
  t("part 1 is the first 50,000 by publication", l1[0] === `https://${HOST}/a/page-000000` && l1[49_999] === `https://${HOST}/a/page-049999`);
  t("each part's lastmod in the index is its newest URL's", children[0]![2] === hour(49_999).replace(/\.\d{3}Z$/, "Z") && children[1]![2] === hour(60_000).replace(/\.\d{3}Z$/, "Z"), `${children[0]![2]} ${children[1]![2]}`);
  t("each part carries the cache headers", p1.headers["Cache-Control"] === "public, max-age=300, s-maxage=300" && p2.headers.Vary === "Host, X-Forwarded-Host");

  // Shard membership is stable: editing never moves a URL; publishing appends.
  fake.update("tenant_pages", (p) => p.slug === "page-000123" || p.slug === "page-055555", { updated_at: "2026-09-27T12:00:00Z" });
  const e1 = locs((await get("?page=1")).body);
  const e2 = locs((await get("?page=2")).body);
  t("editing pages (new updated_at) moves no URL between parts", JSON.stringify(e1) === JSON.stringify(l1) && JSON.stringify(e2) === JSON.stringify(l2));
  t("…while the edited page's lastmod changes", (await get("?page=1")).body.includes(`<loc>https://${HOST}/a/page-000123</loc><lastmod>2026-09-27T12:00:00Z</lastmod>`));
  fake.set("tenant_pages", [
    ...fake.rows("tenant_pages"),
    { id: "00000000-0000-4000-8000-000000000000", workspace_id: WS, template_id: T_CAT, slug: "brand-new", status: "published", noindex: false, listing_filter: pool, published_at: "2040-01-01T00:00:00Z", created_at: "2040-01-01T00:00:00Z", updated_at: "2040-01-01T00:00:00Z" },
  ]);
  const n1 = locs((await get("?page=1")).body);
  const n2 = locs((await get("?page=2")).body);
  t("publishing a page (lowest id of all!) appends it to the last part; part 1 is untouched", JSON.stringify(n1) === JSON.stringify(l1) && n2[n2.length - 1] === `https://${HOST}/a/brand-new` && n2.length === 10_002);

  for (const bad of ["?page=0", "?page=-1", "?page=abc", "?page=1e3", "?page=01", "?page=10000", "?page=", "?page=3", "?page=9999"]) {
    const res = await get(bad);
    t(`${bad} → 404`, res.status === 404 && res.headers["Cache-Control"] === "no-store", String(res.status));
  }
}

console.log("\none file's worth: ?page=1 is that file, ?page=2 does not exist");
{
  seed(3, 0);
  const whole = await get();
  const one = await get("?page=1");
  const two = await get("?page=2");
  t("no page → the <urlset>", whole.status === 200 && whole.body.includes("<urlset") && locs(whole.body).length === 3);
  t("?page=1 → the same <urlset>", one.status === 200 && one.body === whole.body);
  t("?page=2 → 404", two.status === 404);
}

// ---------------------------------------------------------------------------
console.log("\nthe byte limit: long slugs split files before 50 MB (scaled down)");
{
  const longSlug = (i: number) => `${"long-slug-".repeat(20).slice(0, 194)}${pad(i)}`;
  seed(60, 0, longSlug);
  const limits = { maxUrls: 50_000, maxBytes: 4096 };
  const index = await get("", limits);
  const parts = [...index.body.matchAll(/<sitemap><loc>[^<]*\?page=(\d+)<\/loc>/g)].length;
  t("slugs are the longest the page route serves (200 characters)", longSlug(1).length === 200);
  t("60 long URLs over a 4,096-byte limit need several files (an index)", index.body.includes("<sitemapindex") && parts > 1, String(parts));
  const all: string[] = [];
  let within = true;
  for (let k = 1; k <= parts; k++) {
    const res = await get(`?page=${k}`, limits);
    if (sm.utf8Length(res.body) > limits.maxBytes) within = false;
    all.push(...locs(res.body));
  }
  t("every file is within the byte limit (bytes, not characters)", within);
  t("together they list every page once, in order", all.length === 60 && new Set(all).size === 60 && all[0]!.endsWith(longSlug(0)) && all[59]!.endsWith(longSlug(59)));
  const past = await get(`?page=${parts + 1}`, limits);
  t("the part after the last is 404", past.status === 404);
}
{
  // With the real limits the URL count binds first: 50,000 of the longest
  // possible URLs (253-character host, 200-character slug, lastmod) are
  // nowhere near 50 MB — and the byte limit is still enforced independently.
  const host = `${"h".repeat(60)}.${"o".repeat(60)}.${"s".repeat(60)}.${"t".repeat(66)}.example`.slice(0, 253);
  const entry = sm.urlEntryXml({ loc: sm.sitemapLoc(host, "z".repeat(200)), lastmod: "2026-09-28T12:34:56Z" });
  const perUrl = sm.utf8Length(entry);
  t("a maximal URL entry is under 600 bytes", perUrl < 600, String(perUrl));
  t("50,000 of them are under 50 MB, so the 50,000-URL limit binds first", perUrl * 50_000 + 200 < sm.SITEMAP_MAX_BYTES);
  const shards = sm.planShards(new Array(120_000).fill(perUrl));
  t("120,000 maximal URLs cut into 50,000 / 50,000 / 20,000", JSON.stringify(shards.map((s) => s.end - s.start)) === "[50000,50000,20000]");
  const byBytes = sm.planShards(new Array(10).fill(10 * 1024 * 1024));
  t("ten 10 MB entries (hypothetical) cut at 50 MB: 4 per file", JSON.stringify(byBytes.map((s) => s.end - s.start)) === "[4,4,2]" && byBytes.every((s) => s.bytes <= sm.SITEMAP_MAX_BYTES));
  t("the limits are the protocol's: 50,000 URLs and 50 MB (52,428,800 bytes)", sm.SITEMAP_MAX_URLS === 50_000 && sm.SITEMAP_MAX_BYTES === 52_428_800);
}

console.log("\nthe page parameter");
{
  const q = (s: string) => sm.sitemapPageParam(`https://h/a/sitemap.xml${s}`);
  t("no page → undefined (index or the whole urlset)", q("") === undefined);
  t("?page=2 → 2", q("?page=2") === 2);
  for (const bad of ["?page=0", "?page=-1", "?page=abc", "?page=1e3", "?page=01", "?page=10000", "?page="]) {
    t(`${bad} → null (404)`, q(bad) === null);
  }
}

console.log("\nthe routes serve the one generator");
{
  const aRoute = read("src/routes/a.sitemap[.]xml.tsx");
  t("/a/sitemap.xml answers exactly what tenantSitemapResponse decides (status, body, headers)",
    /const r = await tenantSitemapResponse\(host, request\.url\);\s*return new Response\(r\.body, \{ status: r\.status, headers: r\.headers \}\);/.test(aRoute));
  t("…for the forwarded host, else the Host header", /request\.headers\.get\("x-forwarded-host"\) \|\| request\.headers\.get\("host"\)/.test(aRoute));
  const byHost = read("src/routes/api/public/sitemap-by-host.ts");
  t("/api/public/sitemap-by-host answers the same way for ?hostname=",
    /const r = await tenantSitemapResponse\(parsed\.data\.hostname, request\.url\);\s*return new Response\(r\.body, \{ status: r\.status, headers: r\.headers \}\);/.test(byHost));
  t("…still rate limited and validated", /rateLimit\("sitemap-by-host"/.test(byHost) && /hostname required/.test(byHost));
  const root = read("src/routes/sitemap[.]xml.tsx");
  t("/sitemap.xml never serves a tenant sitemap (the customer's own /sitemap.xml stays theirs)", !/tenantSitemap/.test(root));
  t("/sitemap.xml serves the platform sitemap only on the platform hosts, else 404", /if \(!servesPlatformSitemap\(host\)\) \{\s*return new Response\("not found", \{\s*status: 404/.test(root));
  t("/sitemap.xml varies by host too", /Vary: SITEMAP_VARY/.test(root));
  const src = read("src/lib/sitemap.server.ts");
  t("no read trusts a .limit() the API would cap, or an offset", !/\.limit\(50_000\)/.test(src) && !/\.range\(from, to\)/.test(src));
  t("the old chunked-offset reader is gone", !/export async function readInChunks/.test(src));
}

done();
