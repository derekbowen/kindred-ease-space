/**
 * SITEMAP HOSTS: the exact verified hostname, nothing else. Run: bun tests/sitemap-host.test.ts
 *
 * current_workspace_id_by_host (migration 20260929000200) no longer strips
 * "www.": a request for www.example.com used to resolve to whichever workspace
 * had verified the bare example.com — another tenant's pages and sitemap on a
 * host nobody proved. The app-side mirror (resolveTenantHost /
 * workspaceIdForHost in src/lib/sitemap.server.ts) follows it exactly:
 * case-insensitive, port removed, www kept, verified rows only, the same
 * preference between the two sources. Unknown hosts get 404, a failed lookup
 * 503 — never a guess. Behavioral (the real supabase-js client against a fake
 * PostgREST) plus the rules shared with the page path. Offline.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FakePostgrest, coverageGroupsOf, harness, type Row } from "./_support/fake-postgrest-sitemap";

const ORIGIN = "http://sitemap-host.test";
process.env.SUPABASE_URL = ORIGIN;
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
const fake = new FakePostgrest(ORIGIN);
fake.install();

const sm = await import("../src/lib/sitemap.server");
const thin = await import("../src/lib/thin-page");
const slugRule = await import("../src/lib/public-page-slug");
const pageRoute = await import("../src/lib/public-tenant-page.functions");
const { makeFilter } = await import("../src/lib/coverage/target");
const { t, done } = harness();
const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ---------------------------------------------------------------------------
console.log("\n=== requestHost: what the visitor asked for ===");
t("www is PRESERVED", sm.requestHost("www.customer.com") === "www.customer.com");
t("apex stays apex", sm.requestHost("customer.com") === "customer.com");
t("scheme stripped", sm.requestHost("https://www.customer.com") === "www.customer.com");
t("port stripped", sm.requestHost("www.customer.com:8443") === "www.customer.com");
t("path, query and fragment stripped", sm.requestHost("www.customer.com/a/x?y#z") === "www.customer.com");
t("case folded", sm.requestHost("WWW.Customer.COM") === "www.customer.com");
t(
  "x-forwarded-host list takes the LAST entry (what the closest proxy saw; a visitor-supplied first entry can't pick the tenant)",
  sm.requestHost("attacker.example, www.customer.com") === "www.customer.com" &&
    sm.requestHost("www.customer.com") === "www.customer.com",
);
t("empty input is empty", sm.requestHost("") === "" && sm.requestHost(null) === "");

console.log("\n=== hostKey: the resolver's key is the exact host ===");
t("no www stripping: www and bare are two keys", sm.hostKey("www.customer.com") === "www.customer.com" && sm.hostKey("customer.com") === "customer.com");
t("case-insensitive, port removed", sm.hostKey("WWW.Customer.COM:443") === "www.customer.com");
t("a host that merely contains www is untouched", sm.hostKey("mywww.customer.com") === "mywww.customer.com");
for (const junk of ["localhost", "customer.com.", "cust_omer.com", "cust%omer.com", "*.customer.com", "a b.com", "-bad.com", "", "customer..com"]) {
  t(`"${junk}" can't be a verified hostname → no key (no LIKE wildcard ever reaches a query)`, sm.hostKey(junk) === null);
}
t("the old www-stripping lookup key is gone", !("normalizeHost" in sm));

console.log("\n=== platform hosts ===");
t("founders.click is a platform host", sm.isPlatformHost("founders.click"));
t("www.founders.click is a platform host", sm.isPlatformHost("www.founders.click") && sm.isPlatformHost("WWW.founders.click:443"));
t("the platform host set is exact: no other subdomain", !sm.isPlatformHost("app.founders.click") && !sm.isPlatformHost("founders.click.evil.com"));
t("a customer domain is not a platform host", !sm.isPlatformHost("www.customer.com"));
t("the platform sitemap answers on the platform hosts (and a local dev server)",
  sm.servesPlatformSitemap("www.founders.click") && sm.servesPlatformSitemap("founders.click") && sm.servesPlatformSitemap("localhost:3000"));
t("…and nowhere else", !sm.servesPlatformSitemap("customer.com") && !sm.servesPlatformSitemap("www.customer.com") && !sm.servesPlatformSitemap(""));
const securityHeaders = read("src/lib/security-headers.ts");
t("…from the one platform host list (security-headers.ts)", /import \{ PLATFORM_HOSTS \} from "@\/lib\/security-headers";/.test(read("src/lib/sitemap.server.ts")) && /PLATFORM_HOSTS: ReadonlySet<string> = new Set\(\["founders\.click", "www\.founders\.click"\]\)/.test(securityHeaders));

console.log("\n=== XML escaping ===");
t("ampersand escaped", sm.escapeXml("a&b") === "a&amp;b");
t("angle brackets escaped", sm.escapeXml("<x>") === "&lt;x&gt;");
t("quotes escaped", sm.escapeXml("\"'") === "&quot;&apos;");

console.log("\n=== the preference rule, shared with the SQL resolver ===");
{
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";
  const C = "33333333-3333-3333-3333-333333333333";
  const custom = (workspaceId: string, verifiedAt: string | null): import("../src/lib/sitemap.server").HostMatch =>
    ({ workspaceId, source: "workspace_domains", verifiedAt });
  const legacy = (workspaceId: string, verifiedAt: string | null): import("../src/lib/sitemap.server").HostMatch =>
    ({ workspaceId, source: "marketplace_domain", verifiedAt });
  const pick = (m: Parameters<typeof sm.preferredHostMatch>[0]) => sm.preferredHostMatch(m)?.workspaceId ?? null;
  t("no candidates resolves to nothing", pick([]) === null);
  t("a lone legacy match still resolves", pick([legacy(A, "2026-01-01T00:00:00Z")]) === A);
  t("the verified custom domain wins over the legacy branch", pick([legacy(A, "2026-09-20T00:00:00Z"), custom(B, "2026-09-01T00:00:00Z")]) === B);
  t("…regardless of input order", pick([custom(B, "2026-09-01T00:00:00Z"), legacy(A, "2026-09-20T00:00:00Z")]) === B);
  t("…and even when neither has a date", pick([legacy(A, null), custom(B, null)]) === B);
  t("within a source the most recent verification wins", pick([legacy(A, "2026-01-01T00:00:00Z"), legacy(B, "2026-06-01T00:00:00Z")]) === B);
  t("a dated verification beats an undated one (NULLS LAST)", pick([legacy(A, null), legacy(B, "2020-01-01T00:00:00Z")]) === B);
  t("an unparseable date counts as undated", pick([legacy(A, "not a date"), legacy(B, "2020-01-01T00:00:00Z")]) === B);
  t("a full tie goes to the lowest workspace id", pick([legacy(C, null), legacy(A, null), legacy(B, null)]) === A);

  const mig = read("supabase/migrations/20260929000200_domain_write_lock_and_exact_host.sql");
  const fn = mig.slice(mig.indexOf("CREATE OR REPLACE FUNCTION public.current_workspace_id_by_host"), mig.indexOf("$$;", mig.indexOf("CREATE OR REPLACE FUNCTION public.current_workspace_id_by_host")));
  t("the SQL resolver compares lower(hostname) with the normalized host exactly", /lower\(wd\.hostname\) = n\.h/.test(fn) && /wd\.verified = true/.test(fn));
  t("…and lower(marketplace_domain) with it, gated on domain_verified_at", /lower\(w\.marketplace_domain\) = n\.h/.test(fn) && /w\.domain_verified_at IS NOT NULL/.test(fn));
  t("…normalizing only case, surrounding space and the port", /lower\(btrim\(regexp_replace\(COALESCE\(_host, ''\), ':\\d\+\$', ''\)\)\)/.test(fn));
  t("…with no www stripping", !/www/i.test(fn));
  t("…and the same order: custom domain first, newest verification, lowest id", /ORDER BY priority ASC, verified_at DESC NULLS LAST, id ASC/.test(fn));
  const src = read("src/lib/sitemap.server.ts");
  const resolver = src.slice(src.indexOf("export async function resolveTenantHost"), src.indexOf("export async function workspaceIdForHost"));
  t("the app mirror reads verified domain rows by case-insensitive exact host", /\.from\("workspace_domains"\)[\s\S]*?\.eq\("verified", true\)[\s\S]*?\.ilike\("hostname", host\)/.test(resolver));
  t("…and the legacy branch only with a domain_verified_at", /\.ilike\("marketplace_domain", host\)[\s\S]*?\.not\("domain_verified_at", "is", null\)/.test(resolver));
  t("…re-compares every row exactly (lower-cased stored value === host)", /String\(d\.hostname \?\? ""\)\.toLowerCase\(\) === host/.test(resolver) && /String\(w\.marketplace_domain \?\? ""\)\.toLowerCase\(\) === host/.test(resolver));
  t("…resolves through preferredHostMatch", /preferredHostMatch\(matches\)/.test(resolver));
  t("…and nothing in the generator strips www any more", !/replace\(\/\^www\\\./.test(src));
}

// ---------------------------------------------------------------------------
console.log("\n=== behavior: www and bare are different hosts ===");
const WS_A = "aaaaaaaa-0000-4000-8000-000000000001";
const WS_B = "bbbbbbbb-0000-4000-8000-000000000002";
const WS_C = "cccccccc-0000-4000-8000-000000000003";
const T_CITY = "7e000000-0000-4000-8000-000000000001";
const place = (city: string) => makeFilter(["country", "region", "city"], { countryKey: "us", regionKey: "tx", cityKey: city, categoryKey: null });

function seed() {
  fake.set("workspace_domains", [
    { id: "d1", workspace_id: WS_A, hostname: "pools.example", verified: true, verified_at: "2026-09-01T00:00:00Z", status: "active" },
    { id: "d2", workspace_id: WS_B, hostname: "www.boats.example", verified: true, verified_at: "2026-09-01T00:00:00Z", status: "active" },
    // Claimed but never verified: proves nothing.
    { id: "d3", workspace_id: WS_C, hostname: "unproven.example", verified: false, verified_at: null, status: "verification_required" },
  ]);
  fake.set("workspaces", [
    { id: WS_A, marketplace_domain: "pools.example", domain_verified_at: "2026-09-01T00:00:00Z", subscription_status: "active", current_period_end: "2099-01-01T00:00:00Z" },
    { id: WS_B, marketplace_domain: "www.boats.example", domain_verified_at: "2026-09-01T00:00:00Z", subscription_status: "active", current_period_end: "2099-01-01T00:00:00Z" },
    // A legacy verified marketplace_domain stored in mixed case.
    { id: WS_C, marketplace_domain: "Legacy.Example", domain_verified_at: "2026-08-01T00:00:00Z", subscription_status: "active", current_period_end: "2099-01-01T00:00:00Z" },
  ]);
  fake.set("page_templates", [{ id: T_CITY, slug: "city_hub", is_active: true }]);
  const pageRow = (ws: string, slug: string, n: number): Row => ({
    id: `a0000000-0000-4000-8000-00000000000${n}`,
    workspace_id: ws,
    template_id: T_CITY,
    slug,
    status: "published",
    noindex: false,
    listing_filter: place("austin"),
    published_at: "2026-09-01T00:00:00Z",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
  });
  fake.set("tenant_pages", [pageRow(WS_A, "a-pools", 1), pageRow(WS_B, "b-boats", 2), pageRow(WS_C, "c-legacy", 3)]);
  fake.set("content_pages", []);
  fake.set("tenant_listings", [WS_A, WS_B, WS_C].map((ws, i) => ({
    id: `d0000000-0000-4000-8000-00000000000${i}`, workspace_id: ws, state_published: true,
    country_key: "us", region_key: "tx", city_key: "austin", category_key: null, city: "austin",
  })));
  fake.rpcs = {
    workspace_granted_pages: () => 0,
    inventory_coverage_groups: (args) => coverageGroupsOf(fake.rows("tenant_listings"), String(args._workspace_id)),
  };
  fake.failWhen = null;
}
// Through the edge, request.url is the origin's URL and the tenant host is a header.
const get = (host: string) => sm.tenantSitemapResponse(host, "https://www.founders.click/a/sitemap.xml");
const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);

seed();
{
  const bare = await get("pools.example");
  t("the verified host gets its sitemap", bare.status === 200 && locs(bare.body).join() === "https://pools.example/a/a-pools", `${bare.status} ${bare.body}`);
  const www = await get("www.pools.example");
  t("www.<verified host> is NOT the verified host: 404, no sitemap", www.status === 404 && !www.body.includes("a-pools"), `${www.status} ${www.body}`);
  const wwwB = await get("www.boats.example");
  t("a workspace that verified www gets its sitemap on www", wwwB.status === 200 && locs(wwwB.body).join() === "https://www.boats.example/a/b-boats");
  const bareB = await get("boats.example");
  t("…and nothing on the bare host it never proved", bareB.status === 404);
  const upper = await get("POOLS.Example:8443");
  t("case and port don't matter: POOLS.Example:8443 is pools.example", upper.status === 200 && locs(upper.body).join() === "https://pools.example/a/a-pools");
  const fwd = await get("attacker.example, pools.example");
  t("an x-forwarded-host list resolves by its last entry", fwd.status === 200 && locs(fwd.body).join() === "https://pools.example/a/a-pools");
  const fwdSpoof = await get("pools.example, nobody.example");
  t("…so a visitor-supplied first entry can't choose the tenant", fwdSpoof.status === 404);
  const legacyHost = await get("legacy.example");
  t("a legacy marketplace_domain stored in mixed case still resolves (lower(stored) = host)", legacyHost.status === 200 && locs(legacyHost.body).join() === "https://legacy.example/a/c-legacy", `${legacyHost.status}`);
  t("URLs are built on exactly the requested verified host", locs(wwwB.body).every((l) => l.startsWith("https://www.boats.example/a/")) && locs(bare.body).every((l) => l.startsWith("https://pools.example/a/")));
}
{
  const unknown = await get("nobody.example");
  t("an unknown host gets 404", unknown.status === 404 && unknown.body === "not found");
  const unproven = await get("unproven.example");
  t("a claimed but unverified host gets 404", unproven.status === 404);
  fake.update("workspaces", (w) => w.id === WS_C, { domain_verified_at: null });
  const unstamped = await get("legacy.example");
  t("a legacy marketplace_domain without domain_verified_at gets 404", unstamped.status === 404);
  seed();
  for (const platform of ["www.founders.click", "founders.click"]) {
    const res = await get(platform);
    t(`the platform host ${platform} has no /a/sitemap.xml (404)`, res.status === 404);
  }
  fake.clearHits();
  for (const junk of ["cust%omer.example", "pools_example.com", "*.example", "localhost"]) {
    const res = await get(junk);
    t(`"${junk}" → 404`, res.status === 404);
  }
  t("…and none of those reached the database", fake.hits.length === 0, String(fake.hits.length));
  t("404s are not cached", (await get("nobody.example")).headers["Cache-Control"] === "no-store");
}
{
  // Another tenant is never served for a host it doesn't own.
  const a = await get("pools.example");
  const b = await get("www.boats.example");
  t("each host lists only its own workspace's pages", !locs(a.body).some((l) => /b-boats|c-legacy/.test(l)) && !locs(b.body).some((l) => /a-pools|c-legacy/.test(l)));
}
{
  // A failed lookup is not a verdict: 503, never the other source's answer.
  seed();
  const quiet = console.error;
  console.error = () => {};
  fake.failWhen = (h) => (h.name === "workspace_domains" ? "timeout" : null);
  const res = await get("pools.example");
  const id = await sm.workspaceIdForHost("pools.example");
  fake.failWhen = null;
  console.error = quiet;
  t("the verified-domain read failing → 503, not the legacy branch's guess", res.status === 503 && res.headers["Retry-After"] === "300", `${res.status}`);
  t("workspaceIdForHost answers null on a failed lookup (the domain test then says not-connected)", id === null);
  t("workspaceIdForHost resolves the exact host otherwise", (await sm.workspaceIdForHost("pools.example")) === WS_A && (await sm.workspaceIdForHost("www.pools.example")) === null);
}
{
  seed();
  // The verified custom domain outranks a legacy stamp for the same host.
  fake.set("workspaces", [
    ...fake.rows("workspaces"),
    { id: WS_C + "x", marketplace_domain: "pools.example", domain_verified_at: "2026-09-25T00:00:00Z", subscription_status: "active", current_period_end: "2099-01-01T00:00:00Z" },
  ]);
  const res = await get("pools.example");
  t("a newer legacy stamp on the same host never outranks the verified domain row", locs(res.body).join() === "https://pools.example/a/a-pools");
}

// ---------------------------------------------------------------------------
console.log("\n=== the cache window is explicit and short ===");
{
  seed();
  const res = await get("pools.example");
  t("Cache-Control: private, max-age=300 (no shared cache may store it)", res.headers["Cache-Control"] === "private, max-age=300");
  t("Vary: Host, X-Forwarded-Host (one URL, many hosts)", res.headers.Vary === "Host, X-Forwarded-Host");
  t("Content-Type: application/xml; charset=utf-8", res.headers["Content-Type"] === "application/xml; charset=utf-8");
  t("the window is five minutes", sm.SITEMAP_CACHE_SECONDS === 300);
}

console.log("\n=== the per-host memo: repeated requests don't rebuild, and never cross hosts ===");
{
  let builds: string[] = [];
  let clock = 1_000;
  const answers: Record<string, { status: number; body: string }> = {
    "pools.example|": { status: 200, body: "<urlset>pools</urlset>" },
    "boats.example|": { status: 200, body: "<urlset>boats</urlset>" },
    "pools.example|2": { status: 404, body: "not found" },
    "down.example|": { status: 503, body: "unavailable" },
    "huge.example|": { status: 200, body: "x".repeat(50) },
  };
  const memo = sm.sitemapResponseMemo(
    async (rawHost: string, url: string) => {
      const key = `${sm.requestHost(rawHost)}|${new URL(url).searchParams.get("page") ?? ""}`;
      builds.push(key);
      const a = answers[key]!;
      return { status: a.status, body: a.body, headers: { "Cache-Control": "private, max-age=300" } } as any;
    },
    { ttlMs: 60_000, maxEntries: 3, maxBodyChars: 40, now: () => clock },
  );
  const U = "https://x.example/a/sitemap.xml";
  const p1 = await memo("pools.example", U);
  const p2 = await memo("POOLS.example:443", U);
  t("the second request for a host is served from the memo (one build)", p1.body === p2.body && builds.length === 1, JSON.stringify(builds));
  const b1 = await memo("boats.example", U);
  t("another host is built for itself, never given the first host's answer", b1.body === "<urlset>boats</urlset>" && builds.length === 2);
  const spoof = await memo("attacker.example, boats.example", U);
  t("the memo key uses the same last-entry host rule", spoof.body === "<urlset>boats</urlset>" && builds.length === 2);
  await memo("pools.example", U + "?page=2");
  await memo("pools.example", U + "?page=2");
  t("each ?page is its own entry, and a 404 is kept too", builds.filter((b) => b === "pools.example|2").length === 1);
  await memo("down.example", U);
  await memo("down.example", U);
  t("a 503 is never kept (the next request retries)", builds.filter((b) => b === "down.example|").length === 2);
  await memo("huge.example", U);
  await memo("huge.example", U);
  t("an answer above the size cap is never kept", builds.filter((b) => b === "huge.example|").length === 2);
  clock += 60_001;
  await memo("boats.example", U);
  t("after the TTL the host is rebuilt", builds.filter((b) => b === "boats.example|").length === 2);
  builds = [];
  await memo("pools.example", U);
  t("the memo holds at most maxEntries answers (the oldest went first)", builds.length === 1);
}

// ---------------------------------------------------------------------------
console.log("\n=== the thin rule: one module, never looser than the renderer's ===");
t("the threshold is 300 body characters", thin.THIN_PAGE_MIN_BODY_CHARS === 300);
t("no listings and 299 characters is thin", thin.isThinPage({ listingCount: 0, bodyMarkdown: "x".repeat(299) }));
t("no listings and exactly 300 characters is not thin", !thin.isThinPage({ listingCount: 0, bodyMarkdown: "x".repeat(300) }));
t("one listing rescues an empty body", !thin.isThinPage({ listingCount: 1, bodyMarkdown: "" }));
t("null / undefined bodies with no listings are thin", thin.isThinPage({ listingCount: 0, bodyMarkdown: null }) && thin.isThinPage({ listingCount: 0, bodyMarkdown: undefined }));
t("whitespace does not count as body", thin.isThinPage({ listingCount: 0, bodyMarkdown: " ".repeat(400) }));
t("a listing template with no matching listings is thin, however long its text", thin.isThinForTemplate({ requiresListings: true, listingCount: 0, bodyChars: 5000 }));
t("a listing template with listings is not thin, even with a short body", !thin.isThinForTemplate({ requiresListings: true, listingCount: 1, bodyChars: 0 }));
t("a page that needs no listings is judged on its body alone", thin.isThinForTemplate({ requiresListings: false, listingCount: 50, bodyChars: 299 }) && !thin.isThinForTemplate({ requiresListings: false, listingCount: 0, bodyChars: 300 }));
{
  let never = true;
  for (const requiresListings of [true, false])
    for (const listingCount of [0, 1, 7])
      for (const bodyChars of [0, 120, 299, 300, 800])
        if (thin.isThinPageMeasured({ listingCount, bodyChars }) && !thin.isThinForTemplate({ requiresListings, listingCount, bodyChars })) never = false;
  t("every page isThinPage calls thin is thin by isThinForTemplate too (the sitemap never lists a page the renderer noindexes)", never);
}
{
  const renderers = [
    "src/routes/a.$slug.tsx",
    "src/lib/public-tenant-page.functions.ts",
    ...(existsSync(join(ROOT, "src/components/templates"))
      ? readdirSync(join(ROOT, "src/components/templates")).map((f) => `src/components/templates/${f}`)
      : []),
  ].filter((f) => existsSync(join(ROOT, f)) && !f.endsWith("/"));
  t("the public renderer decides noindex from src/lib/thin-page (not a private copy)", renderers.some((f) => /from "@\/lib\/thin-page"/.test(read(f))));
  t("no renderer restates the 300-character number", renderers.every((f) => !/bodyLen < 300|\.length < 300/.test(read(f))));
  t("the sitemap decides with isThinForTemplate, measuring bodies with thinPageBodyChars", /isThinForTemplate\(/.test(read("src/lib/sitemap.server.ts")) && /thinPageBodyChars\(r\.body_markdown\)/.test(read("src/lib/sitemap.server.ts")));
}

console.log("\n=== the sitemap never advertises a slug the page route refuses ===");
t("the rule lives in a pure module", !/^\s*import /m.test(read("src/lib/public-page-slug.ts")));
t("…/^[a-z0-9-]{1,200}$/", slugRule.PUBLIC_PAGE_SLUG_RE.source === "^[a-z0-9-]{1,200}$");
t("the page route re-exports the very same rule", pageRoute.isPublicPageSlug === slugRule.isPublicPageSlug && pageRoute.PUBLIC_PAGE_SLUG_RE === slugRule.PUBLIC_PAGE_SLUG_RE);
t("the sitemap imports it from the pure module", /import \{ isPublicPageSlug \} from "@\/lib\/public-page-slug";/.test(read("src/lib/sitemap.server.ts")));
t("founders-domain-test is reserved: a static route answers it before any page", sm.RESERVED_PAGE_SLUGS.has("founders-domain-test") && existsSync(join(ROOT, "src/routes/a.founders-domain-test.tsx")));

done();
