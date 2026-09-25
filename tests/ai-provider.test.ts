/**
 * THE OPENAI PROVIDER MODULE, OFFLINE. Run: bun tests/ai-provider.test.ts
 *
 * Drives the real src/lib/ai/openai.server.ts — the real openai@7.23.0 SDK
 * building real HTTP requests — against a fake Responses API injected as the
 * client's fetch. No key exists here and nothing leaves the process: the fake
 * refuses any host but api.openai.com and answers from a script.
 *
 * Proves, for every outcome the brief lists (success text + structured,
 * structured output matching the schema, malformed JSON, schema mismatch,
 * refusal, incomplete at max_output_tokens, timeout mid-body, timeout before
 * headers, 401, 429, 500/503, network error, non-JSON 200):
 *   - the typed result (ok / kind / sent / usage) the spend flow settles on;
 *   - every request carries an allowlisted model, the route's
 *     max_output_tokens, store:false, reasoning.effort "minimal", and NO
 *     temperature / top_p; structured routes carry text.format json_schema
 *     strict with the schema;
 *   - the client is pinned (baseURL, no retries: exactly one request per
 *     call even for 429/5xx), and env vars cannot redirect it;
 *   - no result and no log line ever contains the key.
 * Also pins the route table, the pricing table (and its Deno mirror) and
 * the model policy.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

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

// An environment that tries to redirect the client: the module must ignore it.
process.env.OPENAI_BASE_URL = "https://evil.example/v1";
process.env.OPENAI_ORG_ID = "org-should-not-be-sent";
process.env.OPENAI_PROJECT_ID = "proj-should-not-be-sent";

const { callOpenAI, verifyOpenAiKey, redactSecrets, OPENAI_API_BASE_URL } = await import(
  "../src/lib/ai/openai.server"
);
const { AI_ROUTE_LIMITS, AI_ROUTES, ADD_META_MAX_PAGES, routeModel } = await import("../src/lib/ai/limits");
const { AI_MODELS, AI_DEFAULT_MODEL, AI_REASONING_EFFORT, modelForTier, isAllowedModel } = await import(
  "../src/lib/ai/models"
);
const pricing = await import("../src/lib/ai-pricing");

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const KEY = "sk-test-FAKEKEY-0123456789abcdefghijklmnopqrstuvwxyz";

type Captured = { url: string; method: string; headers: Headers; body: any };
let captured: Captured[] = [];
let script: (c: Captured, init?: RequestInit) => Promise<Response> | Response = () =>
  new Response("no script", { status: 500 });

const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url);
  if (u.hostname !== "api.openai.com") throw new TypeError(`unexpected host ${u.host}`);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  const c: Captured = { url, method: String(init?.method ?? "GET"), headers: new Headers(init?.headers), body };
  captured.push(c);
  return script(c, init);
};
const transport = { fetch: fakeFetch };

const jsonResponse = (status: number, payload: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req_test_123", ...headers },
  });

const usage = { input_tokens: 812, input_tokens_details: { cached_tokens: 100 }, output_tokens: 1204, output_tokens_details: { reasoning_tokens: 200 }, total_tokens: 2016 };
function responseObject(parts: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return {
    id: "resp_test_1",
    object: "response",
    created_at: 1_700_000_000,
    status: "completed",
    model: "gpt-5-nano",
    output: [
      { type: "reasoning", id: "rs_1", summary: [] },
      { type: "message", id: "msg_1", role: "assistant", status: "completed", content: parts },
    ],
    usage,
    ...extra,
  };
}
const text = (s: string) => ({ type: "output_text", text: s, annotations: [] });

const PageSchema = z.object({ title: z.string(), body: z.string().min(10) }).strict();
const format = {
  name: "write_page",
  schema: {
    type: "object",
    properties: { title: { type: "string" }, body: { type: "string" } },
    required: ["title", "body"],
    additionalProperties: false,
  },
  parse: (v: unknown) => {
    const r = PageSchema.safeParse(v);
    return r.success ? r.data : null;
  },
};

const logs: string[] = [];
const log = (l: string) => logs.push(l);
const base = {
  apiKey: KEY,
  model: "gpt-5-nano" as const,
  instructions: "You write pages.",
  input: "Write a page about boats.",
  maxOutputTokens: 6000,
  timeoutMs: 5_000,
  transport,
  log,
};
function reset(s: typeof script) {
  captured = [];
  logs.length = 0;
  script = s;
}
const noKey = (v: unknown) => !JSON.stringify(v ?? null).includes(KEY) && !JSON.stringify(v ?? null).includes("FAKEKEY");

// ---------------------------------------------------------------------------
console.log("\n=== success: text ===");
{
  reset(() => jsonResponse(200, responseObject([text("Hello "), text("world")])));
  const r = await callOpenAI({ ...base });
  t("ok with the concatenated output text", r.ok === true && r.ok && r.text === "Hello world" && r.data === null, JSON.stringify(r));
  t(
    "usage is read from the API (input, cached, output incl. reasoning)",
    r.ok && r.usage?.inputTokens === 812 && r.usage?.cachedInputTokens === 100 && r.usage?.outputTokens === 1204 && r.usage?.reasoningTokens === 200,
    JSON.stringify(r.ok && r.usage),
  );
  t("the request id and response id are kept", r.ok && r.requestId === "req_test_123" && r.responseId === "resp_test_1");
  const c = captured[0]!;
  t("exactly one request", captured.length === 1);
  t("POST to the pinned base URL /responses (env OPENAI_BASE_URL ignored)", c.method === "POST" && c.url === `${OPENAI_API_BASE_URL}/responses`, c.url);
  t("bearer auth with the given key", c.headers.get("authorization") === `Bearer ${KEY}`);
  t("no organization / project header from the environment", !c.headers.has("openai-organization") && !c.headers.has("openai-project"));
  t("the allowlisted model is sent", c.body.model === "gpt-5-nano");
  t("max_output_tokens is the caller's route limit", c.body.max_output_tokens === 6000);
  t("store: false", c.body.store === false);
  t("reasoning.effort is minimal", c.body.reasoning?.effort === "minimal" && AI_REASONING_EFFORT === "minimal");
  t("no temperature or top_p for a reasoning model", !("temperature" in c.body) && !("top_p" in c.body));
  t("instructions and input are passed through", c.body.instructions === "You write pages." && c.body.input === "Write a page about boats.");
  t("no text.format on a plain-text route", c.body.text === undefined);
  t("no stream, no tools, no background", !c.body.stream && !c.body.tools && !c.body.background);
}

console.log("\n=== success: structured output matching the schema ===");
{
  reset(() => jsonResponse(200, responseObject([text(JSON.stringify({ title: "Boats", body: "A real page about boats." }))])));
  const r = await callOpenAI({ ...base, format });
  t("ok with the validated value", r.ok && r.data?.title === "Boats" && r.data?.body === "A real page about boats.", JSON.stringify(r));
  const c = captured[0]!;
  t(
    "text.format is json_schema, strict, named, with the schema",
    c.body.text?.format?.type === "json_schema" &&
      c.body.text.format.strict === true &&
      c.body.text.format.name === "write_page" &&
      JSON.stringify(c.body.text.format.schema) === JSON.stringify(format.schema),
    JSON.stringify(c.body.text),
  );
  reset(() =>
    jsonResponse(200, responseObject([text(JSON.stringify({ title: "Boats", body: "A real page about boats." }))]), {}),
  );
  const msgs = await callOpenAI({ ...base, input: [{ role: "user", content: "hi" }, { role: "assistant", content: "yes?" }, { role: "user", content: "go" }] });
  t(
    "a conversation is sent as role/content messages",
    msgs.ok && JSON.stringify(captured[0]!.body.input) === JSON.stringify([{ role: "user", content: "hi" }, { role: "assistant", content: "yes?" }, { role: "user", content: "go" }]),
  );
}

console.log("\n=== failures after the provider answered (usage kept for settlement) ===");
{
  reset(() => jsonResponse(200, responseObject([text("{not json")])));
  const malformed = await callOpenAI({ ...base, format });
  t("malformed JSON → kind malformed, sent, usage kept", !malformed.ok && malformed.kind === "malformed" && malformed.sent && malformed.usage?.outputTokens === 1204, JSON.stringify(malformed));

  reset(() => jsonResponse(200, responseObject([text(JSON.stringify({ title: "only a title" }))])));
  const mismatch = await callOpenAI({ ...base, format });
  t("schema mismatch → kind schema_mismatch, usage kept", !mismatch.ok && mismatch.kind === "schema_mismatch" && mismatch.usage?.inputTokens === 812);

  reset(() => jsonResponse(200, responseObject([{ type: "refusal", refusal: "I can't help with that." }])));
  const refusal = await callOpenAI({ ...base, format });
  t("refusal → kind refusal, usage kept", !refusal.ok && refusal.kind === "refusal" && refusal.usage !== null);
  t("…the refusal prose is not carried in the result", !JSON.stringify(refusal).includes("can't help"));

  reset(() =>
    jsonResponse(200, responseObject([text("{\"title\":\"Bo")], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })),
  );
  const incomplete = await callOpenAI({ ...base, format });
  t(
    "incomplete (max_output_tokens) → kind incomplete, detail names the reason, usage kept",
    !incomplete.ok && incomplete.kind === "incomplete" && incomplete.detail === "max_output_tokens" && incomplete.usage?.outputTokens === 1204,
    JSON.stringify(incomplete),
  );
  reset(() =>
    jsonResponse(200, responseObject([], { status: "incomplete", incomplete_details: { reason: "content_filter" } })),
  );
  const filtered = await callOpenAI({ ...base });
  t("incomplete (content_filter) → kind incomplete / content_filter", !filtered.ok && filtered.kind === "incomplete" && filtered.detail === "content_filter");

  reset(() => jsonResponse(200, responseObject([text("   ")])));
  const empty = await callOpenAI({ ...base });
  t("an empty answer → kind empty", !empty.ok && empty.kind === "empty");

  reset(() => jsonResponse(200, { ...responseObject([text("x")]), usage: undefined }));
  const noUsage = await callOpenAI({ ...base });
  t("a success without usage reports usage null (the flow then settles at the full hold)", noUsage.ok && noUsage.usage === null);

  reset(() => new Response("<html>bad gateway trace-id=xyz</html>", { status: 200, headers: { "content-type": "text/html" } }));
  const html = await callOpenAI({ ...base });
  t("a 200 that is not a JSON response object → kind malformed, sent", !html.ok && html.kind === "malformed" && html.sent, JSON.stringify(html));
}

console.log("\n=== HTTP errors: typed, one request (no retries), no provider prose ===");
{
  const errBody = (message: string, type: string, code: string) => ({ error: { message, type, code, param: null } });
  reset(() => jsonResponse(401, errBody(`Incorrect API key provided: sk-test-****wxyz. You can find your API key at https://platform.openai.com/account/api-keys.`, "invalid_request_error", "invalid_api_key"), { "x-request-id": "req_auth_1" }));
  const auth = await callOpenAI({ ...base });
  t("401 → kind auth, httpStatus 401, request id kept", !auth.ok && auth.kind === "auth" && auth.httpStatus === 401 && auth.requestId === "req_auth_1", JSON.stringify(auth));
  t("…logged with status, kind and request id only (no provider message)", logs.length === 1 && /auth status=401 request_id=req_auth_1/.test(logs[0]!) && !/Incorrect API key/.test(logs[0]!), logs.join(" | "));
  t("…nothing in the result or the log carries the key or the masked fragment", noKey(auth) && !logs.join(" ").includes("sk-test-****") && noKey(logs));

  reset(() => jsonResponse(403, errBody("Project does not have access to model", "invalid_request_error", "model_not_found")));
  const forbidden = await callOpenAI({ ...base });
  t("403 → kind auth", !forbidden.ok && forbidden.kind === "auth" && forbidden.httpStatus === 403);

  reset(() => jsonResponse(400, errBody(`Invalid schema for response_format 'write_page'. key ${KEY}`, "invalid_request_error", "invalid_json_schema")));
  const bad = await callOpenAI({ ...base });
  t("400 → kind bad_request", !bad.ok && bad.kind === "bad_request" && bad.httpStatus === 400);
  t("…a logged message is redacted (the key never appears)", logs.length === 1 && !logs[0]!.includes(KEY) && logs[0]!.includes("[redacted"), logs.join(" | "));

  reset(() => jsonResponse(429, errBody("Rate limit reached for gpt-5-nano", "requests", "rate_limit_exceeded"), { "retry-after": "0" }));
  const limited = await callOpenAI({ ...base });
  t("429 → kind rate_limited, exactly ONE request (maxRetries 0)", !limited.ok && limited.kind === "rate_limited" && captured.length === 1, `${captured.length} requests`);

  for (const status of [500, 503]) {
    reset(() => jsonResponse(status, errBody("The server had an error", "server_error", "server_error")));
    const r = await callOpenAI({ ...base });
    t(`${status} → kind server_error, exactly one request`, !r.ok && r.kind === "server_error" && r.httpStatus === status && captured.length === 1);
  }
  t("no HTTP-error result carries usage (none was reported)", [auth, forbidden, bad, limited].every((r) => !r.ok && r.usage === null && r.sent));
}

console.log("\n=== transport failures ===");
{
  reset(() => {
    throw new TypeError("fetch failed: ECONNRESET 10.0.0.1");
  });
  const net = await callOpenAI({ ...base });
  t("network error → kind network, sent (the request may have left)", !net.ok && net.kind === "network" && net.sent && captured.length === 1, JSON.stringify(net));
  t("…the detail stays in the log", logs.some((l) => l.includes("ECONNRESET")));

  // Headers never arrive: the fetch honours the abort signal like a real one.
  reset(
    (_c, init) =>
      new Promise<Response>((_, reject) => {
        const sig = init?.signal;
        if (!sig) return reject(new Error("no signal"));
        sig.addEventListener("abort", () => reject(sig.reason ?? new DOMException("aborted", "AbortError")), { once: true });
      }),
  );
  const t0 = Date.now();
  const hung = await callOpenAI({ ...base, timeoutMs: 60 });
  t("a hung provider → kind timeout within the route's timeout", !hung.ok && hung.kind === "timeout" && Date.now() - t0 < 2_000, JSON.stringify(hung));

  // Headers arrive, then the body stalls: the SDK's own timer is already
  // cleared (it covers headers only). Our signal must still end it.
  reset((_c, init) => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('{"id":"resp_slow","object":"response","status":"comp'));
        init?.signal?.addEventListener(
          "abort",
          () => controller.error(new DOMException("The operation was aborted.", "AbortError")),
          { once: true },
        );
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
  });
  const t1 = Date.now();
  const midBody = await callOpenAI({ ...base, timeoutMs: 80 });
  t("a timeout MID-BODY → kind timeout (not a hang, not a parse error)", !midBody.ok && midBody.kind === "timeout" && Date.now() - t1 < 2_000, JSON.stringify(midBody));
  t("…sent, httpStatus 200, no usage (unknown: the flow settles at the full hold)", !midBody.ok && midBody.sent && midBody.httpStatus === 200 && midBody.usage === null);
  t("…the raw abort text is not in the result", !JSON.stringify(midBody).includes("aborted"));
}

console.log("\n=== who pays: every provider outcome onto the two books (settleInputFor) ===");
{
  // The real classification (callOpenAI against the fake API) feeds the
  // real settle mapping. The database side of each row is exercised in
  // tests/ai-spend-sql.test.ts ("two books").
  const { settleInputFor, REJECTED_BEFORE_GENERATION } = await import("../src/lib/ai/spend.server");
  const errBody = { error: { message: "no", type: "invalid_request_error", code: "x", param: null } };
  type Row = { label: string; run: () => Promise<any>; check?: string | null; outcome: "ok" | "failed"; cost: "zero" | "priced" | "unknown" };
  const pricedUsage = pricing.costMicrosForUsage("gpt-5-nano", { inputTokens: 812, cachedInputTokens: 100, outputTokens: 1204 });
  const rows: Row[] = [
    { label: "delivered with usage", run: () => { reset(() => jsonResponse(200, responseObject([text("fine")]))); return callOpenAI({ ...base }); }, outcome: "ok", cost: "priced" },
    { label: "delivered without usage", run: () => { reset(() => jsonResponse(200, responseObject([text("fine")], { usage: undefined }))); return callOpenAI({ ...base }); }, outcome: "ok", cost: "unknown" },
    ...[400, 401, 403, 404, 409, 422, 429].map((status) => ({
      label: `HTTP ${status} (rejected before generation)`,
      run: () => { reset(() => jsonResponse(status, errBody)); return callOpenAI({ ...base }); },
      outcome: "failed" as const,
      cost: "zero" as const,
    })),
    ...[402, 408, 413, 500, 502, 503].map((status) => ({
      label: `HTTP ${status} (unknown)`,
      run: () => { reset(() => jsonResponse(status, errBody)); return callOpenAI({ ...base }); },
      outcome: "failed" as const,
      cost: "unknown" as const,
    })),
    { label: "network error after sending", run: () => { reset(() => { throw new TypeError("fetch failed"); }); return callOpenAI({ ...base }); }, outcome: "failed", cost: "unknown" },
    {
      label: "timeout after sending",
      run: () => {
        reset((_c, init) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true })));
        return callOpenAI({ ...base, timeoutMs: 40 });
      },
      outcome: "failed",
      cost: "unknown",
    },
    { label: "refusal with usage", run: () => { reset(() => jsonResponse(200, responseObject([{ type: "refusal", refusal: "no" }]))); return callOpenAI({ ...base }); }, outcome: "failed", cost: "priced" },
    { label: "incomplete with usage", run: () => { reset(() => jsonResponse(200, responseObject([text("cut")], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }))); return callOpenAI({ ...base }); }, outcome: "failed", cost: "priced" },
    { label: "malformed JSON with usage", run: () => { reset(() => jsonResponse(200, responseObject([text("{not json")]))); return callOpenAI({ ...base, format }); }, outcome: "failed", cost: "priced" },
    { label: "schema-invalid with usage", run: () => { reset(() => jsonResponse(200, responseObject([text('{"title":"x"}')]))); return callOpenAI({ ...base, format }); }, outcome: "failed", cost: "priced" },
    { label: "delivered but rejected by the route's check", run: () => { reset(() => jsonResponse(200, responseObject([text("short")]))); return callOpenAI({ ...base }); }, check: "thin_output", outcome: "failed", cost: "priced" },
  ];
  for (const row of rows) {
    const r = await row.run();
    const si = settleInputFor("gpt-5-nano", r, row.check ?? null);
    const costOk = row.cost === "zero" ? si.costMicros === 0 : row.cost === "unknown" ? si.costMicros === null : si.costMicros === pricedUsage;
    const creditsOk =
      si.costMicros === null ? si.credits === null : row.outcome === "ok" ? si.credits === pricing.creditsForCostMicros(si.costMicros) : si.credits === 0;
    t(
      `${row.label} → customer ${row.outcome === "ok" ? "charged" : "refunded"}, platform ${row.cost}`,
      si.outcome === row.outcome && costOk && creditsOk && (si.error === null || /^[a-z_]{1,40}$/.test(si.error)),
      JSON.stringify({ kind: (r as any).kind, http: (r as any).httpStatus, si: { ...si, usage: undefined } }),
    );
  }
  const unsent = settleInputFor("gpt-5-nano", { ok: false, kind: "network", detail: null, sent: false, usage: null, httpStatus: null, requestId: null }, null);
  t("a request that never left → refunded, platform zero, error not_sent", unsent.outcome === "failed" && unsent.costMicros === 0 && unsent.error === "not_sent");
  t("the rejection set is exactly 400/401/403/404/409/422/429", [...REJECTED_BEFORE_GENERATION].sort((a, b) => a - b).join() === "400,401,403,404,409,422,429");
  const deno = read("supabase/functions/_shared/openai.ts");
  t(
    "the briefing's Deno wrapper uses the same rejection set",
    /REJECTED_BEFORE_GENERATION = new Set\(\[400, 401, 403, 404, 409, 422, 429\]\)/.test(deno),
  );
}

console.log("\n=== programming errors are refused before anything is sent ===");
{
  reset(() => jsonResponse(200, responseObject([text("x")])));
  let threw = false;
  try {
    await callOpenAI({ ...base, model: "gpt-4o" as any });
  } catch {
    threw = true;
  }
  t("a model outside the allowlist throws, and no request is made", threw && captured.length === 0);
  threw = false;
  try {
    await callOpenAI({ ...base, format: { ...format, name: "bad name!" } });
  } catch {
    threw = true;
  }
  t("an invalid format name throws before sending", threw && captured.length === 0);
  threw = false;
  try {
    await callOpenAI({ ...base, apiKey: "" });
  } catch {
    threw = true;
  }
  t("no key throws before sending", threw && captured.length === 0);
}

console.log("\n=== key check: zero-token models.retrieve ===");
{
  reset(() => jsonResponse(200, { id: "gpt-5-nano", object: "model", created: 1, owned_by: "system" }));
  const ok = await verifyOpenAiKey(KEY, transport);
  t("a valid key → ok, via GET /models/gpt-5-nano", ok.ok && captured.length === 1 && captured[0]!.method === "GET" && captured[0]!.url === `${OPENAI_API_BASE_URL}/models/gpt-5-nano`, captured[0]?.url);
  t("…no generation endpoint is touched (nothing is spent)", captured.every((c) => !c.url.includes("/responses")));
  reset(() => jsonResponse(401, { error: { message: "Incorrect API key provided: sk-test-****wxyz", type: "invalid_request_error", code: "invalid_api_key" } }));
  const bad = await verifyOpenAiKey(KEY, transport);
  t("an invalid key → invalid_key, no key text", !bad.ok && bad.reason === "invalid_key" && noKey(bad));
}

console.log("\n=== redaction ===");
{
  t("the literal key is redacted", !redactSecrets(`x ${KEY} y`, KEY).includes(KEY));
  t("key-shaped strings are redacted even without the key", redactSecrets("Incorrect API key provided: sk-proj-****abcd") === "Incorrect API key provided: sk-[redacted]");
}

console.log("\n=== route table, model policy, pricing ===");
{
  const expect: Record<string, [number, number]> = {
    page_generation: [6000, 120_000],
    add_meta: [800, 30_000],
    fix_thin_page: [3000, 90_000],
    add_internal_links: [4000, 90_000],
    seo_coach: [1200, 60_000],
    page_audit: [1500, 60_000],
    daily_briefing: [1000, 60_000],
  };
  for (const [route, [tok, ms]] of Object.entries(expect)) {
    const l = (AI_ROUTE_LIMITS as any)[route];
    t(`${route}: ${tok} output tokens, ${ms / 1000} s`, l?.maxOutputTokens === tok && l?.timeoutMs === ms, JSON.stringify(l));
  }
  t("every route is in the table and nothing else is", AI_ROUTES.length === 7 && AI_ROUTES.every((r) => r in AI_ROUTE_LIMITS));
  t("the table is frozen (a caller cannot raise a limit at run time)", Object.isFrozen(AI_ROUTE_LIMITS) && Object.isFrozen(AI_ROUTE_LIMITS.page_generation));
  t("add_meta is capped at 20 pages per action", ADD_META_MAX_PAGES === 20);
  t("the allowlist is exactly gpt-5-nano and gpt-5-mini", JSON.stringify(AI_MODELS) === JSON.stringify(["gpt-5-nano", "gpt-5-mini"]));
  t("the default is gpt-5-nano (standard)", AI_DEFAULT_MODEL === "gpt-5-nano" && modelForTier("standard") === "gpt-5-nano");
  t("premium is gpt-5-mini", modelForTier("premium") === "gpt-5-mini");
  t("only page generation offers premium", routeModel("page_generation", "premium") === "gpt-5-mini" && (() => {
    try {
      routeModel("seo_coach", "premium");
      return false;
    } catch {
      return true;
    }
  })());
  t("an unknown tier is an error, never a fallback", (() => {
    try {
      modelForTier("ultra" as any);
      return false;
    } catch {
      return true;
    }
  })());
  t("isAllowedModel rejects anything else", !isAllowedModel("gpt-5") && !isAllowedModel("google/gemini-3-flash-preview") && !isAllowedModel(undefined));
  t("page generation's timeout stays below the 180 s stale window", AI_ROUTE_LIMITS.page_generation.timeoutMs < 180_000);

  const P = pricing.MODEL_PRICES_MICROS_PER_1M;
  t("gpt-5-nano: $0.05 / $0.005 / $0.40 per 1M", P["gpt-5-nano"].input === 50_000 && P["gpt-5-nano"].cachedInput === 5_000 && P["gpt-5-nano"].output === 400_000);
  t("gpt-5-mini: $0.25 / $0.025 / $2.00 per 1M", P["gpt-5-mini"].input === 250_000 && P["gpt-5-mini"].cachedInput === 25_000 && P["gpt-5-mini"].output === 2_000_000);
  t("the unknown-model row is the most expensive allowlisted model", JSON.stringify(P.default) === JSON.stringify(P["gpt-5-mini"]) && JSON.stringify(pricing.priceFor("something-else")) === JSON.stringify(P["gpt-5-mini"]));
  t("cost math: 1M nano output tokens = $0.40", pricing.costMicrosForUsage("gpt-5-nano", { inputTokens: 0, outputTokens: 1_000_000 }) === 400_000);
  t("cost math: cached input at the cached rate", pricing.costMicrosForUsage("gpt-5-mini", { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 }) === 25_000);
  t("cost rounds up (never under-counts)", pricing.costMicrosForUsage("gpt-5-nano", { inputTokens: 1, outputTokens: 0 }) === 1);
  t("max cost = all input uncached + every output token", pricing.maxCostMicros("gpt-5-nano", 10_000, 6000) === Math.ceil((10_000 * 50_000 + 6000 * 400_000) / 1_000_000));
  t("credits: ceil(cost × 5 ÷ 10000), min 1, 0 for 0", pricing.creditsForCostMicros(2900) === 2 && pricing.creditsForCostMicros(1) === 1 && pricing.creditsForCostMicros(0) === 0);
  const src = read("src/lib/ai-pricing.ts");
  t("the price source is recorded", /developers\.openai\.com\/api\/docs\/pricing/.test(src));
  t("no OpenRouter / Gemini / env model override left in the pricing table", !/openrouter|gemini|PLATFORM_AI_MODEL/i.test(src));

  // The Deno mirror (daily briefing) must price identically.
  const deno = read("supabase/functions/_shared/ai-pricing.ts");
  for (const m of ["gpt-5-nano", "gpt-5-mini"] as const) {
    const re = new RegExp(`"${m}": \\{ input: ${P[m].input.toLocaleString("en-US").replace(/,/g, "_")}, cachedInput: ${P[m].cachedInput.toLocaleString("en-US").replace(/,/g, "_")}, output: ${P[m].output.toLocaleString("en-US").replace(/,/g, "_")} \\}`);
    t(`the Deno pricing mirror carries the same ${m} row`, re.test(deno), re.source);
  }
  const denoAi = read("supabase/functions/_shared/openai.ts");
  t(
    "the Deno wrapper uses the same briefing limits (1000 tokens, 60 s) and the same SDK version",
    /maxOutputTokens: 1000/.test(denoAi) && /timeoutMs: 60_000/.test(denoAi) &&
      denoAi.includes(`npm:openai@${JSON.parse(read("package.json")).dependencies.openai}`),
  );
}

console.log("\n=== the provider module stays the only client ===");
{
  const mod = read("src/lib/ai/openai.server.ts");
  t("maxRetries 0", /maxRetries: 0,/.test(mod));
  t("store: false on every request", /store: false,/.test(mod));
  t("baseURL, organization, project and admin key are pinned", /baseURL: transport\?\.baseURL \?\? OPENAI_API_BASE_URL/.test(mod) && /organization: null/.test(mod) && /project: null/.test(mod) && /adminAPIKey: null/.test(mod));
  t("the SDK logger is off", /logLevel: "off"/.test(mod));
  t("every call carries its own AbortSignal (body reads included)", /AbortSignal\.timeout\(call\.timeoutMs\)/.test(mod) && /\{ signal \}/.test(mod));
  t("no temperature / top_p anywhere in the module", !/temperature|top_p/.test(mod.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
}

const pkg = JSON.parse(read("package.json"));
t("the official openai SDK is a pinned dependency", /^\d+\.\d+\.\d+$/.test(pkg.dependencies?.openai ?? ""), pkg.dependencies?.openai);
t("this suite is in the test chain", /bun tests\/ai-provider\.test\.ts/.test(pkg.scripts.test));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}
