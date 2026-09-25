/**
 * TENANT SITEMAP PAST POSTGREST'S ROW CAP. Run: bun tests/sitemap-chunking.test.ts
 *
 * Round-4 release review M4. tenantSitemapXml read tenant_pages and
 * content_pages with one `.limit(50_000)` read each; PostgREST's max-rows
 * (~1,000 by default) caps a response silently, so a Pro tenant with 2,400
 * published pages had 1,000 in /a/sitemap.xml. Both reads now come in
 * 1,000-row chunks over a fixed order (id), and above 50,000 URLs the sitemap
 * is a <sitemapindex> of /a/sitemap.xml?page=N.
 *
 * The real tenantSitemapXml runs against a fake PostgREST that caps EVERY
 * response at 1,000 rows (whatever the request asked for), honours
 * offset/limit, order and the filters, and reports an exact Content-Range
 * count. Offline.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.SUPABASE_URL = "http://sitemap-chunk.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";

const sm = await import("../src/lib/sitemap.server");
const { THIN_PAGE_MIN_BODY_CHARS } = await import("../src/lib/thin-page");

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

// ---------------------------------------------------------------------------
// The fake PostgREST.
const MAX_ROWS = 1000;
const WS = "11111111-1111-4111-8111-111111111111";
const HOST = "www.pools.example";
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
type Hit = { table: string; query: URLSearchParams };
const hits: Hit[] = [];
let failOn: ((table: string, offset: number) => boolean) | null = null;

function matches(row: Row, col: string, expr: string): boolean {
  const cell = row[col];
  if (expr === "is.null") return cell === null || cell === undefined;
  if (expr === "not.is.null") return cell !== null && cell !== undefined;
  if (expr.startsWith("eq.")) return String(cell) === expr.slice(3);
  throw new Error(`fake PostgREST: unsupported filter ${col}=${expr}`);
}
const RESERVED = new Set(["select", "order", "limit", "offset"]);

// One scan (the same table and filters, every offset) is filtered once and
// then sliced, so 60,000-row scenarios stay fast.
const scanCache = new Map<string, Row[]>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  if (url.origin !== process.env.SUPABASE_URL) throw new TypeError(`unexpected host ${url.host}`);
  const path = url.pathname.replace(/^\/rest\/v1\//, "");
  const headers = new Headers(init?.headers);
  if (path === "rpc/workspace_granted_pages") return Response.json(0);
  hits.push({ table: path, query: url.searchParams });
  const all = tables[path];
  if (!all) return Response.json({ code: "42P01", message: `no table ${path}` }, { status: 404 });
  const scanKey = new URLSearchParams(
    [...url.searchParams].filter(([k]) => k !== "offset" && k !== "limit"),
  );
  const key = `${path}?${scanKey}`;
  let rows = scanCache.get(key);
  if (!rows) {
    const preds = [...url.searchParams]
      .filter(([k]) => !RESERVED.has(k))
      .map(
        ([k, v]) =>
          (r: Row) =>
            matches(r, k, v),
      );
    rows = all.filter((r) => preds.every((p) => p(r)));
    const order = url.searchParams.get("order");
    if (order) {
      const [col, dir] = order.split(",")[0]!.split(".");
      rows.sort((a, b) => {
        const x = String(a[col!]);
        const y = String(b[col!]);
        return (x < y ? -1 : x > y ? 1 : 0) * (dir === "desc" ? -1 : 1);
      });
    }
    scanCache.set(key, rows);
  }
  const total = rows.length;
  const offset = Number(url.searchParams.get("offset") ?? 0);
  if (failOn?.(path, offset))
    return Response.json({ code: "57014", message: "statement timeout" }, { status: 500 });
  const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : Infinity;
  // max-rows: never more than 1,000 rows in one response, whatever was asked.
  const page = rows.slice(offset, offset + Math.min(limit, MAX_ROWS));
  const accept = headers.get("accept") ?? "";
  const h: Record<string, string> = { "content-type": "application/json" };
  if ((headers.get("prefer") ?? "").includes("count=exact"))
    h["content-range"] = page.length
      ? `${offset}-${offset + page.length - 1}/${total}`
      : `*/${total}`;
  if (accept.includes("vnd.pgrst.object")) {
    return page.length === 1
      ? new Response(JSON.stringify(page[0]), { headers: h })
      : Response.json({ code: "PGRST116" }, { status: 406 });
  }
  return new Response(JSON.stringify(page), { headers: h });
}) as typeof fetch;

// ---------------------------------------------------------------------------
// A Pro tenant: 2,400 published pages, 1,500 legacy pages, 3,000 listings.
const LONG = "x".repeat(THIN_PAGE_MIN_BODY_CHARS + 50);
const SHORT = "too short";
const pad = (n: number, w = 6) => String(n).padStart(w, "0");
const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${pad(n, 12)}`;
const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 3_600_000).toISOString();

function seed(tenantCount: number, legacyCount: number, listingCount: number, longBody = LONG) {
  scanCache.clear();
  tables.workspace_domains = [
    {
      workspace_id: WS,
      verified_at: "2026-09-01T00:00:00Z",
      hostname: "pools.example",
      verified: true,
    },
  ];
  tables.workspaces = [
    {
      id: WS,
      marketplace_domain: null,
      domain_verified_at: null,
      subscription_status: "active",
      trial_ends_at: null,
      current_period_end: "2099-01-01T00:00:00Z",
    },
  ];
  // ids deliberately NOT in updated_at order, so a chunked read over id and
  // the newest-first output are different orders.
  tables.tenant_pages = Array.from({ length: tenantCount }, (_, i) => ({
    id: uuid("a0000000", (i * 7919) % tenantCount),
    workspace_id: WS,
    status: "published",
    slug: `page-${pad(i)}`,
    updated_at: day(i),
    // Every 100th page matches no listing and has a short body: thin.
    listing_filter: i % 100 === 0 ? { city: "Nowhere" } : { city: `City ${i % 50}` },
    body_markdown: i % 100 === 0 ? SHORT : i % 2 ? longBody : "",
  }));
  // Drafts and another workspace's pages must never appear.
  tables.tenant_pages.push(
    {
      id: uuid("a1000000", 1),
      workspace_id: WS,
      status: "draft",
      slug: "draft-page",
      updated_at: day(1),
      listing_filter: {},
      body_markdown: LONG,
    },
    {
      id: uuid("a1000000", 2),
      workspace_id: "other-ws",
      status: "published",
      slug: "not-ours",
      updated_at: day(1),
      listing_filter: {},
      body_markdown: LONG,
    },
  );
  tables.content_pages = Array.from({ length: legacyCount }, (_, i) => ({
    id: uuid("b0000000", (i * 104729) % legacyCount),
    workspace_id: WS,
    status: "published",
    in_sitemap: true,
    // Legacy pages have no listings: only the body decides. Every 10th is thin.
    slug:
      i === 0 ? "page-000001" /* a tenant page's slug: the tenant page wins */ : `legacy-${pad(i)}`,
    updated_at: day(i),
    body_markdown: i % 10 === 5 ? SHORT : LONG,
  }));
  tables.content_pages.push({
    id: uuid("b1000000", 1),
    workspace_id: WS,
    status: "published",
    in_sitemap: false,
    slug: "hidden",
    updated_at: day(1),
    body_markdown: LONG,
  });
  tables.tenant_listings = Array.from({ length: listingCount }, (_, i) => ({
    id: uuid("c0000000", i),
    workspace_id: WS,
    state_published: true,
    city: `City ${i % 50}`,
    state: null,
    category: null,
  }));
}

function locs(xml: string): string[] {
  return [...xml.matchAll(/<url><loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
}

// ---------------------------------------------------------------------------
console.log("\na tenant past 1,000 pages gets all of them");

seed(2400, 1500, 3000);
hits.length = 0;
const xml = (await sm.tenantSitemapXml(HOST))!;
const listed = locs(xml);
const expectTenant = 2400 - 24; // every 100th is thin
const expectLegacy = 1500 - 150 - 1; // every 10th is thin; one shares a tenant slug
t(
  "it is a <urlset> (under 50,000 URLs)",
  xml.includes("<urlset") && !xml.includes("<sitemapindex"),
);
t(
  `all ${expectTenant} non-thin tenant pages are listed (was capped at 1,000)`,
  listed.filter((l) => /\/a\/page-/.test(l)).length === expectTenant,
  String(listed.filter((l) => /\/a\/page-/.test(l)).length),
);
t(
  `all ${expectLegacy} non-thin legacy pages are listed`,
  listed.filter((l) => /\/a\/legacy-/.test(l)).length === expectLegacy,
  String(listed.filter((l) => /\/a\/legacy-/.test(l)).length),
);
t("no URL is listed twice", new Set(listed).size === listed.length);
t(
  "drafts, other workspaces' pages and in_sitemap=false pages stay out",
  !listed.some((l) => /draft-page|not-ours|hidden/.test(l)),
);
t(
  "URLs are on the requested host (www kept)",
  listed.every((l) => l.startsWith(`https://${HOST}/a/`)),
);
t(
  "thin pages (no listings, short body) stay out; a long body or a listing keeps a page in",
  !listed.includes(`https://${HOST}/a/page-000000`) &&
    !listed.includes(`https://${HOST}/a/page-000100`) &&
    listed.includes(`https://${HOST}/a/page-000002`) /* empty body, has listings */ &&
    listed.includes(`https://${HOST}/a/page-000001`),
);
t(
  "a legacy twin of a tenant slug yields to the tenant page",
  listed.filter((l) => l.endsWith("/a/page-000001")).length === 1,
);
const tenantOrder = listed.filter((l) => /\/a\/page-/.test(l));
t(
  "newest first within the tenant pages, as before",
  tenantOrder[0] === `https://${HOST}/a/page-002399` &&
    tenantOrder[tenantOrder.length - 1] === `https://${HOST}/a/page-000001`,
  `${tenantOrder[0]} … ${tenantOrder[tenantOrder.length - 1]}`,
);
t(
  "tenant pages come before legacy pages",
  listed.findIndex((l) => /\/a\/legacy-/.test(l)) >
    listed.findLastIndex((l) => /\/a\/page-/.test(l)),
);

console.log("\n…read in 1,000-row chunks over a fixed order");
const pageReads = hits.filter((h) => h.table === "tenant_pages");
const legacyReads = hits.filter((h) => h.table === "content_pages");
t("tenant_pages: 3 chunks for 2,400 rows", pageReads.length === 3, String(pageReads.length));
t("content_pages: 2 chunks for 1,500 rows", legacyReads.length === 2, String(legacyReads.length));
t(
  "offsets 0 / 1000 / 2000 — no overlap, no gap",
  JSON.stringify(pageReads.map((h) => h.query.get("offset"))) ===
    JSON.stringify(["0", "1000", "2000"]),
  JSON.stringify(pageReads.map((h) => h.query.get("offset"))),
);
t(
  "every page read is ordered by id",
  [...pageReads, ...legacyReads].every((h) => h.query.get("order") === "id.asc"),
);
t(
  "every page read keeps the workspace and published filters",
  [...pageReads, ...legacyReads].every(
    (h) => h.query.get("workspace_id") === `eq.${WS}` && h.query.get("status") === "eq.published",
  ) && legacyReads.every((h) => h.query.get("in_sitemap") === "eq.true"),
);
t(
  "the listings are chunked too (3,000 rows → 3 reads)",
  hits.filter((h) => h.table === "tenant_listings").length === 3,
);

console.log("\na failed chunk lists what was read and says so (never a blank sitemap)");
failOn = (table, offset) => table === "tenant_pages" && offset === 1000;
const errors: string[] = [];
const origError = console.error;
console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
const partial = locs((await sm.tenantSitemapXml(HOST))!);
console.error = origError;
failOn = null;
t(
  "the first 1,000 tenant rows are still listed (minus thin)",
  partial.filter((l) => /\/a\/page-/.test(l)).length > 900,
);
t(
  "…and the incomplete read is logged",
  errors.some((e) => /tenant_pages read incomplete/.test(e)),
  errors.join(" | "),
);

// ---------------------------------------------------------------------------
console.log("\nabove 50,000 URLs: a sitemap index of /a/sitemap.xml?page=N");

// Every non-thin page has listings here, so its body does not matter: keep them empty.
seed(60_001, 0, 50, "");
hits.length = 0;
const index = (await sm.tenantSitemapXml(HOST))!;
const indexReads = hits.filter((h) => h.table === "tenant_pages").length;
const children = [
  ...index.matchAll(/<sitemap><loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod><\/sitemap>/g),
];
// 60,001 pages; every 100th is thin → 60,001 - 601 = 59,400 URLs.
t(
  "the document is a <sitemapindex>",
  index.includes('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'),
);
t(
  "two children, under /a/ on the requested host",
  children.length === 2 &&
    children[0]![1] === `https://${HOST}/a/sitemap.xml?page=1` &&
    children[1]![1] === `https://${HOST}/a/sitemap.xml?page=2`,
  children.map((c) => c[1]).join(", "),
);
const p1 = locs((await sm.tenantSitemapXml(HOST, { page: 1 }))!);
const p2 = locs((await sm.tenantSitemapXml(HOST, { page: 2 }))!);
const p3xml = (await sm.tenantSitemapXml(HOST, { page: 3 }))!;
t("page 1 holds exactly 50,000 URLs", p1.length === 50_000, String(p1.length));
t("page 2 holds the rest (9,400)", p2.length === 9_400, String(p2.length));
const p1Set = new Set(p1);
t("the two pages never share a URL", !p2.some((l) => p1Set.has(l)));
t(
  "a page past the end is a valid, empty <urlset>",
  p3xml.includes("<urlset") && locs(p3xml).length === 0,
);
// Page 60,000 is thin (every 100th), so the newest listed is 59,999.
t("child 1's lastmod is the newest URL in it", children[0]![2] === day(59_999), children[0]![2]);
t(
  "60,001 rows took 61 chunk reads of tenant_pages (within PAGE_MAX_CHUNKS)",
  indexReads === 61 && sm.PAGE_MAX_CHUNKS >= 61,
  String(indexReads),
);

console.log("\nsitemapDocument and the page parameter");
const e = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ loc: `https://h/a/p${i}`, lastmod: day(i) }));
t("≤ max → one urlset", sm.sitemapDocument(e(3), { host: "h", maxUrls: 3 }).includes("<urlset"));
t(
  "> max → index with ceil(n/max) children",
  (sm.sitemapDocument(e(7), { host: "h", maxUrls: 3 }).match(/<sitemap>/g) ?? []).length === 3,
);
t(
  "page k is the k-th slice",
  locs(sm.sitemapDocument(e(7), { host: "h", maxUrls: 3, page: 3 })).join() === "https://h/a/p6",
);
t("the protocol limit is 50,000", sm.SITEMAP_MAX_URLS === 50_000);
const q = (s: string) => sm.sitemapPageParam(`https://h/a/sitemap.xml${s}`);
t("no page → undefined (index or the whole urlset)", q("") === undefined);
t("?page=2 → 2", q("?page=2") === 2);
for (const bad of [
  "?page=0",
  "?page=-1",
  "?page=abc",
  "?page=1e3",
  "?page=01",
  "?page=10000",
  "?page=",
])
  t(`${bad} → null (404)`, q(bad) === null);

console.log("\nthe routes serve the pages");
const aRoute = read("src/routes/a.sitemap[.]xml.tsx");
t(
  "/a/sitemap.xml passes ?page through, and 404s a bad one",
  /const page = sitemapPageParam\(request\.url\);\s*if \(page === null\) return new Response\("not found", \{ status: 404 \}\);\s*const tenant = await tenantSitemapXml\(host, \{ page \}\);/.test(
    aRoute,
  ),
);
t(
  "/sitemap.xml passes it on tenant hosts",
  /tenantSitemapXml\(host, \{ page: page \?\? undefined \}\)/.test(
    read("src/routes/sitemap[.]xml.tsx"),
  ),
);
t(
  "/api/public/sitemap-by-host passes it",
  /tenantSitemapXml\(parsed\.data\.hostname, \{ page \}\)/.test(
    read("src/routes/api/public/sitemap-by-host.ts"),
  ),
);
const src = read("src/lib/sitemap.server.ts");
t("no page read still trusts a .limit() the API would cap", !/\.limit\(50_000\)/.test(src));
t(
  "bodies are measured and dropped as each chunk arrives (the kept row has no body)",
  /function toSitemapPage\(row: any, legacy: boolean\): SitemapPage \{[\s\S]*?body_chars: thinPageBodyChars\(row\.body_markdown\),[\s\S]*?\n\}/.test(
    src,
  ) &&
    !/body_markdown:/.test(
      src.slice(src.indexOf("type SitemapPage = {"), src.indexOf("function toSitemapPage")),
    ),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
