/**
 * THE SITEMAP SCREEN: status, recheck, download. Run: bun tests/sitemap-status.test.ts
 *
 * src/lib/sitemap-status.functions.ts through the real supabase-js client
 * against a fake PostgREST, with the "live" https://{host}/a/sitemap.xml
 * answered by the real route logic (tenantSitemapResponse) behind an injected
 * fetch — so a match is a real end-to-end match, and every way the live
 * sitemap can differ or fail is exercised. The rule under test: nothing reads
 * as green unless the build was complete, the XML valid, the live fetch 200
 * and the URL sets identical. Offline.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakePostgrest, coverageGroupsOf, harness, type Row } from "./_support/fake-postgrest-sitemap";

const ORIGIN = "http://sitemap-status.test";
process.env.SUPABASE_URL = ORIGIN;
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
const fake = new FakePostgrest(ORIGIN);
fake.install();

const sm = await import("../src/lib/sitemap.server");
const st = await import("../src/lib/sitemap-status.functions");
const { assertWorkspaceMember } = await import("../src/lib/admin-helpers.functions");
const { makeFilter } = await import("../src/lib/coverage/target");
const { t, done } = harness();
const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const WS = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_WS = "bbbbbbbb-0000-4000-8000-000000000002";
const USER = "99999999-0000-4000-8000-000000000009";
const DOMAIN_ID = "dddddddd-0000-4000-8000-000000000001";
const HOST = "pools.example";
const T_CITY = "7e000000-0000-4000-8000-000000000001";
const austin = makeFilter(["country", "region", "city"], { countryKey: "us", regionKey: "tx", cityKey: "austin", categoryKey: null });
const nowhere = makeFilter(["country", "region", "city"], { countryKey: "us", regionKey: "tx", cityKey: "nowhere", categoryKey: null });
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);

function domainRow(extra: Row = {}): Row {
  return {
    id: DOMAIN_ID,
    workspace_id: WS,
    hostname: HOST,
    verified: true,
    verified_at: "2026-09-01T00:00:00Z",
    status: "active",
    connection_type: "full_proxy",
    founders_disabled: false,
    sitemap_check: null,
    created_at: "2026-09-01T00:00:00Z",
    ...extra,
  };
}
function pageRow(n: number, slug: string, extra: Row = {}): Row {
  return {
    id: `a0000000-0000-4000-8000-00000000000${n}`,
    workspace_id: WS,
    template_id: T_CITY,
    slug,
    status: "published",
    noindex: false,
    listing_filter: austin,
    published_at: `2026-09-0${n}T00:00:00Z`,
    created_at: `2026-09-0${n}T00:00:00Z`,
    updated_at: `2026-09-1${n}T00:00:00Z`,
    ...extra,
  };
}
function seed(domains: Row[] = [domainRow()]) {
  fake.set("workspace_domains", domains);
  fake.set("workspaces", [
    { id: WS, marketplace_domain: HOST, domain_verified_at: "2026-09-01T00:00:00Z", subscription_status: "active", trial_ends_at: null, current_period_end: "2099-01-01T00:00:00Z" },
  ]);
  fake.set("workspace_members", [{ id: "m1", workspace_id: WS, user_id: USER, role: "member" }]);
  fake.set("page_templates", [{ id: T_CITY, slug: "city_hub", is_active: true }]);
  fake.set("tenant_pages", [
    pageRow(1, "austin-pools"),
    pageRow(2, "austin-cabins"),
    pageRow(3, "nowhere-pools", { listing_filter: nowhere }),
    pageRow(4, "draft-pools", { status: "draft", published_at: null }),
  ]);
  fake.set("content_pages", []);
  fake.set("tenant_listings", [
    { id: "d0000000-0000-4000-8000-000000000001", workspace_id: WS, state_published: true, country_key: "us", region_key: "tx", city_key: "austin", category_key: null, city: "austin" },
  ]);
  fake.rpcs = {
    workspace_granted_pages: () => 0,
    inventory_coverage_groups: (args) => coverageGroupsOf(fake.rows("tenant_listings"), String(args._workspace_id)),
  };
  fake.failWhen = null;
}

/** The live site: the customer host, through the edge, to the real route. */
function live(tamper?: (xml: string) => string): import("../src/lib/sitemap-status.functions").LiveFetch {
  return async (url) => {
    const u = new URL(url);
    const r = await sm.tenantSitemapResponse(u.host, `https://www.founders.click${u.pathname}${u.search}`);
    const body = tamper && r.status === 200 ? tamper(r.body) : r.body;
    return new Response(body, { status: r.status, headers: r.headers });
  };
}
const recheck = (opts: Partial<Parameters<typeof st.runSitemapRecheck>[2]> = {}) =>
  st.runSitemapRecheck(WS, DOMAIN_ID, { fetchImpl: live(), now: () => NOW, timeoutMs: 2_000, ...opts });
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const e = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = e;
  }
};
const rejects = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};
const URL_A = `https://${HOST}/a/austin-pools`;
const URL_B = `https://${HOST}/a/austin-cabins`;

// ---------------------------------------------------------------------------
console.log("\nthe words on the screen: green only for a verified, exact match");
{
  const base: import("../src/lib/sitemap-status.functions").SitemapCheck = {
    version: 1, checked_at: "2026-09-28T12:00:00.000Z", host: HOST, url: `https://${HOST}/a/sitemap.xml`,
    status: "healthy", http_status: 200, included: 2, expected: 2, missing: [], unexpected: [],
    missing_count: 0, unexpected_count: 0, errors: [], duration_ms: 10,
  };
  const tone = (c: Partial<typeof base> | null) => st.describeSitemapCheck(c === null ? null : { ...base, ...c }).tone;
  t("a healthy, exact check of a sitemap with pages is green", tone({}) === "ok");
  t("never checked is neutral, not green", tone(null) === "neutral");
  t("healthy but empty (no pages to list) is neutral, not green", tone({ included: 0, expected: 0 }) === "neutral");
  for (const s of ["mismatch", "fetch_failed", "invalid", "incomplete", "paused"] as const) {
    t(`${s} is never green`, tone({ status: s }) !== "ok");
  }
  t("fetch failures and invalid XML read as errors", tone({ status: "fetch_failed" }) === "error" && tone({ status: "invalid" }) === "error");
  t("a 'healthy' record whose numbers don't add up is not green (defensive)",
    tone({ missing_count: 1 }) !== "ok" && tone({ http_status: 503 }) !== "ok" && tone({ included: 1 }) !== "ok" && tone({ errors: ["x"] }) !== "ok" && tone({ expected: null }) !== "ok");
  t("a mismatch says changes can take up to 5 minutes", /up to 5 minutes/.test(st.describeSitemapCheck({ ...base, status: "mismatch", missing_count: 1 }).detail));
  t("no sentence claims submission or indexing",
    [null, base, ...(["mismatch", "fetch_failed", "invalid", "incomplete", "paused"] as const).map((s) => ({ ...base, status: s }))]
      .map((c) => st.describeSitemapCheck(c))
      .every((d) => !/submitted|indexed/i.test(`${d.title} ${d.detail}`)));
  t("a stored check is read back defensively", st.readStoredCheck(null) === null && st.readStoredCheck({ status: "bogus" }) === null && st.readStoredCheck([]) === null && st.readStoredCheck({ status: "healthy", checked_at: "nope" }) === null);
  t("…and a valid one round-trips", JSON.stringify(st.readStoredCheck(JSON.parse(JSON.stringify(base)))) === JSON.stringify(base));
  t("the freshness window on screen is the cache window", st.SITEMAP_FRESHNESS_MINUTES * 60 === sm.SITEMAP_CACHE_SECONDS);
  t("every exclusion reason has a label, in the generator's order", JSON.stringify(st.EXCLUSION_ORDER) === JSON.stringify(sm.EXCLUSION_REASONS) && sm.EXCLUSION_REASONS.every((r) => st.EXCLUSION_LABELS[r]?.label));
}

console.log("\nno live domain: the exact remaining step, and no URL");
{
  const row = (status: string, extra: Row = {}) => st.isSitemapDomainActive({ ...domainRowView(status), ...extra } as never);
  function domainRowView(status: string) {
    return { id: "x", hostname: HOST, verified: status !== "verification_required" && status !== "pending", status, connection_type: "full_proxy", founders_disabled: false, sitemap_check: null, created_at: null };
  }
  const step = (rows: Array<ReturnType<typeof domainRowView>>) => st.remainingDomainStep(rows);
  t("only verified + active + Founders pages on is live", row("active") && !row("ssl_pending") && !row("active", { founders_disabled: true }) && !row("active", { verified: false }));
  t("no domain → connect", step([]).code === "connect" && step([]).hostname === null);
  t("only a disconnected domain → connect again", step([domainRowView("disconnected")]).code === "connect" && /disconnected/.test(step([domainRowView("disconnected")]).detail));
  t("verification_required → verify, naming the host", step([domainRowView("verification_required")]).code === "verify" && step([domainRowView("verification_required")]).title.includes(HOST));
  for (const s of ["dns_configuration_required", "provisioning", "ssl_pending"]) {
    t(`${s} → point DNS at proxy.founders.click`, step([domainRowView(s)]).code === "point_dns" && /proxy\.founders\.click/.test(step([domainRowView(s)]).title));
  }
  t("error / legacy verified → finish setup", step([domainRowView("error")]).code === "finish_setup" && step([domainRowView("verified")]).code === "finish_setup");
  t("active but switched off → says so", step([{ ...domainRowView("active"), founders_disabled: true }]).code === "domain_paused");
  t("with several domains, the one furthest along decides", step([domainRowView("verification_required"), { ...domainRowView("ssl_pending"), hostname: "seo.pools.example" }]).hostname === "seo.pools.example");
  t("robots.txt guidance for a root-domain connection", st.sitemapGuidance("full_proxy", HOST).robotsLine === `Sitemap: https://${HOST}/a/sitemap.xml` && st.sitemapGuidance("customer_proxy", HOST).robotsLine !== null);
  t("…none for a subdomain connection (its robots.txt isn't the owner's file)", st.sitemapGuidance("subdomain", HOST).robotsLine === null);
}

console.log("\nthe status view");
{
  seed();
  const v = await st.loadSitemapStatus(WS);
  t("the live domain's real sitemap URL", v.domains.length === 1 && v.domains[0]!.sitemapUrl === `https://${HOST}/a/sitemap.xml` && v.step === null);
  t("…with the robots.txt line and no check yet", v.domains[0]!.robotsLine === `Sitemap: https://${HOST}/a/sitemap.xml` && v.domains[0]!.check === null && v.domains[0]!.parts === 1);
  t("included count from the generator (2)", v.build.ok && v.build.included === 2);
  t("excluded counts by reason (1 draft, 1 without listings)", v.build.ok && v.build.excluded.draft === 1 && v.build.excluded.thin === 1 && v.build.excluded.noindex === 0);
  t("the freshness window is reported (5 minutes)", v.freshnessMinutes === 5);

  seed([domainRow({ status: "ssl_pending" })]);
  const pending = await st.loadSitemapStatus(WS);
  t("a domain still waiting for DNS: no live domain, the step, and no sitemap URL anywhere",
    pending.domains.length === 0 && pending.step?.code === "point_dns" && !JSON.stringify(pending).includes("/a/sitemap.xml"));
  t("…the counts are still shown (they don't depend on the domain)", pending.build.ok && pending.build.included === 2);
  seed([]);
  t("no domain at all → connect", (await st.loadSitemapStatus(WS)).step?.code === "connect");
  seed([domainRow({ connection_type: "subdomain" })]);
  t("a subdomain connection gets no robots.txt line", (await st.loadSitemapStatus(WS)).domains[0]!.robotsLine === null);
  seed([domainRow({ founders_disabled: true })]);
  t("a switched-off domain is not live", (await st.loadSitemapStatus(WS)).step?.code === "domain_paused");

  seed();
  fake.failWhen = (h) => (h.name === "tenant_pages" ? "timeout" : null);
  const broken = await quietly(() => st.loadSitemapStatus(WS));
  fake.failWhen = null;
  t("an incomplete read: no counts, the problem in words, no parts", !broken.build.ok && broken.build.problems.length > 0 && broken.domains[0]!.parts === null);
  fake.failWhen = (h) => (h.name === "workspace_domains" ? "timeout" : null);
  const noDomains = await quietly(() => rejects(st.loadSitemapStatus(WS)));
  fake.failWhen = null;
  t("a failed domain read is a readable error, not an empty state", noDomains === "Couldn't load your domains. Refresh the page to try again.", String(noDomains));
}

console.log("\nrecheck: live matches → healthy, stored");
{
  seed();
  fake.clearHits();
  const { check, saved } = await recheck();
  t("healthy", check.status === "healthy", JSON.stringify(check));
  t("HTTP 200, 2 found of 2 expected, nothing missing or unexpected",
    check.http_status === 200 && check.included === 2 && check.expected === 2 && check.missing_count === 0 && check.unexpected_count === 0 && check.errors.length === 0);
  t("green on screen", st.describeSitemapCheck(check).tone === "ok");
  t("checked_at is the check's time", check.checked_at === new Date(NOW).toISOString());
  t("stored in workspace_domains.sitemap_check (service role)", saved && JSON.stringify(fake.rows("workspace_domains")[0]!.sitemap_check) === JSON.stringify(check));
  const write = fake.hits.find((h) => h.method === "PATCH");
  t("…written to this workspace's row only", write?.name === "workspace_domains" && write.params.get("id") === `eq.${DOMAIN_ID}` && write.params.get("workspace_id") === `eq.${WS}`);
  t("…with every field the screen reads",
    ["checked_at", "status", "http_status", "included", "expected", "missing", "unexpected", "errors"].every((k) => k in (fake.rows("workspace_domains")[0]!.sitemap_check as object)));
  const again = await st.loadSitemapStatus(WS);
  t("the next status load shows the stored check", again.domains[0]!.check?.status === "healthy" && again.domains[0]!.check?.checked_at === check.checked_at);
}

console.log("\nrecheck: every way the live sitemap can be wrong is not green");
{
  seed();
  const dropFirst = (xml: string) => xml.replace(/  <url>.*?<\/url>\n/, "");
  const { check: m } = await recheck({ fetchImpl: live(dropFirst) });
  t("a URL missing from the live sitemap → mismatch, named", m.status === "mismatch" && m.missing_count === 1 && m.missing[0] === URL_A && m.unexpected_count === 0, JSON.stringify(m));
  t("…not green, and explains the 5-minute window", st.describeSitemapCheck(m).tone === "warn" && m.errors.some((e) => /up to 5 minutes/.test(e)));

  const addGhost = (xml: string) => xml.replace("</urlset>", `  <url><loc>https://${HOST}/a/ghost</loc></url>\n</urlset>`);
  const { check: u } = await recheck({ fetchImpl: live(addGhost) });
  t("an unexpected URL in the live sitemap → mismatch, named", u.status === "mismatch" && u.unexpected_count === 1 && u.unexpected[0] === `https://${HOST}/a/ghost` && st.describeSitemapCheck(u).tone !== "ok");

  const doubled = (xml: string) => xml.replace("</urlset>", `  <url><loc>${URL_A}</loc></url>\n</urlset>`);
  const { check: d } = await recheck({ fetchImpl: live(doubled) });
  t("a URL listed twice live → not green", d.status === "invalid" && st.describeSitemapCheck(d).tone !== "ok");

  const { check: f } = await recheck({ fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  t("a network failure → fetch_failed, no HTTP status, not green", f.status === "fetch_failed" && f.http_status === null && f.included === null && st.describeSitemapCheck(f).tone === "error");
  t("…with a sentence naming the URL", /Couldn't reach https:\/\/pools\.example\/a\/sitemap\.xml/.test(f.errors[0] ?? ""), f.errors[0]);

  const { check: nf } = await recheck({ fetchImpl: async () => new Response("not found", { status: 404 }) });
  t("HTTP 404 → fetch_failed with the status", nf.status === "fetch_failed" && nf.http_status === 404 && /HTTP 404/.test(nf.errors[0] ?? ""));

  const { check: rd } = await recheck({ fetchImpl: async () => new Response(null, { status: 301, headers: { location: "https://elsewhere.example/sitemap.xml" } }) });
  t("a redirect is not followed and not green", rd.status === "fetch_failed" && rd.http_status === 301 && /redirects/.test(rd.errors[0] ?? ""));

  const hang: import("../src/lib/sitemap-status.functions").LiveFetch = (_url, init) =>
    new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  const started = Date.now();
  const { check: to } = await recheck({ fetchImpl: hang, timeoutMs: 150 });
  t("a live sitemap that never answers times out → fetch_failed", to.status === "fetch_failed" && /didn't answer within/.test(to.errors[0] ?? "") && Date.now() - started < 2_000);

  const { check: html } = await recheck({ fetchImpl: async () => new Response("<!doctype html><html><body>Welcome</body></html>", { status: 200 }) });
  t("an HTML page where the sitemap should be → invalid, not green", html.status === "invalid" && st.describeSitemapCheck(html).tone === "error");

  const { check: broken } = await recheck({ fetchImpl: live((xml) => xml.replace("<loc>", "<loc>&")) });
  t("malformed live XML (an unescaped &) → invalid", broken.status === "invalid" && /isn't valid/.test(broken.errors[0] ?? ""));
}

console.log("\nrecheck: an incomplete read is never green");
{
  seed();
  fake.failWhen = (h) => (h.name === "tenant_pages" && (h.params.get("id") ?? "").startsWith("gt.") ? "statement timeout" : null);
  const { check } = await quietly(() => recheck());
  fake.failWhen = null;
  t("a page read failing mid-build → incomplete, expected unknown", check.status === "incomplete" && check.expected === null, JSON.stringify(check));
  t("…not green, with the reason in words", st.describeSitemapCheck(check).tone !== "ok" && check.errors.some((e) => /published pages/.test(e)));
  t("…and the live route answered 503 meanwhile (no partial sitemap)", check.http_status === 503);

  seed();
  fake.failWhen = (h) => (h.name === "workspace_domains" && (h.params.get("hostname") ?? "").startsWith("ilike.") ? "timeout" : null);
  const { check: lookup } = await quietly(() => recheck());
  fake.failWhen = null;
  t("a failed host lookup → incomplete, not green", lookup.status === "incomplete" && st.describeSitemapCheck(lookup).tone !== "ok");
}

console.log("\nrecheck: paused, empty, unsaved, refused");
{
  seed();
  fake.update("workspaces", (w) => w.id === WS, { subscription_status: "canceled", current_period_end: "2020-01-01T00:00:00Z" });
  const { check: p } = await recheck();
  t("billing-paused pages: the empty live sitemap matches → 'paused', neutral", p.status === "paused" && p.expected === 0 && st.describeSitemapCheck(p).tone === "neutral");

  seed();
  fake.set("tenant_pages", [pageRow(3, "nowhere-pools", { listing_filter: nowhere })]);
  const { check: e } = await recheck();
  t("nothing eligible: valid and matching, but neutral — never green for an empty sitemap", e.status === "healthy" && e.expected === 0 && st.describeSitemapCheck(e).tone === "neutral");

  seed();
  fake.failWhen = (h) => (h.method === "PATCH" ? "permission denied" : null);
  const unsaved = await quietly(() => recheck());
  fake.failWhen = null;
  t("a failed write still returns the check, marked unsaved", unsaved.saved === false && unsaved.check.status === "healthy");

  seed([domainRow({ status: "ssl_pending" })]);
  const notLive = await rejects(recheck());
  t("a domain that isn't live can't be rechecked (readable reason and next step)", /isn't live yet/.test(notLive ?? "") && /proxy\.founders\.click/.test(notLive ?? ""), String(notLive));
  seed();
  const unknown = await rejects(st.runSitemapRecheck(WS, "dddddddd-0000-4000-8000-00000000ffff", { fetchImpl: live() }));
  t("an unknown domain id is refused", /isn't connected to this workspace/.test(unknown ?? ""));
  const foreign = await rejects(st.runSitemapRecheck(OTHER_WS, DOMAIN_ID, { fetchImpl: live() }));
  t("another workspace's domain id is refused", /isn't connected to this workspace/.test(foreign ?? ""));
}

console.log("\nthe live reader follows an index to its parts on the same host");
{
  const index = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="${sm.SITEMAP_NS}">\n  <sitemap><loc>https://${HOST}/a/sitemap.xml?page=1</loc></sitemap>\n  <sitemap><loc>https://${HOST}/a/sitemap.xml?page=2</loc></sitemap>\n</sitemapindex>\n`;
  const part = (slug: string) => `${sm.URLSET_HEAD}  <url><loc>https://${HOST}/a/${slug}</loc></url>\n${sm.URLSET_TAIL}`;
  const serve = (routes: Record<string, () => Response>): import("../src/lib/sitemap-status.functions").LiveFetch =>
    async (url) => (routes[url] ?? (() => new Response("nope", { status: 404 })))();
  const ok = await st.fetchLiveSitemap(HOST, { fetchImpl: serve({
    [`https://${HOST}/a/sitemap.xml`]: () => new Response(index),
    [`https://${HOST}/a/sitemap.xml?page=1`]: () => new Response(part("one")),
    [`https://${HOST}/a/sitemap.xml?page=2`]: () => new Response(part("two")),
  }) });
  t("an index with two parts → both parts' URLs", ok.ok && ok.parts === 2 && ok.locs.join() === `https://${HOST}/a/one,https://${HOST}/a/two`);
  const offHost = await st.fetchLiveSitemap(HOST, { fetchImpl: serve({
    [`https://${HOST}/a/sitemap.xml`]: () => new Response(index.replace(`https://${HOST}/a/sitemap.xml?page=2`, "https://evil.example/a/sitemap.xml?page=2")),
    [`https://${HOST}/a/sitemap.xml?page=1`]: () => new Response(part("one")),
  }) });
  t("an index naming a part on another host is invalid", !offHost.ok && offHost.failure === "invalid");
  const missingPart = await st.fetchLiveSitemap(HOST, { fetchImpl: serve({
    [`https://${HOST}/a/sitemap.xml`]: () => new Response(index),
    [`https://${HOST}/a/sitemap.xml?page=1`]: () => new Response(part("one")),
  }) });
  t("a part that 404s is a fetch failure", !missingPart.ok && missingPart.failure === "fetch" && missingPart.httpStatus === 404);
  const tooBig = await st.fetchLiveSitemap(HOST, { fetchImpl: serve({
    [`https://${HOST}/a/sitemap.xml`]: () => new Response("x", { headers: { "content-length": String(60 * 1024 * 1024) } }),
  }) });
  t("a live file declaring more than 50 MB is refused unread", !tooBig.ok && /larger than a sitemap may be/.test(tooBig.errors[0] ?? ""));
  t("the default fetch is never used for the live check when one is injected (the fake PostgREST would have thrown)", ok.ok);
}

console.log("\ndownload returns exactly what the live route serves");
{
  seed();
  const dl = await st.buildSitemapDownload(WS, DOMAIN_ID, undefined);
  const served = await sm.tenantSitemapResponse(HOST, "https://www.founders.click/a/sitemap.xml");
  t("the XML is byte-for-byte the served sitemap", dl.xml === served.body && dl.parts === 1);
  t("named for the host", dl.filename === `sitemap-${HOST}.xml`);
  t("a part that doesn't exist is refused", /doesn't exist/.test((await rejects(st.buildSitemapDownload(WS, DOMAIN_ID, 2))) ?? ""));
  fake.failWhen = (h) => (h.name === "tenant_pages" ? "timeout" : null);
  const msg = await quietly(() => rejects(st.buildSitemapDownload(WS, DOMAIN_ID, undefined)));
  fake.failWhen = null;
  t("an incomplete build is never downloaded (a readable refusal instead)", /^Couldn't build your sitemap right now/.test(msg ?? ""), String(msg));
}

console.log("\nmembership comes first");
{
  seed();
  t("a member passes assertWorkspaceMember", (await assertWorkspaceMember(WS, USER)) === "member");
  t("a non-member is refused", /not a member/.test((await rejects(assertWorkspaceMember(OTHER_WS, USER))) ?? ""));
  const src = read("src/lib/sitemap-status.functions.ts");
  for (const [fn, helper] of [["getSitemapStatus", "loadSitemapStatus"], ["recheckSitemap", "runSitemapRecheck"], ["downloadSitemapXml", "buildSitemapDownload"]] as const) {
    const body = src.slice(src.indexOf(`export const ${fn} = createServerFn`));
    const handler = body.slice(body.indexOf(".handler("), body.indexOf("});") + 3);
    t(`${fn}: signed-in callers only`, /\.middleware\(\[requireSupabaseAuth\]\)/.test(body.slice(0, body.indexOf(".handler("))));
    t(`${fn}: the first thing the handler does is assertWorkspaceMember, then ${helper}`,
      /^\.handler\(async \(\{ data, context \}\)[^{]*\{\s*await assertWorkspaceMember\(data\.workspaceId, context\.userId\);\s*return /.test(handler) && handler.includes(`${helper}(`), handler.slice(0, 200));
  }
  t("ids are validated (workspace uuid, domain uuid, page 1–9999)", /workspaceId: workspaceIdSchema, domainId: z\.string\(\)\.uuid\(\)/.test(src) && /page: z\.number\(\)\.int\(\)\.min\(1\)\.max\(9999\)\.optional\(\)/.test(src));
  t("the one write is sitemap_check on this workspace's domain row", (src.match(/\.update\(/g) ?? []).length === 1 && /\.update\(\{ sitemap_check: check \}\)\s*\.eq\("id", d\.id\)\s*\.eq\("workspace_id", workspaceId\)/.test(src));
}

console.log("\nthe screen");
{
  const screen = read("src/routes/_authenticated/app.seo.sitemap.tsx");
  t("no stub: StubToolPage and ?showStubs are gone", !/StubToolPage|showStubs/.test(screen));
  t("it uses the three server functions", ["getSitemapStatus", "recheckSitemap", "downloadSitemapXml"].every((f) => screen.includes(f)) && /from "@\/lib\/sitemap-status\.functions"/.test(screen));
  t(
    "it says changes appear within 5 minutes — not instantly",
    /within\s+\{SITEMAP_FRESHNESS_MINUTES\}\s+minutes/.test(screen) &&
      /within\s+\{view\.freshnessMinutes\}\s+minutes\s+—\s+not\s+instantly/.test(screen),
  );
  t("the URL can be opened and copied", /href=\{d\.sitemapUrl\} target="_blank" rel="noopener noreferrer"/.test(screen) && /<CopyButton text=\{d\.sitemapUrl\}/.test(screen));
  t("it explains robots.txt and Search Console", /robots\.txt/.test(screen) && /Google Search Console/.test(screen) && /<CopyButton text=\{d\.robotsLine\}/.test(screen));
  t("it says we don't submit it, and listed isn't indexed", /doesn't\s+submit\s+your\s+sitemap\s+for\s+you/.test(screen) && /doesn't\s+mean\s+it's\s+indexed/.test(screen));
  t("it never claims a submission or indexing", !/\bsubmitted\b/i.test(screen) && !/(pages|URLs|urls) (are|were|have been) indexed/i.test(screen) && !/instantly(?! —)/.test(screen.replace("— not instantly", "")));
  t("it says the customer's own /sitemap.xml and robots.txt stay theirs", /stay\s+yours;\s+we\s+never\s+replace\s+them/.test(screen));
  const noDomain = screen.slice(screen.indexOf("if (view.domains.length === 0) {"), screen.indexOf("\n  }\n", screen.indexOf("if (view.domains.length === 0) {")));
  t("with no live domain it shows the next step and a link to Settings → Domains — and no URL", /Next step: \{step\.title\}/.test(noDomain) && /to="\/app\/settings\/domains"/.test(noDomain) && !/sitemapUrl/.test(noDomain));
  t("it lists every exclusion reason that has pages", /EXCLUSION_ORDER\.filter\(\(r\) => build\.excluded\[r\] > 0\)/.test(screen));
  t("Recheck and Download are there, with per-part downloads for an index", /"Recheck"/.test(screen) && /Download XML/.test(screen) && /Part \$\{k\}/.test(screen));
  t("an incomplete build is shown as a problem, never as numbers", /if \(!build\.ok\) \{\s*return \(\s*<Notice\s*tone="warn"/.test(screen));
  t("the check's tone comes only from describeSitemapCheck", /const facts = describeSitemapCheck\(c\);/.test(screen) && /<Notice tone=\{facts\.tone\}/.test(screen));
  t("errors reach the owner through userMessage", (screen.match(/userMessage\(e, /g) ?? []).length >= 3);
}

done();
