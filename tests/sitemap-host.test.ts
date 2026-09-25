/**
 * Sitemap host handling.
 *
 * The bug this locks down: `www.` was stripped for workspace LOOKUP and the
 * stripped value was then used to BUILD sitemap <loc> URLs. a.$slug.tsx
 * canonicalizes to the host actually requested, so the sitemap advertised
 * https://customer.com/a/x while the page declared https://www.customer.com/a/x
 * canonical — and a customer who connected only `www` has no apex route, so
 * every URL in their sitemap failed to resolve.
 *
 * Run: bun tests/sitemap-host.test.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  requestHost,
  normalizeHost,
  isPlatformHost,
  escapeXml,
  preferredHostMatch,
  readInChunks,
  LISTING_CHUNK_SIZE,
  LISTING_MAX_CHUNKS,
  type HostMatch,
} from "../src/lib/sitemap.server";
import { isThinPage, isThinPageMeasured, thinPageBodyChars, buildListingCounter, THIN_PAGE_MIN_BODY_CHARS } from "../src/lib/thin-page";
import { isPublicPageSlug, PUBLIC_PAGE_SLUG_RE } from "../src/lib/public-page-slug";
import {
  isPublicPageSlug as pageRouteIsPublicPageSlug,
  PUBLIC_PAGE_SLUG_RE as PAGE_ROUTE_PUBLIC_PAGE_SLUG_RE,
} from "../src/lib/public-tenant-page.functions";

let pass = 0, fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL  ${name}  ${extra}`); }
}

console.log("\n=== requestHost preserves what the visitor asked for ===");
t("www is PRESERVED for URL building",
  requestHost("www.customer.com") === "www.customer.com", requestHost("www.customer.com"));
t("apex stays apex", requestHost("customer.com") === "customer.com");
t("scheme stripped", requestHost("https://www.customer.com") === "www.customer.com");
t("port stripped", requestHost("www.customer.com:8443") === "www.customer.com");
t("path stripped", requestHost("www.customer.com/a/x") === "www.customer.com");
t("case folded", requestHost("WWW.Customer.COM") === "www.customer.com");
t("x-forwarded-host list takes the first entry",
  requestHost("www.customer.com, edge.internal") === "www.customer.com");
t("empty input is empty", requestHost("") === "");

console.log("\n=== normalizeHost is the LOOKUP key only ===");
t("www stripped for lookup", normalizeHost("www.customer.com") === "customer.com");
t("apex and www share one lookup key",
  normalizeHost("www.customer.com") === normalizeHost("customer.com"));
t("only a LEADING www is stripped",
  normalizeHost("www.www-hosting.com") === "www-hosting.com",
  normalizeHost("www.www-hosting.com"));
t("a host merely containing www is untouched",
  normalizeHost("mywww.customer.com") === "mywww.customer.com");

console.log("\n=== the two must not be the same function ===");
{
  // This is the actual regression. If these ever collapse back into one, the
  // sitemap starts emitting URLs the page does not canonicalize to.
  t("requestHost and normalizeHost DIFFER on a www host",
    requestHost("www.customer.com") !== normalizeHost("www.customer.com"));
  t("they agree on an apex host",
    requestHost("customer.com") === normalizeHost("customer.com"));
}

console.log("\n=== platform hosts never serve a tenant sitemap ===");
t("apex platform host detected", isPlatformHost("founders.click"));
t("www platform host detected", isPlatformHost("www.founders.click"));
t("platform host with port detected", isPlatformHost("www.founders.click:443"));
t("a customer domain is not a platform host", !isPlatformHost("www.customer.com"));

console.log("\n=== XML escaping ===");
t("ampersand escaped", escapeXml("a&b") === "a&amp;b");
t("angle brackets escaped", escapeXml("<x>") === "&lt;x&gt;");
t("quotes escaped", escapeXml("\"'") === "&quot;&apos;");

console.log("\n=== host resolution prefers proof of ownership (S2) ===");
{
  // The hole: workspace A claimed customer.com (which seeded its
  // marketplace_domain), never verified, and the claim expired. Workspace B
  // claimed and VERIFIED customer.com. Two sources now name two workspaces,
  // and "first match" used to be whichever a query returned first.
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";
  const C = "33333333-3333-3333-3333-333333333333";
  const custom = (workspaceId: string, verifiedAt: string | null): HostMatch =>
    ({ workspaceId, source: "workspace_domains", verifiedAt });
  const legacy = (workspaceId: string, verifiedAt: string | null): HostMatch =>
    ({ workspaceId, source: "marketplace_domain", verifiedAt });

  t("no candidates resolves to nothing", preferredHostMatch([]) === null);
  t("a lone legacy match still resolves", preferredHostMatch([legacy(A, "2026-01-01T00:00:00Z")])?.workspaceId === A);
  t("a lone verified custom domain resolves", preferredHostMatch([custom(B, "2026-09-01T00:00:00Z")])?.workspaceId === B);

  t("the verified custom domain wins over the legacy branch",
    preferredHostMatch([legacy(A, "2026-09-20T00:00:00Z"), custom(B, "2026-09-01T00:00:00Z")])?.workspaceId === B);
  t("…regardless of input order",
    preferredHostMatch([custom(B, "2026-09-01T00:00:00Z"), legacy(A, "2026-09-20T00:00:00Z")])?.workspaceId === B);
  t("…even when the legacy verification is more recent",
    preferredHostMatch([legacy(A, "2026-09-22T00:00:00Z"), custom(B, "2025-01-01T00:00:00Z")])?.workspaceId === B);
  t("…and even when the legacy match has no date at all",
    preferredHostMatch([legacy(A, null), custom(B, null)])?.workspaceId === B);

  t("within the legacy branch the most recent verification wins",
    preferredHostMatch([legacy(A, "2026-01-01T00:00:00Z"), legacy(B, "2026-06-01T00:00:00Z")])?.workspaceId === B);
  t("a dated verification beats an undated one (NULLS LAST)",
    preferredHostMatch([legacy(A, null), legacy(B, "2020-01-01T00:00:00Z")])?.workspaceId === B);
  t("an unparseable date counts as undated",
    preferredHostMatch([legacy(A, "not a date"), legacy(B, "2020-01-01T00:00:00Z")])?.workspaceId === B);
  t("a full tie is settled by the lowest workspace id, deterministically",
    preferredHostMatch([legacy(C, null), legacy(A, null), legacy(B, null)])?.workspaceId === A &&
      preferredHostMatch([legacy(B, null), legacy(A, null), legacy(C, null)])?.workspaceId === A);

  const input = [legacy(A, "2026-09-20T00:00:00Z"), custom(B, "2026-09-01T00:00:00Z")];
  const before = JSON.stringify(input);
  preferredHostMatch(input);
  t("the input is not reordered", JSON.stringify(input) === before);

  // The database applies the same rule; the two must not drift apart.
  const ROOT = join(import.meta.dir, "..");
  const mig = readFileSync(join(ROOT, "supabase/migrations/20260923000500_host_resolver_prefers_verified_domain.sql"), "utf8");
  t("the SQL resolver orders the same way: custom domain first, newest verification, lowest id",
    mig.includes("ORDER BY priority ASC, verified_at DESC NULLS LAST, id ASC"));
  t("the SQL gives workspace_domains priority 0 and marketplace_domain priority 1",
    /0 AS priority[\s\S]*FROM public\.workspace_domains wd[\s\S]*1 AS priority[\s\S]*FROM public\.workspaces w/.test(mig));
  const sitemapSrc = readFileSync(join(ROOT, "src/lib/sitemap.server.ts"), "utf8");
  t("workspaceIdForHost resolves through preferredHostMatch",
    /export async function workspaceIdForHost[\s\S]*preferredHostMatch\(matches\)/.test(sitemapSrc));
  t("workspaceIdForHost still reads verified rows only",
    /\.eq\("verified", true\)/.test(sitemapSrc) && /\.not\("domain_verified_at", "is", null\)/.test(sitemapSrc));
}

console.log("\n=== the thin-page rule is one rule, shared by the page and the sitemap (P3) ===");
{
  t("the threshold is 300 body characters", THIN_PAGE_MIN_BODY_CHARS === 300);
  t("no listings and 299 characters is thin", isThinPage({ listingCount: 0, bodyMarkdown: "x".repeat(299) }));
  t("no listings and exactly 300 characters is not thin", !isThinPage({ listingCount: 0, bodyMarkdown: "x".repeat(300) }));
  t("one listing rescues an empty body", !isThinPage({ listingCount: 1, bodyMarkdown: "" }));
  t("a null body with no listings is thin", isThinPage({ listingCount: 0, bodyMarkdown: null }));
  t("an undefined body with no listings is thin", isThinPage({ listingCount: 0, bodyMarkdown: undefined }));
  t("whitespace does not count as body", isThinPage({ listingCount: 0, bodyMarkdown: " ".repeat(400) }));
  t("surrounding whitespace is trimmed before counting",
    isThinPage({ listingCount: 0, bodyMarkdown: `  ${"x".repeat(299)}  ` }) &&
      !isThinPage({ listingCount: 0, bodyMarkdown: `  ${"x".repeat(300)}  ` }));

  // Both callers must use the shared predicate, not a private copy of it.
  const ROOT = join(import.meta.dir, "..");
  const page = readFileSync(join(ROOT, "src/routes/a.$slug.tsx"), "utf8");
  t("a.$slug.tsx imports the shared predicate", /import \{ isThinPage \} from "@\/lib\/thin-page";/.test(page));
  t("a.$slug.tsx decides noindex with it",
    /const isThin = isThinPage\(\{ listingCount: p\.listings\.length, bodyMarkdown: p\.body_markdown \}\);/.test(page));
  t("a.$slug.tsx no longer restates the numbers", !/bodyLen < 300/.test(page));
  const sitemap = readFileSync(join(ROOT, "src/lib/sitemap.server.ts"), "utf8");
  // The sitemap measures each body as its chunk arrives and keeps only the
  // length, then applies the same rule to it (isThinPageMeasured is what
  // isThinPage itself calls).
  t("the sitemap imports the shared predicate",
    /from "@\/lib\/thin-page"/.test(sitemap) &&
      /body_chars: thinPageBodyChars\(row\.body_markdown\)/.test(sitemap) &&
      /isThinPageMeasured\(\{ listingCount, bodyChars: p\.body_chars \}\)/.test(sitemap));
  t("…the measured form is the same rule",
    [0, 1].every((listingCount) =>
      ["", "x".repeat(299), `  ${"x".repeat(299)}  `, "x".repeat(300), " ".repeat(400), null, undefined].every(
        (body) => isThinPage({ listingCount, bodyMarkdown: body }) === isThinPageMeasured({ listingCount, bodyChars: thinPageBodyChars(body) }),
      )));
  t("the sitemap reads listings in one query with an exact count",
    /\.from\("tenant_listings"\)\s*\.select\("city, state, category", \{ count: "exact" \}\)/.test(sitemap));
  t("the sitemap fails open when the listings read errors or is cut short",
    /listingsComplete =\s*!listingsRead\.error &&/.test(sitemap) && /listingsRead\.count <= listingRows\.length/.test(sitemap) &&
      /const countListings = listingsComplete \? buildListingCounter\(listingRows\) : null;/.test(sitemap));
  t("legacy content_pages count as having no listings", /p\.legacy \? 0 : countListings\(p\.listing_filter \?\? \{\}\)/.test(sitemap));
  t("a slug is claimed before the thin test, so a thin page never yields to a legacy twin",
    sitemap.indexOf("seen.add(slug);") < sitemap.indexOf("if (countListings) {"));
}

console.log("\n=== listing counts per page filter, matched the way the page query matches ===");
{
  const count = buildListingCounter([
    { city: "Austin", state: "TX", category: "pool" },
    { city: "austin", state: "tx", category: "cabin" },
    { city: "Dallas", state: "TX", category: null },
    { city: null, state: null, category: "pool" },
    { city: " Austin ", state: "TX", category: "pool" },
  ]);
  t("no filter counts every published listing", count({}) === 5, String(count({})));
  t("null filter counts every published listing", count(null) === 5 && count(undefined) === 5);
  t("city matches case-insensitively", count({ city: "AUSTIN" }) === 3, String(count({ city: "AUSTIN" })));
  t("city is trimmed on both sides", count({ city: " austin " }) === 3);
  t("city + state", count({ city: "austin", state: "tx" }) === 3);
  t("city + category", count({ city: "Austin", category: "pool" }) === 2, String(count({ city: "Austin", category: "pool" })));
  t("state alone", count({ state: "tx" }) === 4, String(count({ state: "tx" })));
  t("category alone is exact, like the page's .eq()", count({ category: "pool" }) === 3 && count({ category: "Pool" }) === 0);
  t("a listing with no city never satisfies a city filter", count({ city: "" }) === 5 && count({ city: "Nowhere" }) === 0);
  t("empty filter values mean no filter, like the page's `if (f.city)`", count({ city: "", state: "", category: "" }) === 5);
  t("a fully specified miss is 0", count({ city: "Dallas", state: "TX", category: "pool" }) === 0);
  t("non-string filter values are stringified", count({ city: 42 as unknown }) === 0);
  t("an empty catalogue counts nothing", buildListingCounter([])({}) === 0 && buildListingCounter([])({ city: "x" }) === 0);
}

console.log("\n=== the listings read is paged past the API row cap (B4) ===");
{
  // PostgREST returns at most max-rows (the Supabase default, 1000) per
  // request, whatever .limit() asked for. A workspace with more published
  // listings than that got a short read on every fetch, so listingsComplete
  // was always false: the thin-page filter was skipped and an error logged,
  // for exactly the workspaces with the most pages.
  t("chunks are 1000 rows: the PostgREST default max-rows", LISTING_CHUNK_SIZE === 1000);
  t("at most 50 chunks are read", LISTING_MAX_CHUNKS === 50);
  type Row = { id: number };
  const catalogue = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: i }));
  // Serves a catalogue the way PostgREST does: `count` is the total, a range
  // returns at most `cap` rows.
  const serve = (all: Row[], cap = 1000) => {
    const ranges: Array<[number, number]> = [];
    const fetchChunk = async (from: number, to: number) => {
      ranges.push([from, to]);
      return { data: all.slice(from, Math.min(to + 1, from + cap)), error: null, count: all.length };
    };
    return { ranges, fetchChunk };
  };
  {
    const { ranges, fetchChunk } = serve(catalogue(2500));
    const r = await readInChunks(fetchChunk);
    t("2500 listings are collected in full, with the count", r.error === null && r.count === 2500 && r.data?.length === 2500, `${r.data?.length} of ${r.count}`);
    t("…in three ranges of 1000, stopping at the count",
      JSON.stringify(ranges) === JSON.stringify([[0, 999], [1000, 1999], [2000, 2999]]), JSON.stringify(ranges));
    t("…every row exactly once", new Set(r.data!.map((x) => x.id)).size === 2500);
  }
  {
    const { ranges, fetchChunk } = serve(catalogue(1000));
    const r = await readInChunks(fetchChunk);
    t("exactly 1000 listings need one read, no probing for more", r.data?.length === 1000 && ranges.length === 1, String(ranges.length));
  }
  {
    const { ranges, fetchChunk } = serve(catalogue(999));
    const r = await readInChunks(fetchChunk);
    t("999 listings need one read", r.data?.length === 999 && ranges.length === 1);
  }
  {
    const { ranges, fetchChunk } = serve(catalogue(0));
    const r = await readInChunks(fetchChunk);
    t("an empty catalogue is one read of nothing", r.data?.length === 0 && r.count === 0 && ranges.length === 1);
  }
  {
    const { ranges, fetchChunk } = serve(catalogue(3000), 500);
    const r = await readInChunks(fetchChunk);
    t("a server capped below the chunk size is paged from where each read stopped",
      r.data?.length === 3000 && ranges.length === 6 && ranges[1]![0] === 500, JSON.stringify(ranges));
  }
  {
    const { ranges, fetchChunk } = serve(catalogue(60_000));
    const r = await readInChunks(fetchChunk);
    t("the hard stop: 50 chunks, then the read is reported short of its count",
      ranges.length === 50 && r.data?.length === 50_000 && r.count === 60_000 && r.error === null, `${ranges.length} chunks, ${r.data?.length} of ${r.count}`);
    t("…which is exactly the sitemap's fail-open condition (count > rows)", !(r.count == null || r.count <= r.data!.length));
  }
  {
    let n = 0;
    const all = catalogue(2500);
    const r = await readInChunks(async (from, to) => {
      n++;
      if (n === 2) return { data: null, error: { message: "boom" }, count: 2500 };
      return { data: all.slice(from, to + 1), error: null, count: 2500 };
    });
    t("a failing chunk stops the read and reports the error", n === 2 && r.error?.message === "boom");
    t("…with the rows collected so far and the count, so the caller fails open", r.data?.length === 1000 && r.count === 2500 && r.error !== null);
  }
  {
    const all = catalogue(1500);
    const r = await readInChunks(async (from, to) => ({ data: all.slice(from, to + 1), error: null, count: null }));
    t("without a count, a short chunk ends the read", r.data?.length === 1500 && r.count === null);
  }
  {
    const { ranges, fetchChunk } = serve(catalogue(25), 10);
    const r = await readInChunks(fetchChunk, { chunkSize: 10, maxChunks: 2 });
    t("chunk size and hard stop are parameters of the loop", r.data?.length === 20 && ranges.length === 2 && r.count === 25);
  }

  const ROOT = join(import.meta.dir, "..");
  const sitemap = readFileSync(join(ROOT, "src/lib/sitemap.server.ts"), "utf8");
  const chunkedAt = sitemap.indexOf("readInChunks<ListingLocation>((from, to) =>");
  const listingsAt = sitemap.indexOf('.from("tenant_listings")');
  // The pages are read the same way now; the listings read is the one after its .from().
  const rangeAt = sitemap.indexOf(".range(from, to)", listingsAt);
  t("the sitemap's listings read goes through readInChunks with a .range() per chunk", chunkedAt > 0 && listingsAt > chunkedAt && rangeAt > listingsAt);
  const listingQuery = sitemap.slice(listingsAt, rangeAt);
  t("…over a fixed order, so chunks neither overlap nor skip", /\.order\("id", \{ ascending: true \}\)/.test(listingQuery));
  t("…keeping the workspace and published filters", /\.eq\("workspace_id", workspaceId\)\s*\.eq\("state_published", true\)/.test(listingQuery));
  t("…and no longer trusting a .limit() the API would cap anyway", !/\.limit\(/.test(listingQuery));
  t("the completeness rule is unchanged: an error or fewer rows than the count fails open",
    /listingsComplete =\s*!listingsRead\.error &&\s*\(listingsRead\.count == null \|\| listingsRead\.count <= listingRows\.length\);/.test(sitemap));
  t("…and the incomplete case is still logged", /listings read incomplete, skipping the thin-page filter/.test(sitemap));
}

console.log("\n=== the sitemap never advertises a slug the page route refuses (B5) ===");
{
  // getPublicTenantPage refuses anything outside PUBLIC_PAGE_SLUG_RE before it
  // touches a query. A sitemap that lists such a slug sends Google to a URL
  // that can only 404.
  const ROOT = join(import.meta.dir, "..");
  const PURE = join(ROOT, "src/lib/public-page-slug.ts");
  t("the rule lives in a pure module", existsSync(PURE));
  const pure = existsSync(PURE) ? readFileSync(PURE, "utf8") : "";
  t("…with no imports of its own", !/^\s*import /m.test(pure));
  t("…defining the regex and the predicate",
    /export const PUBLIC_PAGE_SLUG_RE = \/\^\[a-z0-9-\]\{1,200\}\$\/;/.test(pure) && /export function isPublicPageSlug\(slug: string\): boolean/.test(pure));
  t("the page route re-exports the very same rule (existing imports keep working)",
    pageRouteIsPublicPageSlug === isPublicPageSlug && PAGE_ROUTE_PUBLIC_PAGE_SLUG_RE === PUBLIC_PAGE_SLUG_RE);
  const pageSrc = readFileSync(join(ROOT, "src/lib/public-tenant-page.functions.ts"), "utf8");
  t("…and no longer defines a copy",
    !/export const PUBLIC_PAGE_SLUG_RE = \//.test(pageSrc) && /export \{ PUBLIC_PAGE_SLUG_RE, isPublicPageSlug \} from "@\/lib\/public-page-slug";/.test(pageSrc));
  const sitemap = readFileSync(join(ROOT, "src/lib/sitemap.server.ts"), "utf8");
  t("the sitemap imports the predicate from the pure module", /import \{ isPublicPageSlug \} from "@\/lib\/public-page-slug";/.test(sitemap));
  const stripAt = sitemap.indexOf('const slug = String(p.slug || "").replace(/^\\/+/, "");');
  const filterAt = sitemap.indexOf("if (!slug || !isPublicPageSlug(slug) || seen.has(slug)) return false;");
  t("…and filters every row (tenant and legacy) with it, right after the leading-slash strip",
    stripAt > 0 && filterAt > stripAt && filterAt - stripAt < 250, `${stripAt} / ${filterAt}`);
  t("…before the slug is claimed, so a refused slug never shadows a legacy twin", filterAt > 0 && filterAt < sitemap.indexOf("seen.add(slug);"));

  // The filter, applied the way the sitemap applies it; yields the slug the
  // <loc> would carry.
  const advertised = (slugs: string[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of slugs) {
      const slug = String(raw || "").replace(/^\/+/, "");
      if (!slug || !isPublicPageSlug(slug) || seen.has(slug)) continue;
      seen.add(slug);
      out.push(slug);
    }
    return out;
  };
  t("a normal slug is advertised", advertised(["austin-pools"]).length === 1);
  t("a leading slash is stripped before the rule is applied", JSON.stringify(advertised(["/austin-pools"])) === '["austin-pools"]');
  t("a filter-widening slug is dropped", advertised(["x,slug.neq.zzz"]).length === 0);
  t("uppercase, dots, path separators and spaces are dropped", advertised(["Austin", "a.b", "a/b", "a b"]).length === 0);
  t("a 201-character slug is dropped, 200 passes", advertised(["a".repeat(201)]).length === 0 && advertised(["a".repeat(200)]).length === 1);
  t("a duplicate is still dropped", advertised(["a", "/a"]).length === 1);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) console.log("FAILED:\n  " + failed.join("\n  ") + "\n");
process.exit(fail ? 1 : 0);
