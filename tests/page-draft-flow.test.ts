/**
 * THE DRAFT PIPELINE, DRIVEN. Run: bun tests/page-draft-flow.test.ts
 *
 * Runs the real runPageDraft (src/lib/page-drafts.server.ts) through the
 * real supabase-js client against an in-memory PostgREST
 * (tests/_support/fake-postgrest.ts, with the same unique indexes as
 * production: slug, one live page per target, one page per generation
 * request) and a fake OpenAI Responses API. The workspace is BYOK so money
 * stays out of the way (tests/ai-spend-sql.test.ts runs the money SQL).
 *
 * What is proven:
 *   - each template stores ITS template id, a v2 filter and the target key;
 *     the prompt carries the exact count, not a sample size;
 *   - every refusal that can be decided early costs nothing: no slot, no
 *     hold, no provider call, no row;
 *   - the draft row is claimed BEFORE the provider call and filled in before
 *     settlement; generation_request_id is written only on delivery;
 *   - an existing page for the target is returned instead of generating;
 *     two racing requests for one target make one page and one provider call;
 *   - a provider failure keeps the draft (failed, with a customer sentence);
 *     regenerating fills the SAME row; a refusal before the provider call
 *     removes the empty row it created;
 *   - replay by request id never calls the provider again;
 *   - drafts only: a published page is never regenerated.
 */
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
delete process.env.OPENAI_API_KEY;

import { FakeDb } from "./_support/fake-postgrest";
import { listingKeys, makeFilter, scopeFor } from "../src/lib/coverage/target";
import { contractJson } from "../src/lib/templates/contracts";

const db = new FakeDb();

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

// ---- OpenAI ---------------------------------------------------------------------
const BODY =
  "## Why rent here\n\n" +
  "Useful, specific copy grounded in the listings shown on this page. ".repeat(14);
let openaiCalls: any[] = [];
let openaiBehavior: "ok" | "error" | "thin" | "slow-then-ok" = "ok";
let onOpenAi: (() => void) | null = null;
function okResponse(page: Record<string, unknown>) {
  return Response.json({
    id: "resp_1",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-5-nano-2025-08-07",
    output: [
      {
        type: "message",
        id: "msg_1",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(page), annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 900,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1100,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2000,
    },
  });
}
const openaiFetch = (async (input: any, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  if (url.hostname !== "api.openai.com") throw new TypeError(`unexpected host ${url.host}`);
  const body = JSON.parse(String(init?.body ?? "{}"));
  openaiCalls.push(body);
  onOpenAi?.();
  if (openaiBehavior === "error")
    return new Response(JSON.stringify({ error: { message: "upstream broke" } }), { status: 500 });
  const page = {
    title: "A better title from the writer",
    seo_title: "Pools in Austin, TX — book a private pool",
    seo_description:
      "Compare private pools in Austin, TX by price per hour and book directly with hosts on the marketplace.",
    body_markdown: openaiBehavior === "thin" ? "Too short." : BODY,
  };
  return okResponse(page);
}) as typeof fetch;
db.install("supabase.test", openaiFetch);

// ---- The workspace --------------------------------------------------------------
const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "99999999-9999-4999-8999-999999999999";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
      {
        name: "tenant_pages_generation_request_uidx",
        columns: ["workspace_id", "generation_request_id"],
      },
    ],
  };
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
  const listing = (
    i: number,
    o: {
      country?: string | null;
      state?: string | null;
      city?: string | null;
      category?: string | null;
      price?: number | null;
      unit?: string | null;
      ws?: string;
    },
  ) => {
    const k = listingKeys({
      country: o.country,
      state: o.state,
      city: o.city,
      category: o.category,
    });
    db.insertRow("tenant_listings", {
      workspace_id: o.ws ?? WS,
      state_published: true,
      title: `Listing ${i}`,
      description: null,
      price_amount: o.price ?? null,
      price_currency: o.price === null ? null : "USD",
      price_unit: o.unit ?? "hour",
      city: o.city ?? null,
      state: o.state ?? null,
      country: o.country ?? null,
      category: o.category ?? null,
      images: [],
      marketplace_url: `https://market.example/l/${i}`,
      structured_data: null,
      synced_at: `2026-09-28T10:${String(i).padStart(2, "0")}:00Z`,
      country_key: k.countryKey,
      region_key: k.regionKey,
      city_key: k.cityKey,
      category_key: k.categoryKey,
    });
  };
  for (let i = 0; i < 7; i++)
    listing(i, {
      country: "US",
      state: "TX",
      city: "Austin",
      category: "Pool",
      price: 2500 + i * 1000,
    });
  for (let i = 7; i < 9; i++)
    listing(i, { country: "US", state: "OR", city: "Portland", category: "Pool", price: 4000 });
  for (let i = 9; i < 12; i++) listing(i, { category: "pool-spa", price: null });
  for (let i = 12; i < 20; i++)
    listing(i, {
      country: "US",
      state: "TX",
      city: "Austin",
      category: "Pool",
      price: 9999,
      ws: OTHER_WS,
    });
  db.insertRow("workspaces", {
    id: WS,
    name: "Pool Rental Near Me",
    brand_name: null,
    plan: "growth",
    subscription_status: "active",
    trial_ends_at: null,
    current_period_end: new Date(Date.now() + 20 * 86400_000).toISOString(),
    page_limit_base: 100,
    page_limit_addon: 0,
    page_limit_bonus: 0,
    page_bonus_expires_at: null,
  });
  db.insertRow("platform_settings", { key: "generation_paused", value: false });
  db.insertRow("platform_settings", { key: "generation_daily_cap", value: 50 });

  const slots = new Map<string, { marked: boolean }>();
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
          currencies: [],
          price_units: [],
          unkeyed_count: 0,
        };
        g.listing_count++;
        groups.set(key, g);
      }
      return [...groups.values()];
    },
    workspace_granted_pages: () => 0,
    workspace_is_internal_unlimited: () => internalUnlimited,
    tenant_get_workspace_secret: () => "sk-byok-test",
    reserve_generation_slot: (a) => {
      reserveCaps.push(a._cap);
      const s = slots.get(a._request_id);
      if (s) return s.marked ? "consumed" : "in_progress";
      slots.set(a._request_id, { marked: false });
      return "reserved";
    },
    mark_generation_provider_called: (a) => {
      const s = slots.get(a._request_id);
      if (!s || s.marked) return false;
      s.marked = true;
      return true;
    },
    release_generation_slot: (a) => {
      const s = slots.get(a._request_id);
      if (s && !s.marked) slots.delete(a._request_id);
      releases.push(a._request_id);
      return true;
    },
    ai_reserve: () => aiReserve(),
    ai_mark_called: () => true,
    ai_release: () => true,
    ai_settle: (a: any) => {
      settles.push(a);
      return {
        status: "settled",
        billing: "byok",
        credits_charged: 0,
        cost_micros: a._cost_micros,
        full_hold: a._cost_micros === null,
      };
    },
  };
  openaiCalls = [];
  openaiBehavior = "ok";
  onOpenAi = null;
  reserveCaps = [];
  releases = [];
  settles = [];
  internalUnlimited = false;
  aiReserve = () => ({ status: "reserved", billing: "byok", hold_seq: 1, credits_charged: 0 });
}
let reserveCaps: number[] = [];
let releases: string[] = [];
let settles: any[] = [];
let internalUnlimited = false;
let aiReserve: () => unknown = () => null;

const {
  runPageDraft,
  draftStatus,
  DRAFT_NOT_EDITABLE_MESSAGE,
  DRAFT_INTERRUPTED_MESSAGE,
  DRAFT_CHANGED_MESSAGE,
  effectiveGeneration,
  isGenerationActive,
  notEnoughListingsMessage,
} = await import("../src/lib/page-drafts.server");
const { CustomerFacingError, GENERATION_IN_PROGRESS_MESSAGE, GENERATION_PAUSED_MESSAGE } =
  await import("../src/lib/generation.server");

const austin = makeFilter(
  scopeFor("city_hub", false),
  listingKeys({ country: "US", state: "TX", city: "Austin" }),
  { country: "US", region: "TX", city: "Austin" },
);
const portland = makeFilter(
  scopeFor("city_hub", false),
  listingKeys({ country: "US", state: "OR", city: "Portland" }),
  { country: "US", region: "OR", city: "Portland" },
);
const poolSpa = makeFilter(["category"], listingKeys({ category: "pool-spa" }), {
  category: "pool-spa",
});
const article = makeFilter([], listingKeys({}));

let n = 0;
const rid = () => `22222222-2222-4222-8222-${String(++n).padStart(12, "0")}`;
const pages = () => db.table("tenant_pages").filter((p) => p.workspace_id === WS);
const slotCalls = () => db.hitsOf("POST", "rpc/reserve_generation_slot").length;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function draft(over: Record<string, unknown> = {}) {
  try {
    const r = await runPageDraft({
      workspaceId: WS,
      userId: USER,
      requestId: rid(),
      tier: "standard",
      mode: "new",
      kind: "city_hub",
      filter: austin,
      title: "Private pools in Austin, TX",
      description: "Browse private pools you can rent by the hour in Austin, Texas.",
      brief: "Most hosts offer pools with a shaded patio.",
      ...over,
    } as any);
    return { r, err: null as unknown };
  } catch (e) {
    return { r: null, err: e };
  }
}

const origError = console.error;
const origWarn = console.warn;
console.error = () => {};
console.warn = () => {};

try {
  console.log("\n1. A City Hub: claimed first, filled on delivery, its own template");
  seed();
  {
    let rowAtProviderCall: any = null;
    onOpenAi = () => {
      rowAtProviderCall = structuredClone(pages()[0] ?? null);
    };
    const { r, err } = await draft();
    t("the draft is ready", r?.outcome === "ready", errMsg(err));
    const row = pages()[0]!;
    t("exactly one row", pages().length === 1);
    t(
      "the row existed BEFORE the provider call, claimed as generating",
      rowAtProviderCall?.generation?.state === "generating" &&
        rowAtProviderCall?.body_markdown === null,
    );
    t(
      "the claim did not carry generation_request_id (the slot would read it as consumed)",
      rowAtProviderCall?.generation_request_id == null,
    );
    t("the City Hub template id is stored", row.template_id === "tpl-city_hub");
    t(
      "the v2 filter is stored as given",
      JSON.stringify(row.listing_filter) === JSON.stringify(austin),
    );
    t(
      "the target key is stored",
      row.target_key === "city_hub::country=us|region=tx|city=austin",
      row.target_key,
    );
    t(
      "the body, SEO title and description are persisted",
      row.body_markdown === BODY.trim() &&
        row.seo_title === "Pools in Austin, TX — book a private pool" &&
        /Compare private pools/.test(row.meta_description),
    );
    t(
      "the owner's title is the H1; the writer's is kept as a suggestion",
      row.title === "Private pools in Austin, TX" &&
        row.h1 === row.title &&
        row.generation.suggested_title === "A better title from the writer",
    );
    t(
      "generation_request_id is written on delivery",
      typeof row.generation_request_id === "string",
    );
    t("the version moved on (claim 1 → content 2)", row.content_version === 2);
    t("it is a draft — nothing publishes itself", row.status === "draft");
    t(
      "usage and spend are recorded on the draft",
      row.generation.state === "ready" &&
        row.generation.input_tokens === 900 &&
        row.generation.billing === "free" &&
        typeof row.generation.elapsed_ms === "number",
    );
    const prompt = String(openaiCalls[0]?.input ?? "");
    t(
      "the prompt has the EXACT count for Austin (7), not other workspaces' listings",
      /Published listings matching this page: 7 \(exact count/.test(prompt),
      prompt.slice(0, 400),
    );
    t(
      "prices are per unit: $25 – $85 per hour",
      prompt.includes("USD per hour: $25 – $85 (7 listings)"),
    );
    t(
      "the owner's brief is included as notes",
      prompt.includes("Most hosts offer pools with a shaded patio."),
    );
    t(
      "the builder's system prompt is used",
      /Never say or imply that anything is available/.test(
        String(openaiCalls[0]?.instructions ?? ""),
      ),
    );
    t("one provider call, one settlement", openaiCalls.length === 1 && settles.length === 1);
  }

  console.log("\n2. Category Page and Resource Article keep their own templates");
  seed();
  {
    const cat = await draft({ kind: "category_page", filter: poolSpa, title: "Pool spa rentals" });
    t(
      "category page: ready with the category template",
      cat.r?.outcome === "ready" && pages()[0]?.template_id === "tpl-category_page",
      errMsg(cat.err),
    );
    t(
      "category page: target key by category",
      pages()[0]?.target_key === "category_page::category=pool-spa",
    );
    const art = await draft({
      kind: "resource_article",
      filter: article,
      title: "How to choose a private pool for a party",
    });
    const artRow = pages().find((p) => p.template_id === "tpl-resource_article");
    t(
      "resource article: ready with its own template and no target key",
      art.r?.outcome === "ready" && artRow?.target_key === null,
      errMsg(art.err),
    );
    t(
      "resource article prompt covers the whole marketplace (12 listings)",
      /Published listings matching this page: 12 /.test(String(openaiCalls[1]?.input ?? "")),
    );
  }

  console.log("\n3. Refusals decided early cost nothing");
  for (const [name, over, expect] of [
    [
      "a City Hub naming only a city",
      { filter: makeFilter(["city"], listingKeys({ city: "Austin" }), { city: "Austin" }) },
      /full location|city, region and country/,
    ],
    [
      "a target with 2 listings (Portland, OR)",
      { filter: portland, title: "Pools in Portland, Oregon" },
      /Only 2 published listings/,
    ],
    [
      "a Resource Article tied to a place",
      { kind: "resource_article", filter: austin },
      /isn't tied to one location/,
    ],
    ["a broken v2 filter", { filter: { v: 2, scope: ["city"] } }, /isn't valid/],
    ["an underivable slug", { slug: "---", title: "!!!" }, /title|address/],
  ] as const) {
    seed();
    const { r, err } = await draft(over as any);
    t(
      `${name}: refused with a customer sentence`,
      !r && err instanceof CustomerFacingError && expect.test(errMsg(err)),
      errMsg(err),
    );
    t(
      `${name}: no slot, no provider, no row`,
      slotCalls() === 0 && openaiCalls.length === 0 && pages().length === 0,
    );
  }
  seed();
  {
    db.table("page_templates").find((x) => x.slug === "category_page")!.is_active = false;
    const { err } = await draft({
      kind: "category_page",
      filter: poolSpa,
      title: "Pool spa rentals",
    });
    t(
      "an inactive template is refused (never drawn as a City Hub)",
      err instanceof CustomerFacingError &&
        /template isn't available/.test(errMsg(err)) &&
        slotCalls() === 0,
    );
  }
  seed();
  {
    db.table("platform_settings").find((x) => x.key === "generation_paused")!.value = true;
    const { err } = await draft();
    t(
      "the pause switch refuses before any slot",
      errMsg(err) === GENERATION_PAUSED_MESSAGE && slotCalls() === 0 && pages().length === 0,
    );
  }
  seed();
  {
    const w = db.table("workspaces")[0]!;
    w.subscription_status = "canceled";
    w.current_period_end = new Date(Date.now() - 40 * 86400_000).toISOString();
    const { err } = await draft();
    t(
      "a lapsed plan cannot draft (nothing reserved or spent)",
      err instanceof CustomerFacingError &&
        /Billing/.test(errMsg(err)) &&
        slotCalls() === 0 &&
        openaiCalls.length === 0,
      errMsg(err),
    );
  }
  t(
    "notEnoughListingsMessage says zero honestly",
    /No published listings match/.test(notEnoughListingsMessage("city_hub", 0)),
  );

  console.log("\n4. One page per target");
  seed();
  {
    const first = await draft();
    const again = await draft({ title: "Another Austin pool page" });
    t(
      "a second request for the target returns the existing page",
      again.r?.outcome === "exists" && again.r.page.id === (first.r as any).page.id,
    );
    t(
      "…with no slot and no provider call",
      slotCalls() === 1 && openaiCalls.length === 1 && pages().length === 1,
    );
  }
  seed();
  {
    // Two racing requests (different request ids) for one target.
    const [a, b] = await Promise.all([draft(), draft({ title: "Pools in Austin (tab 2)" })]);
    const outcomes = [a.r?.outcome, b.r?.outcome].sort().join(",");
    t(
      "racing requests: one writes, the other gets the winner's page",
      outcomes === "exists,ready",
      `${outcomes} ${errMsg(a.err)} ${errMsg(b.err)}`,
    );
    t(
      "racing requests: one row, one provider call, the loser's slot given back",
      pages().length === 1 && openaiCalls.length === 1 && releases.length === 1,
      `${pages().length} ${openaiCalls.length} ${releases.length}`,
    );
  }
  seed();
  {
    // The race the unique index catches: another page appears between the check and the insert.
    db.beforeWrite = ({ method, table }) => {
      if (method === "POST" && table === "tenant_pages") {
        db.beforeWrite = undefined;
        db.insertRow("tenant_pages", {
          workspace_id: WS,
          slug: "someone-else",
          title: "Theirs",
          status: "draft",
          target_key: "city_hub::country=us|region=tx|city=austin",
          template_id: "tpl-city_hub",
          content_version: 1,
          generation: null,
        });
      }
    };
    const { r } = await draft();
    t(
      "a unique-index loss returns the winner's page and frees the slot",
      r?.outcome === "exists" &&
        r.page.slug === "someone-else" &&
        openaiCalls.length === 0 &&
        releases.length === 1,
    );
  }

  console.log("\n5. Failures keep the draft; regenerating fills the same row");
  seed();
  {
    openaiBehavior = "error";
    const { r, err } = await draft();
    t(
      "a provider failure returns 'failed' with a customer sentence",
      r?.outcome === "failed" && !/upstream broke/.test((r as any).error),
      errMsg(err),
    );
    const row = pages()[0];
    t(
      "the draft row is kept (title, filter, brief) and marked failed",
      !!row &&
        row.generation.state === "failed" &&
        row.generation.brief === "Most hosts offer pools with a shaded patio." &&
        row.title === "Private pools in Austin, TX",
    );
    t("the slot stays spent after a provider call (no free loop)", releases.length === 0);
    t("the call was settled (the customer refunded)", settles.length === 1);
    openaiBehavior = "ok";
    const again = await runPageDraft({
      workspaceId: WS,
      userId: USER,
      requestId: rid(),
      tier: "standard",
      mode: "regenerate",
      pageId: row!.id,
    });
    t(
      "regenerate fills the SAME row",
      again.outcome === "ready" &&
        pages().length === 1 &&
        pages()[0]!.id === row!.id &&
        pages()[0]!.body_markdown === BODY.trim(),
    );
    t("…and keeps the brief", String(openaiCalls.at(-1)?.input ?? "").includes("shaded patio"));
  }
  seed();
  {
    openaiBehavior = "thin";
    const { r } = await draft();
    t(
      "a truncated answer is a failure, not a thin page",
      r?.outcome === "failed" && pages()[0]?.body_markdown === null,
    );
  }
  seed();
  {
    aiReserve = () => ({ status: "insufficient" });
    const { r, err } = await draft();
    t(
      "a spend refusal before the provider call is thrown…",
      !r && err instanceof CustomerFacingError,
      errMsg(err),
    );
    t(
      "…the empty row it created is removed, and the slot given back",
      pages().length === 0 && releases.length === 1 && openaiCalls.length === 0,
    );
  }
  seed();
  {
    // Regenerating an existing draft keeps its old body if the new run fails.
    await draft();
    const row = pages()[0]!;
    openaiBehavior = "error";
    const r = await runPageDraft({
      workspaceId: WS,
      userId: USER,
      requestId: rid(),
      tier: "standard",
      mode: "regenerate",
      pageId: row.id,
    });
    t(
      "a failed regeneration never erases the previous draft text",
      r.outcome === "failed" && pages()[0]!.body_markdown === BODY.trim(),
    );
  }

  console.log("\n6. Replay, concurrency on one draft, drafts only");
  seed();
  {
    const id = rid();
    const base = {
      workspaceId: WS,
      userId: USER,
      requestId: id,
      tier: "standard" as const,
      mode: "new" as const,
      kind: "city_hub" as const,
      filter: austin,
      title: "Private pools in Austin, TX",
      description: "Browse private pools you can rent by the hour in Austin, Texas.",
    };
    const first = await runPageDraft(base);
    const replay = await runPageDraft(base);
    t(
      "the same request id replays the page without a provider call",
      first.outcome === "ready" &&
        replay.outcome === "ready" &&
        (replay as any).replayed === true &&
        openaiCalls.length === 1,
    );
    const st = await draftStatus(WS, id);
    t(
      "draftStatus reports the request's page",
      st?.outcome === "ready" && st.page.id === first.page.id,
    );
    t("another workspace can't see it", (await draftStatus(OTHER_WS, id)) === null);
  }
  seed();
  {
    await draft();
    const row = pages()[0]!;
    row.generation = {
      ...row.generation,
      state: "generating",
      request_id: "33333333-3333-4333-8333-333333333333",
      started_at: new Date().toISOString(),
    };
    let err: unknown = null;
    try {
      await runPageDraft({
        workspaceId: WS,
        userId: USER,
        requestId: rid(),
        tier: "standard",
        mode: "regenerate",
        pageId: row.id,
      });
    } catch (e) {
      err = e;
    }
    t(
      "a draft being written right now can't be regenerated",
      errMsg(err) === GENERATION_IN_PROGRESS_MESSAGE && openaiCalls.length === 1,
    );
    row.generation.started_at = new Date(Date.now() - 6 * 60_000).toISOString();
    // The editor and My Pages show an abandoned claim as interrupted (failed,
    // "Try again"), never "being written" forever.
    const seen = effectiveGeneration(row.generation);
    t(
      "an abandoned claim is shown as interrupted, not still being written",
      seen?.state === "failed" &&
        seen.error === DRAFT_INTERRUPTED_MESSAGE &&
        !isGenerationActive(row.generation),
    );
    t(
      "a live claim is shown as being written",
      effectiveGeneration({ ...row.generation, started_at: new Date().toISOString() })?.state ===
        "generating",
    );
    t(
      "a claim dated in the future is not a live claim",
      !isGenerationActive({
        ...row.generation,
        started_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const r = await runPageDraft({
      workspaceId: WS,
      userId: USER,
      requestId: rid(),
      tier: "standard",
      mode: "regenerate",
      pageId: row.id,
    });
    t(
      "an abandoned run (older than 5 minutes) can be taken over",
      r.outcome === "ready" && openaiCalls.length === 2,
    );
    const afterRegen = pages()[0]!;
    t(
      "a regeneration moves the version on twice (claim, then delivery), so no two texts share one",
      Number(afterRegen.content_version) === 4,
      String(afterRegen.content_version),
    );
    // A save lands between the regenerate's read and its claim: the claim
    // (conditional on the version it read) fails, nothing is spent.
    const callsBefore = openaiCalls.length;
    db.beforeWrite = ({ method, table, body }) => {
      if (
        method === "PATCH" &&
        table === "tenant_pages" &&
        body?.generation?.state === "generating"
      ) {
        db.beforeWrite = undefined;
        afterRegen.content_version = Number(afterRegen.content_version) + 1; // the save
        afterRegen.body_markdown = "The owner's own words, saved a moment ago.";
      }
    };
    let errRace: unknown = null;
    try {
      await runPageDraft({
        workspaceId: WS,
        userId: USER,
        requestId: rid(),
        tier: "standard",
        mode: "regenerate",
        pageId: afterRegen.id,
      });
    } catch (e) {
      errRace = e;
    }
    db.beforeWrite = undefined;
    t(
      "a regenerate racing a save is refused before any spend, and the save stands",
      errMsg(errRace) === DRAFT_CHANGED_MESSAGE &&
        openaiCalls.length === callsBefore &&
        pages()[0]!.body_markdown === "The owner's own words, saved a moment ago." &&
        pages()[0]!.generation?.state !== "generating",
      errMsg(errRace),
    );
    row.status = "published";
    let err2: unknown = null;
    try {
      await runPageDraft({
        workspaceId: WS,
        userId: USER,
        requestId: rid(),
        tier: "standard",
        mode: "regenerate",
        pageId: row.id,
      });
    } catch (e) {
      err2 = e;
    }
    t(
      "a published page is never regenerated",
      errMsg(err2) === DRAFT_NOT_EDITABLE_MESSAGE && openaiCalls.length === 2,
    );
    let err3: unknown = null;
    try {
      await runPageDraft({
        workspaceId: OTHER_WS,
        userId: USER,
        requestId: rid(),
        tier: "standard",
        mode: "regenerate",
        pageId: row.id,
      });
    } catch (e) {
      err3 = e;
    }
    t(
      "another workspace can't regenerate this page",
      err3 instanceof CustomerFacingError && /doesn't exist/.test(errMsg(err3)),
    );
  }
  seed();
  {
    internalUnlimited = true;
    await draft();
    t(
      "internal unlimited lifts the daily cap (the slot is still taken)",
      reserveCaps[0] === 2_147_483_647 && slotCalls() === 1,
    );
  }
  seed();
  {
    await draft({ tier: "premium" });
    t(
      "premium maps to the server's premium model",
      openaiCalls[0]?.model === "gpt-5-mini",
      String(openaiCalls[0]?.model),
    );
  }
} finally {
  console.error = origError;
  console.warn = origWarn;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
