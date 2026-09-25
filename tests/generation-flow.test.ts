/**
 * GENERATION FLOW, DRIVEN. Run: bun tests/generation-flow.test.ts
 *
 * Runs the real runQuickPage (src/lib/admin-quick-page.functions.ts) and the
 * real batch runItem (src/lib/generation.functions.ts) against a fake
 * PostgREST and a fake OpenRouter, both behind globalThis.fetch — the real
 * supabase-js service-role client builds every request, so what is asserted
 * is what would reach the database and the provider. The workspace is BYOK
 * (its own key) so billing stays out of the way; what is under test is the
 * daily-cap reservation around the provider call:
 *
 *   - a request that can only fail (an underivable slug) fails before any
 *     reservation or provider call — the unlimited-free-generation loop;
 *   - the reservation is marked spent BEFORE the provider request;
 *   - a failure after the provider call never releases the slot and logs the
 *     spend as 'failed' (the reported usage when known, a typical page
 *     otherwise); only a failure before the call releases;
 *   - 'cap_reached' / 'in_progress' / 'consumed' are honoured, and a spent
 *     id is never regenerated;
 *   - every batch attempt reserves under its own id before its claim; a cap
 *     refusal consumes no attempt; a settlement-only retry takes no slot.
 */
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
delete process.env.OPENROUTER_API_KEY;

const { runQuickPage, QuickPageInputSchema } = await import("../src/lib/admin-quick-page.functions");

// runItem is module-private (exporting it reshapes the client bundle), so it
// is reached the way tests/stripe-webhook.test.ts reaches the webhook: an
// offline copy of the source with one rewrite, asserted so that a changed
// declaration fails the suite instead of silently testing nothing. Every
// import in the file is an "@/..." alias, so the copy links to the very same
// generation.server module the real one uses.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const FUNCTIONS_SRC = readFileSync(join(import.meta.dir, "../src/lib/generation.functions.ts"), "utf8");
const RUN_ITEM_DECL = /\nasync function runItem\(/;
const functionsImportsAreAliases = !/from "\.{1,2}\//.test(FUNCTIONS_SRC);
mkdirSync(join(import.meta.dir, "_build"), { recursive: true });
const functionsCopy = join(import.meta.dir, "_build/generation.functions.offline.ts");
writeFileSync(functionsCopy, FUNCTIONS_SRC.replace(RUN_ITEM_DECL, "\nexport async function runItem("));
const { runItem } = (await import(functionsCopy)) as {
  runItem: (
    workspaceId: string,
    userId: string,
    itemId: string,
    opts?: { onlyIfFailed?: boolean },
  ) => Promise<{ item: { attempts: number } & Record<string, unknown>; changed: boolean }>;
};
const {
  CustomerFacingError,
  GENERATION_ALREADY_USED_MESSAGE,
  GENERATION_IN_PROGRESS_MESSAGE,
  PAGE_SLUG_UNDERIVABLE_MESSAGE,
  PROVIDER_ERROR_MESSAGE,
  TYPICAL_PAGE_TOKENS,
  batchAttemptRequestId,
  dailyCapMessage,
} = await import("../src/lib/generation.server");

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

t("runItem's declaration was found and rewritten for the offline copy", RUN_ITEM_DECL.test(FUNCTIONS_SRC) && typeof runItem === "function");
t("generation.functions.ts imports only through aliases (the copy links the same modules)", functionsImportsAreAliases);
t("runItem stays module-private in the source", !/export async function runItem\(/.test(FUNCTIONS_SRC));

// ---- The fakes ------------------------------------------------------------------
type Hit = {
  kind: "rest" | "rpc" | "openrouter";
  method: string;
  name: string; // table or rpc name
  query: URLSearchParams;
  body: any;
  single: boolean;
};
type Rows = unknown[] | { status: number; body: unknown };
type Handler = (h: Hit) => Rows | unknown | undefined;

let hits: Hit[] = [];
let rest: Record<string, Handler> = {}; // "<METHOD> <table>"
let rpc: Record<string, (args: any) => unknown> = {};
let openrouter: () => Response = () => okCompletion();

const BODY = "# Boats in Austin\n\n" + "Real copy about real boats on Lake Travis. ".repeat(20);
function okCompletion(usage = { prompt_tokens: 812, completion_tokens: 1204 }, body = BODY): Response {
  return Response.json({
    usage,
    choices: [
      {
        message: {
          tool_calls: [
            {
              function: {
                name: "write_page",
                arguments: JSON.stringify({
                  title: "Boats in Austin",
                  seo_title: "Boats in Austin, TX",
                  seo_description: "Rent a boat in Austin.",
                  body_markdown: body,
                }),
              },
            },
          ],
        },
      },
    ],
  });
}

const json = (status: number, body: unknown) =>
  body === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
  if (url.hostname === "openrouter.ai") {
    hits.push({ kind: "openrouter", method, name: "chat", query: url.searchParams, body, single: false });
    return openrouter();
  }
  if (url.hostname !== "supabase.test") throw new TypeError(`unexpected host ${url.host}`);
  const path = url.pathname.replace(/^\/rest\/v1\//, "");
  if (path.startsWith("rpc/")) {
    const name = path.slice(4);
    hits.push({ kind: "rpc", method, name, query: url.searchParams, body, single: false });
    const fn = rpc[name];
    const out = fn ? fn(body) : null;
    if (out && typeof out === "object" && "status" in (out as object) && "body" in (out as object)) {
      const o = out as { status: number; body: unknown };
      return json(o.status, o.body);
    }
    return json(200, out);
  }
  const single = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
  const hit: Hit = { kind: "rest", method, name: path, query: url.searchParams, body, single };
  hits.push(hit);
  const handler = rest[`${method} ${path}`];
  let rows = handler ? handler(hit) : undefined;
  if (rows === undefined) {
    // Defaults: reads find nothing; writes succeed and echo what they wrote.
    if (method === "GET") rows = [];
    else if (method === "POST") rows = Array.isArray(body) ? body : [{ id: `${path}-row`, ...body }];
    else if (method === "PATCH") rows = [{ id: `${path}-row` }];
    else rows = [];
  }
  if (rows && !Array.isArray(rows) && typeof rows === "object" && "status" in rows) {
    return json((rows as any).status, (rows as any).body);
  }
  const list = rows as unknown[];
  const wantsRows = (headers.get("prefer") ?? "").includes("return=representation") || method === "GET";
  if (!wantsRows) return json(method === "POST" ? 201 : 204, undefined);
  if (single) return list.length ? json(200, list[0]) : json(406, { code: "PGRST116", message: "no rows" });
  return json(200, list);
}) as typeof fetch;

// ---- Scenario helpers ---------------------------------------------------------
const WS = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQ = "22222222-2222-4222-8222-222222222222";

function reset() {
  hits = [];
  rpc = {
    reserve_generation_slot: () => "reserved",
    mark_generation_provider_called: () => true,
    release_generation_slot: () => true,
    tenant_get_workspace_secret: () => "sk-byok-test",
  };
  rest = {
    "GET page_templates": () => [{ id: "tpl-1" }],
    "POST tenant_pages": (h) => [{ id: "page-1", slug: h.body.slug, title: h.body.title }],
  };
  openrouter = () => okCompletion();
}
const rpcHits = (name: string) => hits.filter((h) => h.kind === "rpc" && h.name === name);
const restHits = (method: string, table: string) =>
  hits.filter((h) => h.kind === "rest" && h.method === method && h.name === table);
const providerHits = () => hits.filter((h) => h.kind === "openrouter");
const usageRows = () => restHits("POST", "ai_usage_log").map((h) => h.body);
const indexOf = (pred: (h: Hit) => boolean) => hits.findIndex(pred);

const input = (over: Record<string, unknown> = {}) =>
  QuickPageInputSchema.parse({
    workspaceId: WS,
    title: "Boats in Austin",
    topic: "City hub page for boat rentals in Austin, Texas",
    autoPublish: false,
    generationRequestId: REQ,
    ...over,
  });

async function quick(over: Record<string, unknown> = {}) {
  try {
    return { ok: await runQuickPage(input(over), USER), err: null as unknown };
  } catch (e) {
    return { ok: null, err: e };
  }
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const origError = console.error;
const origWarn = console.warn;
console.error = () => {};
console.warn = () => {};

try {
  // -------------------------------------------------------------------------
  console.log("\n=== quick page: a request that can only fail costs nothing (finding A) ===");
  for (const slug of ["---", "!!!", " / "]) {
    reset();
    const r = await quick({ slug });
    t(
      `slug ${JSON.stringify(slug)} is refused with a customer-facing message`,
      r.err instanceof CustomerFacingError && errMsg(r.err) === PAGE_SLUG_UNDERIVABLE_MESSAGE,
      errMsg(r.err),
    );
    t(
      `…before the pause read, any reservation or any provider call`,
      restHits("GET", "platform_settings").length === 0 &&
        hits.every((h) => h.kind !== "rpc") &&
        providerHits().length === 0,
      JSON.stringify(hits.map((h) => `${h.kind}:${h.name}`)),
    );
  }
  reset();
  {
    // The loop the finding describes: many retries, zero spend.
    for (let i = 0; i < 25; i++) await quick({ slug: "---", generationRequestId: crypto.randomUUID() });
    t(
      "25 underivable requests in a row: zero reservations, zero provider calls",
      rpcHits("reserve_generation_slot").length === 0 && providerHits().length === 0,
    );
  }

  // -------------------------------------------------------------------------
  console.log("\n=== quick page: the happy path marks the reservation before the provider ===");
  reset();
  {
    const r = await quick();
    t("a page is produced", r.ok?.page.id === "page-1" && r.ok?.replayed === false, errMsg(r.err));
    const reserveAt = indexOf((h) => h.kind === "rpc" && h.name === "reserve_generation_slot");
    const markAt = indexOf((h) => h.kind === "rpc" && h.name === "mark_generation_provider_called");
    const providerAt = indexOf((h) => h.kind === "openrouter");
    const insertAt = indexOf((h) => h.kind === "rest" && h.method === "POST" && h.name === "tenant_pages");
    t(
      "order: reserve → mark → provider → draft row",
      reserveAt >= 0 && reserveAt < markAt && markAt < providerAt && providerAt < insertAt,
      `${reserveAt} ${markAt} ${providerAt} ${insertAt}`,
    );
    t(
      "the reservation and the mark carry the request id",
      rpcHits("reserve_generation_slot")[0]?.body?._request_id === REQ &&
        rpcHits("mark_generation_provider_called")[0]?.body?._request_id === REQ,
    );
    t("nothing is released", rpcHits("release_generation_slot").length === 0);
    t(
      "exactly one usage row, status ok",
      usageRows().length === 1 && usageRows()[0]?.status === "ok",
      JSON.stringify(usageRows()),
    );
  }

  // -------------------------------------------------------------------------
  console.log("\n=== quick page: after the provider call the slot is never released ===");
  reset();
  openrouter = () => new Response("upstream exploded", { status: 500 });
  {
    const r = await quick();
    t("a provider error reaches the customer as the generic sentence", errMsg(r.err) === PROVIDER_ERROR_MESSAGE, errMsg(r.err));
    t("the provider WAS called (after the mark)", providerHits().length === 1 && rpcHits("mark_generation_provider_called").length === 1);
    t("the reservation is NOT released", rpcHits("release_generation_slot").length === 0);
    const row = usageRows()[0];
    t(
      "the spend is logged as 'failed' with a typical page's tokens (the provider reported none)",
      usageRows().length === 1 &&
        row?.status === "failed" &&
        row?.prompt_tokens === TYPICAL_PAGE_TOKENS.prompt &&
        row?.completion_tokens === TYPICAL_PAGE_TOKENS.completion &&
        row?.feature === "quick_page" &&
        /estimated/.test(row?.error ?? ""),
      JSON.stringify(row),
    );
    t("…with a customer-safe error and no ledger charge", !/upstream exploded/.test(row?.error ?? "") && restHits("POST", "credit_ledger").length === 0 && rpcHits("deduct_credits").length === 0);
  }
  reset();
  openrouter = () => okCompletion({ prompt_tokens: 640, completion_tokens: 12 }, "too short");
  {
    const r = await quick();
    t("thin output is refused", r.err instanceof CustomerFacingError && /too short/.test(errMsg(r.err)), errMsg(r.err));
    const row = usageRows()[0];
    t(
      "…logged as 'failed' with the usage the provider reported",
      row?.status === "failed" && row?.prompt_tokens === 640 && row?.completion_tokens === 12 && !/estimated/.test(row?.error ?? ""),
      JSON.stringify(row),
    );
    t("…and the slot stays spent", rpcHits("release_generation_slot").length === 0);
  }
  reset();
  rest["POST tenant_pages"] = () => ({ status: 500, body: { code: "XX000", message: "insert exploded" } });
  {
    const r = await quick();
    t("a draft-row failure after generation fails the request", r.err !== null && r.ok === null);
    const row = usageRows()[0];
    t(
      "…logs the generated usage as 'failed', without the database text",
      row?.status === "failed" && row?.prompt_tokens === 812 && row?.completion_tokens === 1204 && !/exploded/.test(row?.error ?? ""),
      JSON.stringify(row),
    );
    t("…and never releases the slot", rpcHits("release_generation_slot").length === 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n=== quick page: a failure before the provider call gives the slot back ===");
  reset();
  rpc.tenant_get_workspace_secret = () => null; // no BYOK key, no platform key
  {
    const r = await quick();
    t("no key is a customer-facing refusal", r.err instanceof CustomerFacingError && /no AI key/.test(errMsg(r.err)), errMsg(r.err));
    t(
      "the slot is released, for this request id",
      rpcHits("release_generation_slot").length === 1 && rpcHits("release_generation_slot")[0]?.body?._request_id === REQ,
    );
    t("nothing was marked or sent to the provider", rpcHits("mark_generation_provider_called").length === 0 && providerHits().length === 0);
    t("no usage row (nothing was spent)", usageRows().length === 0);
  }
  reset();
  rpc.mark_generation_provider_called = () => false; // another request owns this id's call
  {
    const r = await quick();
    t("a mark that is refused stops before the provider", providerHits().length === 0 && errMsg(r.err) === GENERATION_IN_PROGRESS_MESSAGE, errMsg(r.err));
    t("…logs no spend", usageRows().length === 0);
  }
  reset();
  rpc.mark_generation_provider_called = () => ({ status: 500, body: { message: "mark exploded" } });
  {
    const r = await quick();
    t("a failed mark RPC never reaches the provider", providerHits().length === 0 && r.err !== null);
    t("…and releases (the database frees the row only if it is unmarked)", rpcHits("release_generation_slot").length === 1);
  }

  // -------------------------------------------------------------------------
  console.log("\n=== quick page: the reservation's answers are honoured ===");
  reset();
  rpc.reserve_generation_slot = () => "cap_reached";
  {
    const r = await quick();
    t("'cap_reached' is the daily-cap refusal", errMsg(r.err) === dailyCapMessage(50, 0), errMsg(r.err));
    t("…with no provider call and nothing to release", providerHits().length === 0 && rpcHits("release_generation_slot").length === 0);
  }
  reset();
  rpc.reserve_generation_slot = () => "in_progress";
  {
    const r = await quick();
    t("'in_progress' is 'still being generated'", errMsg(r.err) === GENERATION_IN_PROGRESS_MESSAGE, errMsg(r.err));
    t(
      "…with no second provider call and no release of the other request's slot",
      providerHits().length === 0 && rpcHits("mark_generation_provider_called").length === 0 && rpcHits("release_generation_slot").length === 0,
    );
  }
  reset();
  rpc.reserve_generation_slot = () => "consumed";
  {
    const r = await quick();
    t(
      "'consumed' with no page left (a deleted draft) is refused — never regenerated for free",
      errMsg(r.err) === GENERATION_ALREADY_USED_MESSAGE && providerHits().length === 0,
      errMsg(r.err),
    );
  }
  reset();
  rpc.reserve_generation_slot = () => "consumed";
  let pageReads = 0;
  rest["GET tenant_pages"] = (h) => {
    if (h.query.get("generation_request_id") !== `eq.${REQ}`) return [];
    // Step 0 raced the page (not there yet); by the reservation it exists.
    pageReads++;
    return pageReads === 1
      ? []
      : [{ id: "page-9", slug: "boats-in-austin", title: "Boats in Austin", status: "draft", body_markdown: "a b c", generation_billing_mode: "byok" }];
  };
  {
    const r = await quick();
    t("'consumed' with the page there returns it as a replay", r.ok?.replayed === true && r.ok?.page.id === "page-9", errMsg(r.err));
    t("…without a provider call or a slot", providerHits().length === 0 && rpcHits("mark_generation_provider_called").length === 0);
  }
  reset();
  rpc.reserve_generation_slot = () => "maybe";
  {
    const r = await quick();
    t("an unexpected reservation answer is an error, never a generation", r.err !== null && providerHits().length === 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n=== batch: one reservation per attempt, before the claim ===");
  const JOB = "33333333-3333-4333-8333-333333333333";
  const ITEM = "44444444-4444-4444-8444-444444444444";
  const baseItem = {
    id: ITEM,
    job_id: JOB,
    workspace_id: WS,
    target_key: "city:austin|tx",
    target: { city: "Austin", state: "TX", listingCount: 5, categoryPlural: "boat rentals" },
    slug: null,
    page_id: null,
    status: "pending",
    error: null,
    attempts: 1,
    prompt_tokens: null,
    completion_tokens: null,
    credits_charged: 0,
    billing_status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const patches = () => restHits("PATCH", "generation_items");
  const claimPatch = () => patches().find((h) => h.body?.status === "running");
  function batchReset(item: Record<string, unknown> = {}) {
    reset();
    const row = { ...baseItem, ...item };
    rest["GET generation_items"] = (h) =>
      h.query.get("select") === "status" ? [{ status: "done" }] : [row];
    rest["GET generation_jobs"] = () => [{ id: JOB, status: "running", model: null }];
    rest["PATCH generation_items"] = (h) =>
      h.body?.status === "running" ? [{ ...row, status: "running", attempts: (row.attempts as number) + 1 }] : [{ id: ITEM }];
    return row;
  }
  {
    const row = batchReset();
    const out = await runItem(WS, USER, ITEM);
    const expectedId = await batchAttemptRequestId(row as any);
    t("a pending item generates", out.changed === true && providerHits().length === 1);
    t(
      "it reserved under ITS attempt id (item, job, attempts + 1) before the claim",
      rpcHits("reserve_generation_slot")[0]?.body?._request_id === expectedId &&
        indexOf((h) => h.kind === "rpc" && h.name === "reserve_generation_slot") <
          indexOf((h) => h.kind === "rest" && h.method === "PATCH" && h.body?.status === "running"),
    );
    t(
      "…marked that id before the provider, and released nothing",
      rpcHits("mark_generation_provider_called")[0]?.body?._request_id === expectedId &&
        indexOf((h) => h.name === "mark_generation_provider_called") < indexOf((h) => h.kind === "openrouter") &&
        rpcHits("release_generation_slot").length === 0,
    );
    t("the claim wrote attempts + 1", claimPatch()?.body?.attempts === 2);
  }
  {
    batchReset();
    rpc.reserve_generation_slot = () => "cap_reached";
    const out = await runItem(WS, USER, ITEM);
    const refusal = patches()[0];
    t(
      "a full cap refuses the item with the cap message",
      refusal?.body?.status === "failed" && refusal?.body?.error === dailyCapMessage(50, 0),
      JSON.stringify(refusal?.body),
    );
    t(
      "…without claiming it or consuming an attempt",
      !claimPatch() && patches().every((h) => h.body?.attempts === undefined) && providerHits().length === 0 && out.item.attempts === 1,
    );
  }
  for (const answer of ["in_progress", "consumed"]) {
    batchReset();
    rpc.reserve_generation_slot = () => answer;
    const out = await runItem(WS, USER, ITEM);
    t(
      `'${answer}' (another driver holds or spent this attempt): the item is left alone`,
      out.changed === false && patches().length === 0 && providerHits().length === 0 && rpcHits("release_generation_slot").length === 0,
    );
  }
  {
    batchReset();
    rpc.tenant_get_workspace_secret = () => null;
    await runItem(WS, USER, ITEM);
    t(
      "a billing refusal releases the attempt's slot and refuses without a claim",
      rpcHits("release_generation_slot").length === 1 && !claimPatch() && patches()[0]?.body?.status === "failed",
    );
  }
  {
    const row = batchReset();
    rest["PATCH generation_items"] = (h) => (h.body?.status === "running" ? [] : [{ id: ITEM }]);
    const out = await runItem(WS, USER, ITEM);
    t(
      "a lost claim (the item moved on) releases the slot and generates nothing",
      out.changed === false && rpcHits("release_generation_slot").length === 1 && providerHits().length === 0,
    );
    t(
      "…releasing exactly its own attempt id",
      rpcHits("release_generation_slot")[0]?.body?._request_id === (await batchAttemptRequestId(row as any)),
    );
  }
  {
    batchReset();
    rest["GET tenant_pages"] = (h) =>
      (h.query.get("variables->>city") ?? "").startsWith("ilike.")
        ? [{ id: "page-hand", slug: "austin", variables: { city: "Austin", state: "TX" } }]
        : [];
    await runItem(WS, USER, ITEM);
    t(
      "linking an existing page instead of generating releases the slot",
      providerHits().length === 0 && rpcHits("mark_generation_provider_called").length === 0 && rpcHits("release_generation_slot").length === 1,
    );
  }
  {
    batchReset();
    openrouter = () => new Response("nope", { status: 503 });
    await runItem(WS, USER, ITEM);
    const row = usageRows()[0];
    t("a provider failure after the mark keeps the slot spent", rpcHits("release_generation_slot").length === 0 && providerHits().length === 1);
    t(
      "…and logs the spend as 'failed' for the batch",
      row?.status === "failed" && row?.feature === "batch_generation" && row?.prompt_tokens === TYPICAL_PAGE_TOKENS.prompt,
      JSON.stringify(row),
    );
    t("…the item records the customer message", patches().some((h) => h.body?.status === "failed" && h.body?.error === PROVIDER_ERROR_MESSAGE));
  }
  {
    batchReset({ page_id: "page-7", billing_status: "free", status: "failed" });
    await runItem(WS, USER, ITEM);
    t(
      "a settlement-only retry (the draft exists) takes no slot and calls no provider",
      rpcHits("reserve_generation_slot").length === 0 && rpcHits("release_generation_slot").length === 0 && providerHits().length === 0,
    );
  }
} finally {
  console.error = origError;
  console.warn = origWarn;
}

{
  const pkg = readFileSync(join(import.meta.dir, "..", "package.json"), "utf8");
  t("this suite is in the test chain", /bun tests\/generation-flow\.test\.ts/.test(pkg));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}
