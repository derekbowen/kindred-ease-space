/**
 * GENERATION FLOW, DRIVEN. Run: bun tests/generation-flow.test.ts
 *
 * Runs the real runQuickPage (src/lib/admin-quick-page.functions.ts) and the
 * real batch runItem (src/lib/generation.functions.ts) against a fake
 * PostgREST and a fake OpenAI Responses API, both behind globalThis.fetch —
 * the real supabase-js service-role client and the real openai SDK build
 * every request, so what is asserted is what would reach the database and
 * the provider. The workspace is BYOK (its own key) so the money stays out
 * of the way (tests/ai-spend-sql.test.ts runs the money SQL); what is under
 * test is the order of the daily-cap slot, the spend hold and the provider
 * call:
 *
 *   - a request that can only fail (an underivable slug) fails before any
 *     slot, hold or provider call — the unlimited-free-generation loop;
 *   - no key is refused before any slot or hold is taken;
 *   - slot → hold → slot mark → hold mark → provider → settle → draft row,
 *     all under ONE request id;
 *   - a failure after the provider call never releases the slot or the hold:
 *     it is settled (the reported usage when known, the full hold
 *     otherwise); only a failure before the call releases either;
 *   - 'cap_reached' / 'in_progress' / 'consumed' and every ai_reserve refusal
 *     are honoured, and a spent id is never regenerated;
 *   - every batch attempt reserves under its own id before its claim, and
 *     holds its spend under the SAME id; a cap refusal consumes no attempt;
 *     an item whose draft exists takes no slot and no hold;
 *   - round-4 M1: a spend refusal before the provider call (no funds, the
 *     workspace's or the platform's daily AI cap, the kill switch, the rate
 *     limit, a refused mark) never consumes a batch attempt — driven through
 *     the real runItem against a stateful item, five refusals in a row;
 *   - round-4 L7: the hold is marked BEFORE the daily-cap slot, so a refused
 *     hold mark never spends a slot;
 *   - round-4 L2: a publish-step error after a saved, charged page returns
 *     the draft with a reason — never a generation failure;
 *   - the founder / internal unlimited entitlement lifts the daily cap (the
 *     slot is still taken);
 *   - the model choice end to end: the tier in the request body → the strict
 *     schema → the server's model → the job row (batch) → the hold → the
 *     Responses API request the fake OpenAI received.
 */
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
delete process.env.OPENAI_API_KEY;

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
const START_JOB_DECL = /\nasync function startJob\(/;
// startJob reads the Page Builder's context through a server function (it
// needs a request to authenticate); the copy reads a stub the test controls.
const PAGE_BUILDER_IMPORT = /from "@\/lib\/page-builder\.functions";/;
const functionsImportsAreAliases = !/from "\.{1,2}\//.test(FUNCTIONS_SRC);
mkdirSync(join(import.meta.dir, "_build"), { recursive: true });
const functionsCopy = join(import.meta.dir, "_build/generation.functions.offline.ts");
writeFileSync(
  functionsCopy,
  FUNCTIONS_SRC.replace(RUN_ITEM_DECL, "\nexport async function runItem(")
    .replace(START_JOB_DECL, "\nexport async function startJob(")
    .replace(PAGE_BUILDER_IMPORT, `from "${join(import.meta.dir, "_support/page-builder-stub.ts")}";`),
);
const { runItem, startJob, StartGenerationJobInputSchema } = (await import(functionsCopy)) as {
  runItem: (
    workspaceId: string,
    userId: string,
    itemId: string,
    opts?: { onlyIfFailed?: boolean },
  ) => Promise<{ item: { attempts: number } & Record<string, unknown>; changed: boolean }>;
  startJob: (data: Record<string, unknown>, userId: string) => Promise<{ job: Record<string, unknown> } & Record<string, unknown>>;
  StartGenerationJobInputSchema: { parse: (d: unknown) => Record<string, unknown>; safeParse: (d: unknown) => { success: boolean } };
};
const { pageBuilderStub } = await import("./_support/page-builder-stub");
const { PUBLISH_STEP_FAILED_MESSAGE } = await import("../src/lib/admin-quick-page.functions");
const {
  ATTEMPTS_EXHAUSTED_MESSAGE,
  CustomerFacingError,
  GENERATION_ALREADY_USED_MESSAGE,
  GENERATION_IN_PROGRESS_MESSAGE,
  GENERATION_PAUSED_MESSAGE,
  GENERATION_UNAVAILABLE_MESSAGE,
  PAGE_SLUG_UNDERIVABLE_MESSAGE,
  PROVIDER_ERROR_MESSAGE,
  batchAttemptRequestId,
  dailyCapMessage,
  outOfCreditsMessage,
} = await import("../src/lib/generation.server");
const { AI_MESSAGES } = await import("../src/lib/ai/customer-error");

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
t("startJob's declaration and the Page Builder import were found and rewritten", START_JOB_DECL.test(FUNCTIONS_SRC) && PAGE_BUILDER_IMPORT.test(FUNCTIONS_SRC) && typeof startJob === "function");
t("startJob stays module-private in the source", !/export async function startJob\(/.test(FUNCTIONS_SRC));
t("generation.functions.ts imports only through aliases (the copy links the same modules)", functionsImportsAreAliases);
t("runItem stays module-private in the source", !/export async function runItem\(/.test(FUNCTIONS_SRC));

// ---- The fakes ------------------------------------------------------------------
type Hit = {
  kind: "rest" | "rpc" | "openai";
  method: string;
  name: string; // table or rpc name
  query: URLSearchParams;
  body: any;
  single: boolean;
  headers: Headers;
};
type Rows = unknown[] | { status: number; body: unknown };
type Handler = (h: Hit) => Rows | unknown | undefined;

let hits: Hit[] = [];
let rest: Record<string, Handler> = {}; // "<METHOD> <table>"
let rpc: Record<string, (args: any) => unknown> = {};
let openai: () => Response | Promise<Response> = () => okResponse();

const BODY = "# Boats in Austin\n\n" + "Real copy about real boats on Lake Travis. ".repeat(20);
const PAGE = {
  title: "Boats in Austin",
  seo_title: "Boats in Austin, TX",
  seo_description: "Rent a boat in Austin.",
  body_markdown: BODY,
};
function okResponse(usage: { input: number; output: number } | null = { input: 812, output: 1204 }, page: Record<string, unknown> = PAGE): Response {
  return Response.json(
    {
      id: "resp_flow",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-5-nano-2025-08-07",
      output: [
        {
          type: "message",
          id: "msg_flow",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(page), annotations: [] }],
        },
      ],
      ...(usage
        ? {
            usage: {
              input_tokens: usage.input,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: usage.output,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: usage.input + usage.output,
            },
          }
        : {}),
    },
    { headers: { "x-request-id": "req_flow" } },
  );
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
  if (url.hostname === "api.openai.com") {
    hits.push({ kind: "openai", method, name: url.pathname, query: url.searchParams, body, single: false, headers });
    return openai();
  }
  if (url.hostname !== "supabase.test") throw new TypeError(`unexpected host ${url.host}`);
  const path = url.pathname.replace(/^\/rest\/v1\//, "");
  if (path.startsWith("rpc/")) {
    const name = path.slice(4);
    hits.push({ kind: "rpc", method, name, query: url.searchParams, body, single: false, headers });
    const fn = rpc[name];
    const out = fn ? fn(body) : null;
    if (out && typeof out === "object" && "status" in (out as object) && "body" in (out as object)) {
      const o = out as { status: number; body: unknown };
      return json(o.status, o.body);
    }
    return json(200, out);
  }
  const single = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
  const hit: Hit = { kind: "rest", method, name: path, query: url.searchParams, body, single, headers };
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
    // An ordinary workspace: no founder / internal unlimited grant.
    workspace_is_internal_unlimited: () => false,
    tenant_get_workspace_secret: () => "sk-byok-test",
    ai_reserve: () => ({ status: "reserved", billing: "byok", hold_seq: 1, credits_charged: 0 }),
    ai_mark_called: () => true,
    ai_release: () => true,
    ai_settle: (a: any) => ({
      status: "settled",
      billing: "byok",
      credits_charged: 0,
      cost_micros: a._cost_micros,
      full_hold: a._cost_micros === null,
    }),
  };
  rest = {
    "GET page_templates": () => [{ id: "tpl-1" }],
    "POST tenant_pages": (h) => [{ id: "page-1", slug: h.body.slug, title: h.body.title }],
  };
  openai = () => okResponse();
}
const rpcHits = (name: string) => hits.filter((h) => h.kind === "rpc" && h.name === name);
const restHits = (method: string, table: string) =>
  hits.filter((h) => h.kind === "rest" && h.method === method && h.name === table);
const providerHits = () => hits.filter((h) => h.kind === "openai");
const settles = () => rpcHits("ai_settle").map((h) => h.body);
const indexOf = (pred: (h: Hit) => boolean) => hits.findIndex(pred);
const rpcAt = (name: string) => indexOf((h) => h.kind === "rpc" && h.name === name);
const noSpend = () =>
  rpcHits("ai_reserve").length === 0 && rpcHits("ai_mark_called").length === 0 && providerHits().length === 0 && rpcHits("ai_settle").length === 0;

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
      `…before the pause read, any slot, any hold or any provider call`,
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
      "25 underivable requests in a row: zero slots, zero holds, zero provider calls",
      rpcHits("reserve_generation_slot").length === 0 && noSpend(),
    );
  }

  // -------------------------------------------------------------------------
  console.log("\n=== quick page: the happy path — slot, hold, marks, provider, settle, draft ===");
  reset();
  {
    const r = await quick();
    t("a page is produced", r.ok?.page.id === "page-1" && r.ok?.replayed === false, errMsg(r.err));
    const slotAt = rpcAt("reserve_generation_slot");
    const holdAt = rpcAt("ai_reserve");
    const slotMarkAt = rpcAt("mark_generation_provider_called");
    const holdMarkAt = rpcAt("ai_mark_called");
    const providerAt = indexOf((h) => h.kind === "openai");
    const settleAt = rpcAt("ai_settle");
    const insertAt = indexOf((h) => h.kind === "rest" && h.method === "POST" && h.name === "tenant_pages");
    t(
      "order: slot → hold → hold mark → slot mark → provider → draft row → settle (a refused hold mark never spends a slot; the customer pays only for a saved page)",
      slotAt >= 0 && slotAt < holdAt && holdAt < holdMarkAt && holdMarkAt < slotMarkAt && slotMarkAt < providerAt && providerAt < insertAt && insertAt < settleAt,
      `${slotAt} ${holdAt} ${holdMarkAt} ${slotMarkAt} ${providerAt} ${insertAt} ${settleAt}`,
    );
    t(
      "the slot, the hold, both marks and the settlement all carry the request id",
      ["reserve_generation_slot", "ai_reserve", "mark_generation_provider_called", "ai_mark_called", "ai_settle"].every(
        (n) => rpcHits(n)[0]?.body?._request_id === REQ,
      ),
    );
    const hold = rpcHits("ai_reserve")[0]?.body;
    t(
      "the hold is for page generation on the standard model, by this user, billed to the workspace's own key",
      hold?._feature === "page_generation" && hold?._model === "gpt-5-nano" && hold?._user_id === USER && hold?._billing_class === "byok" && hold?._source === "quick_page",
      JSON.stringify(hold),
    );
    t(
      "exactly one provider request, to the Responses API, with the workspace's key",
      providerHits().length === 1 &&
        providerHits()[0]!.name === "/v1/responses" &&
        providerHits()[0]!.headers.get("authorization") === "Bearer sk-byok-test" &&
        providerHits()[0]!.body?.model === "gpt-5-nano",
    );
    t("nothing is released", rpcHits("release_generation_slot").length === 0 && rpcHits("ai_release").length === 0);
    t(
      "exactly one settlement, outcome ok, with the reported usage",
      settles().length === 1 && settles()[0]?._outcome === "ok" && settles()[0]?._input_tokens === 812 && settles()[0]?._output_tokens === 1204,
      JSON.stringify(settles()),
    );
    t("the app writes no usage row itself (ai_settle writes it in the database)", restHits("POST", "ai_usage_log").length === 0);
  }
  reset();
  {
    const r = await quick({ quality: "premium" });
    t(
      "premium: the hold and the request are for gpt-5-mini",
      r.ok !== null && rpcHits("ai_reserve")[0]?.body?._model === "gpt-5-mini" && providerHits()[0]?.body?.model === "gpt-5-mini",
      errMsg(r.err),
    );
  }

  // -------------------------------------------------------------------------
  console.log("\n=== quick page: after the provider call nothing is released; the call is settled ===");
  reset();
  openai = () => new Response("upstream exploded", { status: 500 });
  {
    const r = await quick();
    t("a provider error reaches the customer as the generic sentence", errMsg(r.err) === PROVIDER_ERROR_MESSAGE, errMsg(r.err));
    t(
      "the provider WAS called (after both marks)",
      providerHits().length === 1 && rpcHits("mark_generation_provider_called").length === 1 && rpcHits("ai_mark_called").length === 1,
    );
    t("neither the slot nor the hold is released", rpcHits("release_generation_slot").length === 0 && rpcHits("ai_release").length === 0);
    const s = settles()[0];
    t(
      "the spend is settled 'failed' at the full hold (the provider reported no usage)",
      settles().length === 1 && s?._outcome === "failed" && s?._error === "server_error" && s?._cost_micros === null && s?._input_tokens === null,
      JSON.stringify(s),
    );
    t(
      "…with a short failure code only and no charge written by the app",
      !/upstream exploded/.test(JSON.stringify(s)) && restHits("POST", "credit_ledger").length === 0 && rpcHits("deduct_credits").length === 0,
    );
    t("no draft row", restHits("POST", "tenant_pages").length === 0);
  }
  reset();
  openai = () => okResponse({ input: 640, output: 12 }, { ...PAGE, body_markdown: "too short" });
  {
    const r = await quick();
    t("thin output is refused", r.err instanceof CustomerFacingError && /too short/.test(errMsg(r.err)), errMsg(r.err));
    const s = settles()[0];
    t(
      "…settled 'failed' with the usage the provider reported, priced for the platform budget, nothing charged to the customer",
      s?._outcome === "failed" && s?._error === "thin_output" && s?._input_tokens === 640 && s?._output_tokens === 12 && typeof s?._cost_micros === "number" && s?._cost_micros > 0 && s?._credits === 0,
      JSON.stringify(s),
    );
    t("…and the slot stays spent", rpcHits("release_generation_slot").length === 0 && rpcHits("ai_release").length === 0);
  }
  reset();
  openai = () => okResponse(null);
  {
    await quick();
    const s = settles()[0];
    t(
      "a success without usage is settled at the full hold, never as free",
      s?._outcome === "ok" && s?._cost_micros === null && s?._credits === null && s?._error === "usage_missing",
      JSON.stringify(s),
    );
  }
  reset();
  rest["POST tenant_pages"] = () => ({ status: 500, body: { code: "XX000", message: "insert exploded" } });
  {
    const r = await quick();
    t("a draft-row failure after generation fails the request", r.err !== null && r.ok === null);
    const s = settles()[0];
    t(
      "…settled AFTER the failed save as not_delivered: the customer refunded, the platform budget keeps the reported cost",
      s?._outcome === "failed" && s?._error === "not_delivered" && s?._credits === 0 && s?._input_tokens === 812 && typeof s?._cost_micros === "number" && s?._cost_micros > 0 &&
        rpcAt("ai_settle") > indexOf((h) => h.kind === "rest" && h.method === "POST" && h.name === "tenant_pages"),
      JSON.stringify(s),
    );
    t("…without the database text", !/exploded/.test(JSON.stringify(s)));
    t("…and neither the slot nor the hold is released (the slot stays counted)", rpcHits("release_generation_slot").length === 0 && rpcHits("ai_release").length === 0);
  }

  // -------------------------------------------------------------------------
  console.log("\n=== quick page: a refusal before the provider call gives everything back ===");
  reset();
  rpc.tenant_get_workspace_secret = () => null; // no BYOK key, no platform key
  {
    const r = await quick();
    t("no key is a customer-facing refusal", r.err instanceof CustomerFacingError && errMsg(r.err) === AI_MESSAGES.notConfigured, errMsg(r.err));
    t(
      "…decided before any slot or hold is taken",
      rpcHits("reserve_generation_slot").length === 0 && rpcHits("release_generation_slot").length === 0 && noSpend(),
    );
  }
  for (const [status, message] of [
    ["insufficient", outOfCreditsMessage()],
    ["rate_limited", AI_MESSAGES.rateLimited],
    ["platform_paused", AI_MESSAGES.platformPaused],
    ["generation_paused", GENERATION_PAUSED_MESSAGE],
    ["budget_exhausted", AI_MESSAGES.budgetExhausted],
    ["in_progress", GENERATION_IN_PROGRESS_MESSAGE],
    ["done", GENERATION_ALREADY_USED_MESSAGE],
  ] as const) {
    reset();
    rpc.ai_reserve = () => ({ status });
    const r = await quick();
    t(`a hold refused as '${status}' is the customer sentence`, r.err instanceof CustomerFacingError && errMsg(r.err) === message, errMsg(r.err));
    t(
      `…nothing is marked or sent, and the slot goes back (${status})`,
      rpcHits("mark_generation_provider_called").length === 0 &&
        rpcHits("ai_mark_called").length === 0 &&
        providerHits().length === 0 &&
        rpcHits("release_generation_slot").length === 1 &&
        rpcHits("release_generation_slot")[0]?.body?._request_id === REQ,
    );
  }
  reset();
  rpc.ai_reserve = () => ({ status: "reserved" }); // no billing mode: never trusted
  {
    const r = await quick();
    t("a 'reserved' answer without a billing mode is an error, never a call", r.err !== null && providerHits().length === 0 && rpcHits("release_generation_slot").length === 1);
  }
  reset();
  rpc.ai_reserve = () => ({ status: 500, body: { message: "reserve exploded" } });
  {
    const r = await quick();
    t("a failed hold RPC never reaches the provider, and the slot goes back", r.err !== null && providerHits().length === 0 && rpcHits("release_generation_slot").length === 1);
  }
  reset();
  rpc.mark_generation_provider_called = () => false; // another request owns this id's call
  {
    const r = await quick();
    t("a refused slot mark stops before the provider", providerHits().length === 0 && errMsg(r.err) === GENERATION_IN_PROGRESS_MESSAGE, errMsg(r.err));
    const s = settles()[0];
    t(
      "…the hold was already marked, so it is settled — never released — at ZERO: not_sent, the customer refunded in full",
      rpcHits("ai_mark_called").length === 1 && rpcHits("ai_release").length === 0 && settles().length === 1 &&
        s?._outcome === "failed" && s?._error === "not_sent" && s?._cost_micros === 0 && s?._credits === 0,
      JSON.stringify(s),
    );
    t("…and the unmarked slot goes back", rpcHits("release_generation_slot").length === 1);
  }
  reset();
  rpc.mark_generation_provider_called = () => ({ status: 500, body: { message: "mark exploded" } });
  {
    const r = await quick();
    t("a failed slot-mark RPC never reaches the provider", providerHits().length === 0 && r.err !== null);
    t(
      "…the slot is released (the database frees it only if it is unmarked) and the marked hold settled at zero",
      rpcHits("release_generation_slot").length === 1 && rpcHits("ai_release").length === 0 &&
        settles()[0]?._error === "not_sent" && settles()[0]?._cost_micros === 0,
      JSON.stringify(settles()),
    );
  }
  reset();
  rpc.ai_mark_called = () => false; // e.g. the kill switch flipped between hold and mark
  {
    const r = await quick();
    t("a refused hold mark stops before the provider", providerHits().length === 0 && r.err instanceof CustomerFacingError, errMsg(r.err));
    t("…the hold is released in full", rpcHits("ai_release").length === 1 && rpcHits("ai_settle").length === 0);
    t(
      "…and the daily-cap slot was NEVER marked, so it goes back (round-4 L7: a refused mark spends no slot)",
      rpcHits("mark_generation_provider_called").length === 0 && rpcHits("release_generation_slot").length === 1 &&
        rpcHits("release_generation_slot")[0]?.body?._request_id === REQ,
    );
  }

  // -------------------------------------------------------------------------
  console.log("\n=== quick page: the slot's answers are honoured ===");
  reset();
  rpc.reserve_generation_slot = () => "cap_reached";
  {
    const r = await quick();
    t("'cap_reached' is the daily-cap refusal", errMsg(r.err) === dailyCapMessage(50, 0), errMsg(r.err));
    t("…with no hold, no provider call and nothing to release", noSpend() && rpcHits("release_generation_slot").length === 0);
  }
  reset();
  rpc.reserve_generation_slot = () => "in_progress";
  {
    const r = await quick();
    t("'in_progress' is 'still being generated'", errMsg(r.err) === GENERATION_IN_PROGRESS_MESSAGE, errMsg(r.err));
    t(
      "…with no hold, no second provider call and no release of the other request's slot",
      noSpend() && rpcHits("mark_generation_provider_called").length === 0 && rpcHits("release_generation_slot").length === 0,
    );
  }
  reset();
  rpc.reserve_generation_slot = () => "consumed";
  {
    const r = await quick();
    t(
      "'consumed' with no page left (a deleted draft) is refused — never regenerated for free",
      errMsg(r.err) === GENERATION_ALREADY_USED_MESSAGE && noSpend(),
      errMsg(r.err),
    );
  }
  for (const [spendRow, credits, billing] of [
    [{ status: "settled", billing: "byok", credits_charged: 0 }, 0, "free"],
    [{ status: "settled", billing: "credits", credits_charged: 4 }, 4, "charged"],
    [{ status: "called", billing: "credits", credits_charged: 0 }, 0, "pending"],
  ] as const) {
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
    rest["GET ai_spend_reservations"] = (h) =>
      h.query.get("request_id") === `eq.${REQ}` ? [spendRow] : [];
    const r = await quick();
    t(
      `'consumed' with the page there returns it as a replay (spend ${spendRow.status}/${spendRow.billing})`,
      r.ok?.replayed === true && r.ok?.page.id === "page-9" && r.ok?.creditsCharged === credits && r.ok?.billing === billing,
      errMsg(r.err) || JSON.stringify(r.ok),
    );
    t("…without a provider call, a hold or a mark", noSpend() && rpcHits("mark_generation_provider_called").length === 0);
  }
  reset();
  rpc.reserve_generation_slot = () => "maybe";
  {
    const r = await quick();
    t("an unexpected slot answer is an error, never a generation", r.err !== null && noSpend());
  }

  // -------------------------------------------------------------------------
  console.log("\n=== batch: one slot and one hold per attempt, under one id ===");
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
  function batchReset(item: Record<string, unknown> = {}, jobModel: string | null = null) {
    reset();
    const row = { ...baseItem, ...item };
    rest["GET generation_items"] = (h) =>
      h.query.get("select") === "status" ? [{ status: "done" }] : [row];
    rest["GET generation_jobs"] = () => [{ id: JOB, status: "running", model: jobModel }];
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
      "it reserved its slot under ITS attempt id (item, job, attempts + 1) before the claim",
      rpcHits("reserve_generation_slot")[0]?.body?._request_id === expectedId &&
        rpcAt("reserve_generation_slot") < indexOf((h) => h.kind === "rest" && h.method === "PATCH" && h.body?.status === "running"),
    );
    t(
      "…held its spend under the SAME id, as a batch generation",
      rpcHits("ai_reserve")[0]?.body?._request_id === expectedId && rpcHits("ai_reserve")[0]?.body?._source === "batch_generation",
    );
    t(
      "…marked both before the provider (the hold first, then the slot), settled after it, and released nothing",
      rpcHits("mark_generation_provider_called")[0]?.body?._request_id === expectedId &&
        rpcHits("ai_mark_called")[0]?.body?._request_id === expectedId &&
        rpcAt("ai_mark_called") < rpcAt("mark_generation_provider_called") &&
        rpcAt("mark_generation_provider_called") < indexOf((h) => h.kind === "openai") &&
        rpcAt("ai_settle") > indexOf((h) => h.kind === "openai") &&
        rpcHits("release_generation_slot").length === 0 &&
        rpcHits("ai_release").length === 0,
    );
    t("the claim wrote attempts + 1", claimPatch()?.body?.attempts === 2);
    t(
      "the draft is saved before the settlement",
      indexOf((h) => h.kind === "rest" && h.method === "POST" && h.name === "tenant_pages") < rpcAt("ai_settle"),
    );
    const done = patches().find((h) => h.body?.status === "done");
    t(
      "the item records its page and what the settlement charged, in one write",
      done?.body?.page_id === "page-1" && done?.body?.credits_charged === 0 && done?.body?.billing_status === "free" && done?.body?.prompt_tokens === 812,
      JSON.stringify(done?.body),
    );
  }
  {
    batchReset({}, "gpt-5-mini");
    await runItem(WS, USER, ITEM);
    t("a premium job holds and calls gpt-5-mini", rpcHits("ai_reserve")[0]?.body?._model === "gpt-5-mini" && providerHits()[0]?.body?.model === "gpt-5-mini");
  }
  {
    batchReset({}, "google/gemini-3-flash-preview");
    await runItem(WS, USER, ITEM);
    t(
      "a job that stored a model outside the allowlist is refused, never mapped to another model",
      patches()[0]?.body?.status === "failed" && patches()[0]?.body?.error === GENERATION_UNAVAILABLE_MESSAGE && rpcHits("reserve_generation_slot").length === 0 && noSpend(),
      JSON.stringify(patches()[0]?.body),
    );
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
      "…without claiming it, consuming an attempt or holding any spend",
      !claimPatch() && patches().every((h) => h.body?.attempts === undefined) && noSpend() && out.item.attempts === 1,
    );
  }
  for (const answer of ["in_progress", "consumed"]) {
    batchReset();
    rpc.reserve_generation_slot = () => answer;
    const out = await runItem(WS, USER, ITEM);
    t(
      `'${answer}' (another driver holds or spent this attempt): the item is left alone`,
      out.changed === false && patches().length === 0 && noSpend() && rpcHits("release_generation_slot").length === 0,
    );
  }
  {
    batchReset();
    rpc.tenant_get_workspace_secret = () => null;
    await runItem(WS, USER, ITEM);
    t(
      "a billing refusal (no key) refuses the item without a slot, a hold or a claim",
      rpcHits("reserve_generation_slot").length === 0 && rpcHits("release_generation_slot").length === 0 && noSpend() && !claimPatch() &&
        patches()[0]?.body?.status === "failed" && patches()[0]?.body?.error === AI_MESSAGES.notConfigured,
      JSON.stringify(patches()[0]?.body),
    );
  }
  {
    const row = batchReset();
    rest["PATCH generation_items"] = (h) => (h.body?.status === "running" ? [] : [{ id: ITEM }]);
    const out = await runItem(WS, USER, ITEM);
    t(
      "a lost claim (the item moved on) releases the slot and holds nothing",
      out.changed === false && rpcHits("release_generation_slot").length === 1 && noSpend(),
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
      "linking an existing page instead of generating releases the slot and holds nothing",
      noSpend() && rpcHits("mark_generation_provider_called").length === 0 && rpcHits("release_generation_slot").length === 1,
    );
  }
  {
    batchReset();
    rpc.ai_reserve = () => ({ status: "insufficient" });
    await runItem(WS, USER, ITEM);
    t(
      "a refused hold gives the attempt's slot back and records the customer sentence",
      providerHits().length === 0 && rpcHits("release_generation_slot").length === 1 &&
        patches().some((h) => h.body?.status === "failed" && h.body?.error === outOfCreditsMessage()),
    );
  }
  {
    batchReset();
    openai = () => new Response("nope", { status: 503 });
    await runItem(WS, USER, ITEM);
    const s = settles()[0];
    t("a provider failure after the marks keeps the slot and the hold spent", rpcHits("release_generation_slot").length === 0 && rpcHits("ai_release").length === 0 && providerHits().length === 1);
    t(
      "…and settles the spend 'failed' at the full hold",
      s?._outcome === "failed" && s?._error === "server_error" && s?._cost_micros === null,
      JSON.stringify(s),
    );
    t("…the item records the customer message", patches().some((h) => h.body?.status === "failed" && h.body?.error === PROVIDER_ERROR_MESSAGE));
  }
  {
    batchReset({ page_id: "page-7", billing_status: "free", status: "failed" });
    await runItem(WS, USER, ITEM);
    t(
      "an item whose draft exists (a run died after linking) takes no slot, no hold and calls no provider",
      rpcHits("reserve_generation_slot").length === 0 && rpcHits("release_generation_slot").length === 0 && noSpend(),
    );
  }

  // -------------------------------------------------------------------------
  console.log("\n=== batch: a spend refusal before the provider call never consumes an attempt (round-4 M1) ===");
  {
    /** A stateful item: every PATCH honours the fence the code sends (status, attempts). */
    function statefulItem(start: Record<string, unknown> = {}) {
      const box = { row: { ...baseItem, attempts: 0, status: "pending", ...start } as Record<string, any> };
      rest["GET generation_items"] = (h) => (h.query.get("select") === "status" ? [{ status: box.row.status }] : [box.row]);
      rest["GET generation_jobs"] = () => [{ id: JOB, status: "running", model: null }];
      rest["PATCH generation_items"] = (h) => {
        const st = h.query.get("status");
        const at = h.query.get("attempts");
        if (st && st !== `eq.${box.row.status}`) return [];
        if (at && at !== `eq.${box.row.attempts}`) return [];
        box.row = { ...box.row, ...h.body };
        return [box.row];
      };
      return box;
    }
    const refusals: Array<[string, string, () => void]> = [
      ["insufficient", outOfCreditsMessage(), () => void (rpc.ai_reserve = () => ({ status: "insufficient" }))],
      ["budget_exhausted", AI_MESSAGES.budgetExhausted, () => void (rpc.ai_reserve = () => ({ status: "budget_exhausted" }))],
      ["workspace_budget_exhausted", AI_MESSAGES.workspaceBudgetExhausted, () => void (rpc.ai_reserve = () => ({ status: "workspace_budget_exhausted" }))],
      ["platform_paused", AI_MESSAGES.platformPaused, () => void (rpc.ai_reserve = () => ({ status: "platform_paused" }))],
      ["rate_limited", AI_MESSAGES.rateLimited, () => void (rpc.ai_reserve = () => ({ status: "rate_limited" }))],
      ["a refused mark", GENERATION_UNAVAILABLE_MESSAGE, () => void (rpc.ai_mark_called = () => false)],
    ];
    for (const [label, message, refuse] of refusals) {
      reset();
      const item = statefulItem();
      refuse();
      const ids = new Set<string>();
      for (let run = 1; run <= 5; run++) {
        await runItem(WS, USER, ITEM);
        ids.add(String(rpcHits("reserve_generation_slot").at(-1)?.body?._request_id));
      }
      t(
        `${label} ×5 through the real runItem: attempts still 0 — the item never reaches "gave up after 3"`,
        item.row.attempts === 0 && item.row.status === "failed" && item.row.error === message && item.row.error !== ATTEMPTS_EXHAUSTED_MESSAGE,
        JSON.stringify(item.row),
      );
      t(`${label}: no provider request, and each run's slot went back`, providerHits().length === 0 && rpcHits("release_generation_slot").length === 5);
      t(`${label}: every run asked under the SAME attempt id (nothing was spent under it)`, ids.size === 1, [...ids].join(","));
      reset();
      rest["GET generation_items"] = (h) => (h.query.get("select") === "status" ? [{ status: item.row.status }] : [item.row]);
      rest["GET generation_jobs"] = () => [{ id: JOB, status: "running", model: null }];
      rest["PATCH generation_items"] = (h) => {
        const st = h.query.get("status");
        const at = h.query.get("attempts");
        if (st && st !== `eq.${item.row.status}`) return [];
        if (at && at !== `eq.${item.row.attempts}`) return [];
        item.row = { ...item.row, ...h.body };
        return [item.row];
      };
      await runItem(WS, USER, ITEM);
      t(`${label}: once it clears, the item generates on its first real attempt`, item.row.status === "done" && item.row.attempts === 1 && providerHits().length === 1, JSON.stringify(item.row));
    }
    // The counter still bounds PROVIDER calls: three failures after the call give up.
    reset();
    const failing = statefulItem();
    openai = () => new Response("nope", { status: 503 });
    for (let run = 1; run <= 4; run++) await runItem(WS, USER, ITEM);
    t(
      "a provider failure (after the call) still consumes its attempt: three calls, then \"gave up\"",
      failing.row.attempts === 3 && failing.row.error === ATTEMPTS_EXHAUSTED_MESSAGE && providerHits().length === 3,
      JSON.stringify({ row: failing.row, calls: providerHits().length }),
    );
    // A refused SLOT mark after the hold was marked: the attempt's id is spent
    // (its hold settled at zero), so the attempt is consumed and the next run
    // gets a fresh id instead of 'done' forever.
    reset();
    const slotRefused = statefulItem();
    rpc.mark_generation_provider_called = () => false;
    await runItem(WS, USER, ITEM);
    t(
      "a refused slot mark (after the hold mark) consumes the attempt: its request id is settled, never reused",
      slotRefused.row.attempts === 1 && providerHits().length === 0 && settles()[0]?._error === "not_sent",
      JSON.stringify(slotRefused.row),
    );
  }

  // -------------------------------------------------------------------------
  console.log("\n=== the founder / internal unlimited entitlement lifts the daily cap, never the slot ===");
  for (const [label, answer, cap] of [
    ["an ordinary workspace", () => false, 50],
    ["an internal-unlimited workspace", () => true, 2_147_483_647],
    ["a failed internal read (fails closed: the cap stays)", () => ({ status: 500, body: { message: "read exploded" } }), 50],
  ] as const) {
    reset();
    rpc.workspace_is_internal_unlimited = answer as () => unknown;
    const r = await quick();
    t(
      `quick page, ${label}: the slot is still reserved, with cap ${cap}`,
      r.ok !== null && rpcHits("reserve_generation_slot").length === 1 && rpcHits("reserve_generation_slot")[0]?.body?._cap === cap,
      JSON.stringify(rpcHits("reserve_generation_slot")[0]?.body) + errMsg(r.err),
    );
    batchReset();
    rpc.workspace_is_internal_unlimited = answer as () => unknown;
    await runItem(WS, USER, ITEM);
    t(`batch item, ${label}: cap ${cap}`, rpcHits("reserve_generation_slot")[0]?.body?._cap === cap, JSON.stringify(rpcHits("reserve_generation_slot")[0]?.body));
  }

  // -------------------------------------------------------------------------
  console.log("\n=== quick page: a publish-step error after a saved, charged page (round-4 L2) ===");
  for (const [label, breakIt] of [
    ["the contract read fails", () => void (rest["GET tenant_pages"] = (h) => (h.query.get("id") === "eq.page-1" ? { status: 500, body: { message: "contract read exploded" } } : []))],
    ["the entitlement gate fails", () => void (rpc.publish_tenant_pages = () => ({ status: 500, body: { message: "gate exploded" } }))],
  ] as const) {
    reset();
    rest["GET page_templates"] = () => [{ id: "tpl-1" }];
    rest["GET tenant_listings"] = () => [];
    breakIt();
    if (label === "the entitlement gate fails") {
      rest["GET tenant_pages"] = (h) =>
        h.query.get("id") === "eq.page-1"
          ? [{ id: "page-1", slug: "boats-in-austin", title: "Boats in Austin", meta_description: "Rent a boat in Austin with local owners and real listings.", h1: "Boats in Austin", body_markdown: BODY, listing_filter: { city: "Austin" }, variables: { city: "Austin" }, status: "draft" }]
          : [];
    }
    const r = await quick({ autoPublish: true });
    t(
      `${label}: the saved draft comes back (ok, not published) with the plain reason — never a generation failure`,
      r.err === null && r.ok?.page.id === "page-1" && r.ok?.published === false && r.ok?.draftReason === PUBLISH_STEP_FAILED_MESSAGE,
      errMsg(r.err) + JSON.stringify(r.ok),
    );
    t(`${label}: exactly one provider call and one settlement (delivered, so charged once)`, providerHits().length === 1 && settles().length === 1 && settles()[0]?._outcome === "ok");
    t(
      `${label}: the failure really was in that step`,
      label === "the entitlement gate fails" ? rpcHits("publish_tenant_pages").length === 1 : rpcHits("publish_tenant_pages").length === 0,
    );
  }

  // -------------------------------------------------------------------------
  console.log("\n=== the model choice, end to end (the tier in the body → the model OpenAI receives) ===");
  {
    const base = { workspaceId: WS, title: "Boats in Austin", topic: "City hub page for boat rentals in Austin, Texas" };
    t(
      "createQuickPage's strict schema: a tier only — a model, a provider or an unknown tier is refused",
      QuickPageInputSchema.safeParse({ ...base, quality: "premium" }).success &&
        !QuickPageInputSchema.safeParse({ ...base, quality: "gpt-5-mini" }).success &&
        !QuickPageInputSchema.safeParse({ ...base, model: "gpt-5-mini" }).success &&
        !QuickPageInputSchema.safeParse({ ...base, provider: "openai" }).success &&
        !QuickPageInputSchema.safeParse({ ...base, quality: "gemini-3.1-pro" }).success,
    );
    for (const [quality, model] of [["standard", "gpt-5-nano"], ["premium", "gpt-5-mini"], [undefined, "gpt-5-nano"]] as const) {
      reset();
      const r = await quick(quality ? { quality } : {});
      const hold = rpcHits("ai_reserve")[0]?.body;
      t(
        `quick page, quality ${quality ?? "(omitted → standard)"}: the hold and the request OpenAI received are both ${model}`,
        r.ok !== null && hold?._model === model && providerHits()[0]?.body?.model === model && providerHits().length === 1,
        JSON.stringify({ hold: hold?._model, sent: providerHits()[0]?.body?.model }) + errMsg(r.err),
      );
    }
    // Batch: the request body → the strict schema → startJob stores the
    // server's model on the job → runItem → the hold and the request.
    t(
      "startGenerationJob's strict schema: a tier only",
      !!StartGenerationJobInputSchema.parse({ workspaceId: WS, targetKeys: ["city:austin|tx"], quality: "premium" }) &&
        !StartGenerationJobInputSchema.safeParse({ workspaceId: WS, targetKeys: ["city:austin|tx"], model: "gpt-5-mini" }).success &&
        !StartGenerationJobInputSchema.safeParse({ workspaceId: WS, targetKeys: ["city:austin|tx"], quality: "gpt-5-mini" }).success,
    );
    reset();
    pageBuilderStub.cities = [{ city: "Austin", state: "TX", listingCount: 5, hasPage: false }];
    pageBuilderStub.syncedListings = 5;
    pageBuilderStub.dominantCategory = "boat rentals";
    let jobRow: Record<string, any> | null = null;
    let itemRow: Record<string, any> | null = null;
    rest["POST generation_jobs"] = (h) => {
      jobRow = { id: JOB, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), finished_at: null, ...h.body };
      return [jobRow];
    };
    rest["GET generation_jobs"] = () => (jobRow ? [jobRow] : []);
    rest["POST generation_items"] = (h) => {
      const body = Array.isArray(h.body) ? h.body[0] : h.body;
      itemRow = { ...baseItem, ...body, id: ITEM, attempts: 0 };
      return [itemRow];
    };
    rest["GET generation_items"] = (h) => {
      if (h.query.get("target_key")) return []; // the plan's read of existing items
      if (h.query.get("select") === "status") return itemRow ? [{ status: itemRow.status }] : [];
      return itemRow ? [itemRow] : [];
    };
    rest["PATCH generation_items"] = (h) => {
      if (!itemRow) return [];
      const st = h.query.get("status");
      const at = h.query.get("attempts");
      if (st && st !== `eq.${itemRow.status}`) return [];
      if (at && at !== `eq.${itemRow.attempts}`) return [];
      itemRow = { ...itemRow, ...h.body };
      return [itemRow];
    };
    const data = StartGenerationJobInputSchema.parse({ workspaceId: WS, targetKeys: ["city:austin|tx"], quality: "premium" });
    const started = await startJob(data, USER);
    t(
      "batch start: the job row stores the model the SERVER resolved from 'premium' (gpt-5-mini), requested by this user",
      (jobRow as any)?.model === "gpt-5-mini" && (jobRow as any)?.requested_by === USER && (started.job as any)?.model === "gpt-5-mini",
      JSON.stringify(jobRow),
    );
    await runItem(WS, USER, ITEM);
    const hold = rpcHits("ai_reserve")[0]?.body;
    t(
      "…the item runs on the job's model: the hold and the request OpenAI received are gpt-5-mini",
      hold?._model === "gpt-5-mini" && providerHits().length === 1 && providerHits()[0]?.body?.model === "gpt-5-mini" && (itemRow as any)?.status === "done",
      JSON.stringify({ hold: hold?._model, sent: providerHits()[0]?.body?.model, item: (itemRow as any)?.status }),
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
