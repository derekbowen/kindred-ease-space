/**
 * PUBLISHING AND EDITING, DRIVEN. Run: bun tests/page-publish-flow.test.ts
 *
 * The real publish/edit code (src/lib/page-publish.server.ts) through the real
 * supabase-js client against the in-memory PostgREST
 * (tests/_support/fake-postgrest.ts). publish_tenant_page_checked is played by
 * a JS twin of the SQL; the SQL itself is proven on PostgreSQL 16 by
 * tests/mvp-migrations.pg.ts (section 6).
 *
 * What is proven:
 *   - a draft goes live only with an ACTIVE verified domain; otherwise the
 *     owner gets the exact remaining step and no URL;
 *   - template, filter, inventory and text are checked before the flip; a
 *     failing draft stays a draft and every problem is named with its fix;
 *   - the version the owner reviewed is the version that goes live;
 *   - a rejected edit to a live page writes NOTHING (byte-for-byte);
 *   - a live page's address never changes; a draft's can, but not onto
 *     another page's;
 *   - plan capacity is explained honestly (limit vs not allowed to publish);
 *   - the live URL is fetched and reported reachable only when the page's own
 *     canonical comes back;
 *   - another workspace can't act on the page at all.
 */
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";

import { FakeDb } from "./_support/fake-postgrest";
import { listingKeys, makeFilter, scopeFor } from "../src/lib/coverage/target";
import { contractJson } from "../src/lib/templates/contracts";

const db = new FakeDb();
db.install("supabase.test");

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

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const austin = makeFilter(
  scopeFor("city_hub", false),
  listingKeys({ country: "US", state: "TX", city: "Austin" }),
  { country: "US", region: "TX", city: "Austin" },
);
const BODY =
  "## Choosing a pool\n\n" +
  "Specific, useful guidance about private pools you can rent in Austin by the hour. ".repeat(6);

let capacity = { limit: 10, publish: true };

function seed() {
  db.tables = {};
  db.hits = [];
  db.beforeWrite = undefined;
  db.uniques = {
    tenant_pages: [
      { name: "tenant_pages_workspace_id_slug_key", columns: ["workspace_id", "slug"] },
      {
        name: "tenant_pages_live_target_uidx",
        columns: ["workspace_id", "target_key"],
        where: (r) => r.status !== "archived",
      },
    ],
  };
  db.embeds = {
    tenant_pages: {
      page_templates: { table: "page_templates", fk: "template_id" },
      workspaces: { table: "workspaces", fk: "workspace_id" },
    },
  };
  for (const kind of ["city_hub", "category_page", "resource_article"] as const) {
    db.insertRow("page_templates", {
      id: `tpl-${kind}`,
      slug: kind,
      name: kind,
      is_active: true,
      config_schema: contractJson(kind),
    });
  }
  const k = listingKeys({ country: "US", state: "TX", city: "Austin", category: "Pool" });
  for (let i = 0; i < 5; i++) {
    db.insertRow("tenant_listings", {
      workspace_id: WS,
      state_published: true,
      title: `Pool ${i}`,
      city: "Austin",
      state: "TX",
      country: "US",
      category: "Pool",
      price_amount: 4500,
      price_currency: "USD",
      price_unit: "hour",
      synced_at: "2026-09-28T10:00:00Z",
      country_key: k.countryKey,
      region_key: k.regionKey,
      city_key: k.cityKey,
      category_key: k.categoryKey,
    });
  }
  db.insertRow("workspaces", {
    id: WS,
    name: "Pools",
    plan: "growth",
    subscription_status: "canceled",
    current_period_end: "2026-01-01T00:00:00Z",
    page_limit_base: 10,
    page_limit_addon: 0,
    page_limit_bonus: 0,
  });
  capacity = { limit: 10, publish: true };
  db.rpcs = {
    publish_tenant_page_checked: (a) => {
      const page = db
        .table("tenant_pages")
        .find((p) => p.id === a._page_id && p.workspace_id === a._workspace_id);
      if (!page) return { result: "not_found" };
      if (page.status === "published") return { result: "already_published" };
      if (page.status !== "draft") return { result: "not_draft", status: page.status };
      if (page.content_version !== a._expected_version)
        return { result: "version_conflict", version: page.content_version };
      if (!capacity.publish) return { result: "not_entitled", limit: 0 };
      const published = db
        .table("tenant_pages")
        .filter((p) => p.workspace_id === a._workspace_id && p.status === "published").length;
      if (published >= capacity.limit)
        return { result: "limit_reached", limit: capacity.limit, published };
      page.status = "published";
      page.published_at ??= new Date().toISOString();
      return { result: "published", limit: capacity.limit, published: published + 1 };
    },
    workspace_granted_pages: () => 0,
    workspace_is_internal_unlimited: () => false,
  };
}

function page(over: Record<string, unknown> = {}) {
  return db.insertRow("tenant_pages", {
    workspace_id: WS,
    template_id: "tpl-city_hub",
    slug: "pools-austin-tx",
    title: "Private pools in Austin, TX",
    h1: "Private pools in Austin, TX",
    seo_title: "Private pools in Austin, TX",
    meta_description:
      "Compare private pools you can rent by the hour in Austin, Texas, and book directly with local hosts.",
    body_markdown: BODY,
    listing_filter: austin,
    variables: { city: "Austin", state: "TX" },
    target_key: "city_hub::country=us|region=tx|city=austin",
    status: "draft",
    noindex: false,
    content_version: 2,
    generation: {
      state: "ready",
      request_id: "r1",
      tier: "standard",
      source: "builder",
      started_at: "2026-09-28T10:00:00Z",
    },
    published_at: null,
    updated_at: "2026-09-28T10:00:00Z",
    created_at: "2026-09-28T10:00:00Z",
    ...over,
  });
}
function domain(over: Record<string, unknown> = {}) {
  return db.insertRow("workspace_domains", {
    workspace_id: WS,
    hostname: "pages.pools.example",
    verified: true,
    status: "active",
    route_prefix: "/a/",
    last_error: null,
    activated_at: "2026-09-20T00:00:00Z",
    created_at: "2026-09-19T00:00:00Z",
    ...over,
  });
}
const fields = (over: Record<string, unknown> = {}) => ({
  title: "Private pools in Austin, TX",
  h1: "Private pools in Austin, TX",
  seoTitle: "Private pools in Austin, TX",
  metaDescription:
    "Compare private pools you can rent by the hour in Austin, Texas, and book directly with local hosts.",
  slug: "pools-austin-tx",
  bodyMarkdown: BODY,
  listingLimit: 24,
  noindex: false,
  ...over,
});
const liveHtml = (url: string) =>
  `<html><head><link rel="canonical" href="${url}"></head><body>ok</body></html>`;
const okFetch = (async (u: any) =>
  new Response(liveHtml(String(u)), { status: 200 })) as typeof fetch;

const P = await import("../src/lib/page-publish.server");

console.log("\n1. Publishing needs an active domain, and says the exact step when it isn't");
seed();
{
  const p = page();
  const noDomain = await P.publishDraft(WS, p.id, 2, { fetchImpl: okFetch });
  t(
    "no domain: refused, with the connect step and no URL",
    !noDomain.ok &&
      noDomain.code === "domain_not_ready" &&
      /Connect a domain in Settings → Domains/.test(noDomain.step ?? "") &&
      !("liveUrl" in noDomain),
  );
  domain({ verified: false, status: "verification_required" });
  const unverified = await P.publishDraft(WS, p.id, 2, { fetchImpl: okFetch });
  t(
    "unverified: the TXT step for that hostname",
    !unverified.ok &&
      /Verify that you own pages\.pools\.example: add the TXT record/.test(unverified.step ?? ""),
  );
  db.table("workspace_domains")[0]!.verified = true;
  db.table("workspace_domains")[0]!.status = "ssl_pending";
  db.table("workspace_domains")[0]!.last_error = "HTTP 525 from /a/founders-domain-test";
  const pending = await P.publishDraft(WS, p.id, 2, { fetchImpl: okFetch });
  t(
    "verified but not routed: the CNAME step, with the last check's error",
    !pending.ok &&
      /Point pages\.pools\.example at proxy\.founders\.click with a CNAME record/.test(
        pending.step ?? "",
      ) &&
      /HTTP 525/.test(pending.step ?? ""),
  );
  t("…and the page is still a draft", db.table("tenant_pages")[0]!.status === "draft");
  t(
    "no publish RPC was called while the domain wasn't ready",
    db.hitsOf("POST", "rpc/publish_tenant_page_checked").length === 0,
  );
}

{
  // The emergency kill switch on an active domain: nothing is published to a
  // host whose /a/* traffic goes to the customer's own site.
  const r = P.domainStep([
    {
      hostname: "pages.pools.example",
      verified: true,
      status: "active",
      route_prefix: "/a/",
      last_error: null,
      activated_at: "2026-09-20T00:00:00Z",
      created_at: "2026-09-19T00:00:00Z",
      founders_disabled: true,
    },
  ]);
  t(
    "a domain switched off by the kill switch is not ready, and says why",
    !r.ready && /switched off/.test(r.step) && r.hostname === "pages.pools.example",
  );
}

console.log("\n2. A valid draft goes live at the reviewed version, and the URL is checked");
seed();
{
  domain();
  const p = page();
  const stale = await P.publishDraft(WS, p.id, 1, { fetchImpl: okFetch });
  t(
    "a stale version is refused (the owner reviewed something else)",
    !stale.ok && stale.code === "conflict",
  );
  const r = await P.publishDraft(WS, p.id, 2, { fetchImpl: okFetch });
  t("published", r.ok && r.status === "published", JSON.stringify(r));
  t(
    "the live URL is the verified host's /a/ path",
    r.ok && r.liveUrl === "https://pages.pools.example/a/pools-austin-tx",
  );
  t("reachable: the page's own canonical came back", r.ok && r.reachable?.reachable === true);
  t(
    "publishing again: already live",
    !(await P.publishDraft(WS, p.id, 2, { fetchImpl: okFetch })).ok,
  );
}
seed();
{
  domain();
  const p = page();
  const wrongPage = (async () =>
    new Response("<html>marketplace home</html>", { status: 200 })) as unknown as typeof fetch;
  const r = await P.publishDraft(WS, p.id, 2, { fetchImpl: wrongPage });
  t(
    "a 200 without the page's canonical is NOT called reachable",
    r.ok && r.reachable?.reachable === false && /not with this page/.test(r.reachable.detail),
  );
  const down = await P.probeLiveUrl("https://x.example/a/y", (async () => {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  }) as unknown as typeof fetch);
  t("a timeout is reported as a timeout", !down.reachable && /timed out/.test(down.detail));
}

console.log("\n3. What stops a draft from going live (each named, with its fix)");
for (const [name, over, code] of [
  ["no description", { meta_description: null }, "description_missing"],
  ["text under the template minimum", { body_markdown: "Too short." }, "body_too_short"],
  [
    "a City Hub whose filter names only a city",
    { listing_filter: makeFilter(["city"], listingKeys({ city: "Austin" }), { city: "Austin" }) },
    "missing_country",
  ],
  ["an inactive template", {}, "template_unavailable"],
] as const) {
  seed();
  domain();
  if (code === "template_unavailable")
    db.table("page_templates").find((x) => x.slug === "city_hub")!.is_active = false;
  const p = page(over as Record<string, unknown>);
  const r = await P.publishDraft(WS, p.id, 2, { fetchImpl: okFetch });
  t(
    `${name}: refused with ${code}`,
    !r.ok && r.code === "invalid" && !!r.problems?.some((x) => x.code === code),
    JSON.stringify(!r.ok && r.problems),
  );
  t(
    `${name}: still a draft, nothing flipped`,
    db.table("tenant_pages")[0]!.status === "draft" &&
      db.hitsOf("POST", "rpc/publish_tenant_page_checked").length === 0,
  );
}
seed();
{
  domain();
  db.tables.tenant_listings = db.table("tenant_listings").slice(0, 2);
  const p = page();
  const r = await P.publishDraft(WS, p.id, 2, { fetchImpl: okFetch });
  t(
    "inventory that dropped below 3 blocks the publish",
    !r.ok && !!r.problems?.some((x) => x.code === "not_enough_listings"),
  );
}
seed();
{
  domain();
  page({
    slug: "first",
    status: "published",
    target_key: "city_hub::country=us|region=tx|city=elsewhere",
  });
  const p = page({ slug: "second" });
  const r = await P.publishDraft(WS, p.id, 2, { fetchImpl: okFetch });
  t(
    "a duplicate title of a live page blocks it",
    !r.ok && !!r.problems?.some((x) => x.code === "duplicate_title"),
  );
}

console.log("\n4. Capacity is explained honestly");
seed();
{
  domain();
  capacity = { limit: 1, publish: true };
  page({
    slug: "live-one",
    status: "published",
    title: "Another live page title here",
    meta_description:
      "Another page's description, different from this one in every way that matters.",
    target_key: "x",
  });
  const p = page();
  const r = await P.publishDraft(WS, p.id, 2, { fetchImpl: okFetch });
  t(
    "limit reached: says how many and what to do, stays a draft",
    !r.ok &&
      r.code === "limit_reached" &&
      /allows 1 published page/.test(r.message) &&
      db.table("tenant_pages").find((x) => x.id === p.id)!.status === "draft",
  );
  capacity = { limit: 10, publish: false };
  const r2 = await P.publishDraft(WS, p.id, 2, { fetchImpl: okFetch });
  t(
    "not allowed to publish: the billing reason, never a '0-page limit'",
    !r2.ok &&
      r2.code === "not_entitled" &&
      !/0-page/.test(r2.message) &&
      /Billing/.test(r2.message),
    !r2.ok ? r2.message : "",
  );
}

console.log("\n5. Live edits: validated first; a rejected edit writes nothing");
seed();
{
  domain();
  const p = page({ status: "published", published_at: "2026-09-28T11:00:00Z" });
  const before = JSON.stringify(db.table("tenant_pages")[0]);
  const bad = await P.saveLiveFields(WS, p.id, 2, fields({ metaDescription: "" }));
  t(
    "an edit that fails the contract is refused with its problems",
    !bad.ok &&
      bad.code === "invalid" &&
      /live page is unchanged/.test(bad.message) &&
      !!bad.problems?.length,
  );
  t(
    "…and the live row is byte-for-byte unchanged",
    JSON.stringify(db.table("tenant_pages")[0]) === before,
  );
  t("no write reached the database", db.hitsOf("PATCH", "tenant_pages").length === 0);
  const slug = await P.saveLiveFields(WS, p.id, 2, fields({ slug: "new-address" }));
  t("a live page's address can't change", !slug.ok && slug.code === "slug_locked");
  const good = await P.saveLiveFields(WS, p.id, 2, fields({ h1: "Rent a private pool in Austin" }));
  t(
    "a valid edit saves and moves the version on",
    good.ok &&
      good.version === 3 &&
      db.table("tenant_pages")[0]!.h1 === "Rent a private pool in Austin",
  );
  const stale = await P.saveLiveFields(WS, p.id, 2, fields());
  t(
    "a second save from the old version is a conflict, not an overwrite",
    !stale.ok && stale.code === "conflict",
  );
  t("the live page stayed live throughout", db.table("tenant_pages")[0]!.status === "published");
}

console.log("\n6. Drafts, lifecycle and ownership");
seed();
{
  const p = page();
  page({ slug: "taken", target_key: "other", title: "Taken" });
  const clash = await P.saveDraftFields(WS, p.id, 2, fields({ slug: "taken" }));
  t("a draft can't take another page's address", !clash.ok && clash.code === "slug_taken");
  const ok = await P.saveDraftFields(
    WS,
    p.id,
    2,
    fields({ slug: "pools-in-austin", listingLimit: 12, bodyMarkdown: "Work in progress." }),
  );
  t(
    "a draft saves incomplete work (no publish checks) and its listing limit",
    ok.ok &&
      db.table("tenant_pages")[0]!.slug === "pools-in-austin" &&
      (db.table("tenant_pages")[0]!.listing_filter as any).limit === 12,
  );
  db.table("tenant_pages")[0]!.generation = {
    state: "generating",
    request_id: "r9",
    tier: "standard",
    source: "builder",
    started_at: new Date().toISOString(),
  };
  const busy = await P.saveDraftFields(WS, p.id, 3, fields());
  t(
    "a draft being written can't be edited underneath the writer",
    !busy.ok && busy.code === "generating",
  );
}
seed();
{
  domain();
  const p = page({ status: "published" });
  t("a live page can't be deleted", !(await P.deleteDraft(WS, p.id)).ok);
  const un = await P.unpublishPage(WS, p.id);
  t("unpublish returns it to a draft", un.ok && db.table("tenant_pages")[0]!.status === "draft");
  const ar = await P.archivePage(WS, p.id);
  t(
    "archive takes it out of coverage",
    ar.ok && db.table("tenant_pages")[0]!.status === "archived",
  );
  t(
    "an archived page is never published",
    !(await P.publishDraft(WS, p.id, 2, { fetchImpl: okFetch })).ok,
  );
  page({ slug: "replacement", title: "Replacement Austin page" });
  const re = await P.restorePage(WS, p.id);
  t(
    "restoring over a newer page for the same target is refused, plainly",
    !re.ok && re.code === "target_taken",
  );
  const del = await P.deleteDraft(WS, p.id);
  t(
    "an archived page can be deleted",
    del.ok && !db.table("tenant_pages").some((x) => x.id === p.id),
  );
}
seed();
{
  domain();
  const p = page();
  const acts = [
    await P.publishDraft(OTHER, p.id, 2, { fetchImpl: okFetch }),
    await P.saveDraftFields(OTHER, p.id, 2, fields()),
    await P.saveLiveFields(OTHER, p.id, 2, fields()),
    await P.archivePage(OTHER, p.id),
    await P.restorePage(OTHER, p.id),
    await P.deleteDraft(OTHER, p.id),
  ];
  t(
    "another workspace gets not_found for every action",
    acts.every((a) => !a.ok && a.code === "not_found"),
    JSON.stringify(acts.map((a) => (a.ok ? "ok" : a.code))),
  );
  const un = await P.unpublishPage(OTHER, p.id);
  t("…including unpublish", !un.ok);
  t(
    "and the page is untouched",
    db.table("tenant_pages")[0]!.status === "draft" &&
      db.table("tenant_pages")[0]!.content_version === 2,
  );
  const list = await P.listPages(WS);
  t(
    "My Pages lists the workspace's pages with their template",
    list.length === 1 && list[0]!.kind === "city_hub",
  );
  t("…and not another workspace's", (await P.listPages(OTHER)).length === 0);
  // An abandoned claim is shown as interrupted, never "being written".
  db.table("tenant_pages")[0]!.generation = {
    state: "generating",
    request_id: "r2",
    tier: "standard",
    source: "builder",
    started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
  };
  const stale = (await P.listPages(WS))[0]!;
  t(
    "My Pages shows an abandoned draft run as failed (interrupted), not being written",
    stale.generating === false &&
      stale.generationState === "failed" &&
      /interrupted/.test(stale.generationError ?? ""),
  );
}

console.log("\n6b. The title-length warning is about the title search results show");
seed();
{
  const long = "Private pool rentals by the hour in Austin, Texas, for parties"; // 62
  const withSeo = page({ title: long, h1: long, seo_title: "Private pools in Austin, TX" });
  const row1 = (await P.loadEditorPage(WS, withSeo.id))!;
  const c1 = await P.checkStoredPage(WS, row1);
  t(
    "a long page title with a short search title set: no truncation warning",
    !c1.warnings.some((w) => w.code === "title_long" || w.code === "seo_title_long"),
    JSON.stringify(c1.warnings),
  );
  db.table("tenant_pages")[0]!.seo_title = null;
  const row2 = (await P.loadEditorPage(WS, withSeo.id))!;
  const c2 = await P.checkStoredPage(WS, row2);
  t(
    "…without a search title the page title is what shows, and it warns",
    c2.warnings.some((w) => w.code === "title_long"),
    JSON.stringify(c2.warnings),
  );
}

console.log("\n7. Every slug the app makes is one the editor accepts");
{
  const { slugifyPage, findUniqueTenantSlug, PAGE_SLUG_MAX } =
    await import("../src/lib/tenant-page-helpers.server");
  const title =
    "A complete guide to renting a private pool for a birthday party this summer for families";
  const base = slugifyPage(title);
  t(
    "a long title's slug is cut without a trailing dash, and the editor accepts it",
    base.length <= PAGE_SLUG_MAX &&
      !base.endsWith("-") &&
      P.PageFieldsSchema.safeParse(fields({ slug: base })).success,
    base,
  );
  page({ slug: base, target_key: null, status: "archived" });
  const next = await findUniqueTenantSlug(WS, base);
  t(
    "a suffixed slug still fits (base cut to leave room for -N) and is accepted",
    next !== base &&
      next.length <= PAGE_SLUG_MAX &&
      /-2$/.test(next) &&
      P.PageFieldsSchema.safeParse(fields({ slug: next })).success,
    next,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
