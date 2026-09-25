/**
 * THE DAILY BRIEFING IS IDEMPOTENT PER (WORKSPACE, UTC DAY).
 * Run: bun --preload ./tests/_preload/deno-edge-function.ts tests/coach-briefing.test.ts
 *
 * The real coach-briefing-cron function (its Deno.serve handler), its real
 * OpenAI wrapper (the official SDK, against a fake Responses API that COUNTS
 * requests) and the real migration chain (000600 → 000800 in PGlite, behind
 * a supabase-js stand-in) — driven through the app's own requestBriefing
 * (what generateBriefingNow calls) and a cron request, all at once:
 *
 *   - 10 concurrent "Refresh" requests + the nightly cron → exactly ONE AI
 *     request and ONE stored briefing; every on-demand caller gets that same
 *     row ('created' or 'exists'), none an error;
 *   - later requests the same day → 'exists', no AI request, the stored
 *     insights unchanged (never re-rolled);
 *   - the AI call is reserved like every other (billing 'system', a
 *     deterministic request id) and settled; the kill switch stops it
 *     (heuristics instead); a claim abandoned mid-call is taken over without
 *     a second AI call;
 *   - the CRON_SECRET gate still fails closed, compared in constant time
 *     (round-4 security L9);
 *   - the dashboard's Refresh (refreshBriefing, what generateBriefingNow
 *     runs) reaches the function at most once per workspace per 10 minutes
 *     (L9), answering the stored briefing when throttled;
 *   - tenant text is clipped and the input is bounded (L4).
 *
 * PGlite is one connection, so this proves the logic across interleaved
 * requests; tests/ai-concurrency.pg.ts races the claim itself on
 * PostgreSQL 16 with 50 connections.
 */
import { PGlite } from "@electric-sql/pglite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AI_CHAIN, SUPABASE_STUBS, pgliteSupabase, readRepo } from "./_support/ai-db";

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
const g = globalThis as unknown as {
  __edgeEnv: Record<string, string | undefined>;
  __edgeHandler?: (req: Request) => Promise<Response>;
  __sbCreateClient?: () => unknown;
};

// ---- the database ------------------------------------------------------------------
const WS = "11111111-1111-4111-8111-111111111111";
const WS2 = "22222222-2222-4222-8222-222222222222";
const WS3 = "33333333-3333-4333-8333-333333333333";
const MEMBER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const db = await PGlite.create();
await db.exec(SUPABASE_STUBS);
for (const rel of AI_CHAIN) await db.exec(readRepo(rel));
await db.exec(`
  INSERT INTO public.workspaces (id, name, subscription_status) VALUES
    ('${WS}', 'Boats', 'active'), ('${WS2}', 'Bikes', 'canceled');
  INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ('${WS}', '${MEMBER}', 'owner');
  INSERT INTO public.tenant_pages (id, workspace_id, slug, title, status, body_markdown, meta_description) VALUES
    ('55555555-5555-4555-8555-000000000001', '${WS}', 'boats-austin', 'Boats in Austin', 'published', 'Short page.', NULL),
    ('55555555-5555-4555-8555-000000000002', '${WS}', 'boats-dallas', 'Boats in Dallas', 'published', 'Also short.', 'Has meta.');
  INSERT INTO public.tenant_listings (workspace_id, city, category) VALUES
    ('${WS}', 'Houston', 'boats'), ('${WS}', 'Houston', 'boats'), ('${WS}', 'Waco', 'boats');
`);
g.__sbCreateClient = () => pgliteSupabase(db);

const one = async <T = any>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0] as T;
const today = new Date().toISOString().slice(0, 10);

// ---- the fake OpenAI (counts every request) ----------------------------------------
let aiRequests = 0;
let aiDelayMs = 400;
let lastAiInput = "";
const INSIGHTS = {
  insights: [
    {
      title: "Expand the Austin page",
      description: "Pages under 300 words rarely rank.",
      priority: "high",
      action_type: "fix_thin_page",
      action_payload: { page_id: "55555555-5555-4555-8555-000000000001", page_ids: null, city: null, state: null },
    },
    {
      title: "Create a Houston page",
      description: "Two listings in Houston have no page.",
      priority: "high",
      action_type: "create_city_page",
      action_payload: { page_id: null, page_ids: null, city: "houston", state: "TX" },
    },
  ],
};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "api.openai.com") throw new TypeError(`unexpected host ${url.host}`);
  aiRequests++;
  await new Promise((r) => setTimeout(r, aiDelayMs));
  const body = JSON.parse(String(init?.body ?? "{}"));
  lastAiInput = typeof body.input === "string" ? body.input : JSON.stringify(body.input ?? "");
  if (body.model !== "gpt-5-nano" || body.max_output_tokens !== 1000 || body.text?.format?.strict !== true) {
    return new Response(JSON.stringify({ error: { message: "unexpected request" } }), { status: 400 });
  }
  return Response.json({
    id: "resp_briefing",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-5-nano-2025-08-07",
    output: [
      {
        type: "message",
        id: "msg_b",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(INSIGHTS), annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 900,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 300,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 1200,
    },
  });
}) as typeof fetch;

// ---- the function, offline ---------------------------------------------------------
const CRON = "cron-secret-for-tests";
g.__edgeEnv.CRON_SECRET = CRON;
g.__edgeEnv.SUPABASE_URL = "http://supabase.test";
g.__edgeEnv.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
g.__edgeEnv.OPENAI_API_KEY = "sk-test-briefing-key";

mkdirSync(join(ROOT, "tests/_build"), { recursive: true });
const wrapperSrc = readFileSync(join(ROOT, "supabase/functions/_shared/openai.ts"), "utf8");
const npmImport = /from "npm:openai@[0-9.]+"/;
t("the wrapper imports the pinned npm SDK (rewritten onto the installed one)", npmImport.test(wrapperSrc));
const wrapperBuilt = join(ROOT, "tests/_build/briefing-openai.offline.ts");
writeFileSync(wrapperBuilt, wrapperSrc.replace(npmImport, 'from "openai"'));
const fnSrc = readFileSync(join(ROOT, "supabase/functions/coach-briefing-cron/index.ts"), "utf8");
const rewrites: Array<[RegExp, string]> = [
  [/from "https:\/\/esm\.sh\/@supabase\/supabase-js@[^"]+"/, `from "${join(ROOT, "tests/_preload/fakes/supabase-js.ts")}"`],
  [/from "\.\.\/_shared\/openai\.ts"/, `from "${wrapperBuilt}"`],
  [/from "\.\.\/_shared\/ai-pricing\.ts"/, `from "${join(ROOT, "supabase/functions/_shared/ai-pricing.ts")}"`],
];
let built = fnSrc;
for (const [re, to] of rewrites) {
  t(`source import rewritten: ${re.source.slice(0, 48)}`, re.test(built));
  built = built.replace(re, to);
}
const fnBuilt = join(ROOT, "tests/_build/coach-briefing-cron.offline.ts");
writeFileSync(fnBuilt, built);
await import(fnBuilt);
const handler = g.__edgeHandler!;
t("the function registered its Deno.serve handler", typeof handler === "function");

process.env.SUPABASE_URL = "http://supabase.test";
process.env.CRON_SECRET = CRON;
process.env.SUPABASE_PUBLISHABLE_KEY = "publishable-for-tests";
const { requestBriefing } = await import("../src/lib/coach-briefing.server");
/** The app's own request, delivered straight to the handler. */
const inProcess = async (url: string | URL | Request, init?: RequestInit) =>
  handler(new Request(String(url instanceof Request ? url.url : url), init));
const refresh = (ws = WS) => requestBriefing(ws, { fetch: inProcess });
const cron = (secret: string | null = CRON, body: Record<string, unknown> = {}) =>
  handler(
    new Request("http://supabase.test/functions/v1/coach-briefing-cron", {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret === null ? {} : { "x-cron-secret": secret }) },
      body: JSON.stringify(body),
    }),
  );

const origError = console.error;
const logs: string[] = [];
console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));

try {
  // -------------------------------------------------------------------------
  console.log("\n=== 10 concurrent Refreshes + the nightly cron ===");
  {
    const started = Date.now();
    const [cronRes, ...refreshes] = await Promise.all([cron(), ...Array.from({ length: 10 }, () => refresh())]);
    const cronBody = (await cronRes.json()) as { results: Array<{ workspace_id: string; status: string; ai?: boolean }> };
    const rows = await db.query<any>("SELECT id, insights FROM public.coach_daily_briefings WHERE workspace_id = $1 AND briefing_date = $2", [WS, today]);
    t("exactly ONE AI request", aiRequests === 1, String(aiRequests));
    t("exactly ONE stored briefing for the workspace and day", rows.rows.length === 1, String(rows.rows.length));
    t(
      "every Refresh got that briefing ('created' for the one that made it, 'exists' for the rest), none an error",
      refreshes.every((r) => r.ok && ["created", "exists"].includes((r as any).status)) &&
        refreshes.filter((r) => (r as any).status === "created").length <= 1,
      JSON.stringify(refreshes),
    );
    const cronWs = cronBody.results.find((r) => r.workspace_id === WS);
    t("the cron run for the workspace is part of the same single briefing", ["created", "exists", "in_progress"].includes(cronWs?.status ?? ""), JSON.stringify(cronWs));
    t(
      "exactly one of all eleven runs created it",
      [...refreshes.map((r) => (r as any).status), cronWs?.status].filter((s) => s === "created").length === 1,
    );
    const insights = rows.rows[0]?.insights ?? [];
    t(
      "the stored insights are the AI's, normalised to exact action payloads",
      insights.length === 2 &&
        JSON.stringify(insights[0].action_payload) === JSON.stringify({ page_id: "55555555-5555-4555-8555-000000000001" }) &&
        JSON.stringify(insights[1].action_payload) === JSON.stringify({ city: "houston", state: "TX" }),
      JSON.stringify(insights),
    );
    const spend = await db.query<any>("SELECT status, billing, feature, user_id, max_credits FROM public.ai_spend_reservations WHERE workspace_id = $1", [WS]);
    t(
      "the AI call was reserved and settled once: billing 'system', daily_briefing, no user, no customer credits",
      spend.rows.length === 1 &&
        spend.rows[0].status === "settled" &&
        spend.rows[0].billing === "system" &&
        spend.rows[0].feature === "daily_briefing" &&
        spend.rows[0].user_id === null &&
        spend.rows[0].max_credits === 0,
      JSON.stringify(spend.rows),
    );
    const usage = await db.query<any>("SELECT status, prompt_tokens FROM public.ai_usage_log WHERE workspace_id = $1", [WS]);
    t("one usage row with the reported tokens", usage.rows.length === 1 && usage.rows[0].status === "ok" && usage.rows[0].prompt_tokens === 900);
    t("a canceled workspace is skipped by the cron (no briefing, no AI request)", (await one<any>("SELECT count(*)::int AS n FROM public.coach_daily_briefings WHERE workspace_id = $1", [WS2])).n === 0 && !cronBody.results.some((r) => r.workspace_id === WS2));
    t("…and it all took seconds, not the 20 s wait budget", Date.now() - started < 15_000, `${Date.now() - started} ms`);
  }

  // -------------------------------------------------------------------------
  console.log("\n=== later the same day: the same row, never re-rolled ===");
  {
    const before = await one<any>("SELECT id, insights::text AS insights, generated_at FROM public.coach_daily_briefings WHERE workspace_id = $1 AND briefing_date = $2", [WS, today]);
    const aiBefore = aiRequests;
    const again = await Promise.all(Array.from({ length: 5 }, () => refresh()));
    const after = await one<any>("SELECT id, insights::text AS insights, generated_at FROM public.coach_daily_briefings WHERE workspace_id = $1 AND briefing_date = $2", [WS, today]);
    t("five more Refreshes: all 'exists'", again.every((r) => r.ok && (r as any).status === "exists"), JSON.stringify(again));
    t("…no AI request", aiRequests === aiBefore);
    t("…and the stored row is unchanged (same id, same insights, same time)", before.id === after.id && before.insights === after.insights && String(before.generated_at) === String(after.generated_at));
    const cronAgain = (await (await cron()).json()) as { results: Array<{ workspace_id: string; status: string }> };
    t("the cron the same day: 'exists', no AI request", cronAgain.results.find((r) => r.workspace_id === WS)?.status === "exists" && aiRequests === aiBefore);
  }

  // -------------------------------------------------------------------------
  console.log("\n=== the kill switch covers the briefing ===");
  {
    await db.exec("DELETE FROM public.coach_daily_briefings; DELETE FROM public.coach_briefing_claims; DELETE FROM public.ai_spend_reservations; DELETE FROM public.ai_budget_days;");
    await db.exec("UPDATE public.ai_platform_settings SET platform_ai_enabled = false");
    const aiBefore = aiRequests;
    const r = await refresh();
    const row = await one<any>("SELECT insights FROM public.coach_daily_briefings WHERE workspace_id = $1 AND briefing_date = $2", [WS, today]);
    t("with the kill switch off the briefing is still made (heuristics)…", r.ok && (r as any).status === "created" && Array.isArray(row?.insights) && row.insights.length > 0, JSON.stringify(r));
    t("…with no AI request and no reservation", aiRequests === aiBefore && (await one<any>("SELECT count(*)::int AS n FROM public.ai_spend_reservations")).n === 0);
    await db.exec("UPDATE public.ai_platform_settings SET platform_ai_enabled = true");
  }

  // -------------------------------------------------------------------------
  console.log("\n=== a claim abandoned mid-call is taken over without a second AI call ===");
  {
    await db.exec("DELETE FROM public.coach_daily_briefings; DELETE FROM public.coach_briefing_claims; DELETE FROM public.ai_spend_reservations; DELETE FROM public.ai_budget_days;");
    // A run that claimed, reserved and called, then died: its claim is 4
    // minutes old and its AI call is still 'called'.
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`briefing:${WS}:${today}`))).slice(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const rid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    await db.query(
      `SELECT public.ai_reserve(_workspace_id => $1, _request_id => $2, _user_id => NULL, _feature => 'daily_briefing', _source => 'daily_briefing', _model => 'gpt-5-nano', _max_input_tokens => 3000, _max_output_tokens => 1000, _max_cost_micros => 600, _max_credits => 0, _billing_class => 'system')`,
      [WS, rid],
    );
    await db.query("SELECT public.ai_mark_called($1, $2)", [WS, rid]);
    await db.query("INSERT INTO public.coach_briefing_claims (workspace_id, briefing_date, claim_token, claimed_at) VALUES ($1, $2, gen_random_uuid(), now() - interval '4 minutes')", [WS, today]);
    const aiBefore = aiRequests;
    const r = await refresh();
    t("the takeover stores a briefing", r.ok && (r as any).status === "created", JSON.stringify(r));
    t("…without a second AI request (the day's reservation is still the dead run's)", aiRequests === aiBefore);
    t("…exactly one row", (await one<any>("SELECT count(*)::int AS n FROM public.coach_daily_briefings WHERE workspace_id = $1", [WS])).n === 1);
  }

  // -------------------------------------------------------------------------
  console.log("\n=== Refresh (refreshBriefing): at most one per workspace per 10 minutes ===");
  {
    const { refreshBriefing, BRIEFING_THROTTLED_MESSAGE, BRIEFING_REFRESH_INTERVAL_SECONDS } = await import("../src/lib/coach-briefing.server");
    const sb = pgliteSupabase(db);
    let calls = 0;
    const counted = async (url: string | URL | Request, init?: RequestInit) => {
      calls++;
      return inProcess(url, init);
    };
    const press = (ws = WS) => refreshBriefing(ws, { fetch: counted, db: sb as any });
    t("the interval is 10 minutes", BRIEFING_REFRESH_INTERVAL_SECONDS === 600);
    const first = await press();
    t("the first Refresh reaches the function (today's briefing: 'exists')", first.ok && (first as any).status === "exists" && calls === 1, JSON.stringify(first));
    const burst = await Promise.all(Array.from({ length: 5 }, () => press()));
    t("five more within the interval never reach the function", calls === 1, String(calls));
    t("…and each answers today's stored briefing ('exists'), never an error", burst.every((r) => r.ok && (r as any).status === "exists"), JSON.stringify(burst));
    // A workspace whose day has no briefing yet: throttled → the sentence.
    await db.exec(`DELETE FROM public.coach_daily_briefings WHERE workspace_id = '${WS}'; DELETE FROM public.coach_briefing_claims;`);
    const throttled = await press();
    t("throttled with nothing stored yet: the fixed sentence, no function call", !throttled.ok && (throttled as any).error === BRIEFING_THROTTLED_MESSAGE && calls === 1, JSON.stringify(throttled));
    await db.exec(`UPDATE public.coach_briefing_refreshes SET last_requested_at = now() - interval '11 minutes' WHERE workspace_id = '${WS}'`);
    const aiBefore = aiRequests;
    const again = await press();
    t("after the interval the next Refresh goes through (and makes the day's briefing)", again.ok && (again as any).status === "created" && calls === 2, JSON.stringify(again));
    t("…with no second AI call (the day's reservation already ran)", aiRequests === aiBefore);
  }

  // -------------------------------------------------------------------------
  console.log("\n=== tenant text is clipped and the briefing input is bounded (L4) ===");
  {
    const long = "x".repeat(5_000);
    await db.exec(`
      INSERT INTO public.workspaces (id, name, subscription_status) VALUES ('${WS3}', 'Kayaks', 'active');
      INSERT INTO public.tenant_pages (workspace_id, slug, title, status, body_markdown) VALUES
        ('${WS3}', '${long}', 'Long', 'published', 'thin');
      INSERT INTO public.tenant_listings (workspace_id, city, category) VALUES ('${WS3}', '${long}', 'boats');
    `);
    const aiBefore = aiRequests;
    const r = await refresh(WS3);
    t("a workspace with 5,000-character slugs and city names still gets its briefing", r.ok, JSON.stringify(r));
    t("the AI request went out with every tenant string clipped to 120 characters", aiRequests === aiBefore + 1 && !lastAiInput.includes("x".repeat(121)) && lastAiInput.includes("x".repeat(120)), String(lastAiInput.length));
    const src = readFileSync(join(ROOT, "supabase/functions/coach-briefing-cron/index.ts"), "utf8");
    t(
      "an input over 64,000 characters is never sent (heuristics instead)",
      /export const BRIEFING_MAX_INPUT_CHARS = 64_000;/.test(src) &&
        /if \(input\.length > BRIEFING_MAX_INPUT_CHARS\) \{[\s\S]*?return null;/.test(src) &&
        src.indexOf("input.length > BRIEFING_MAX_INPUT_CHARS") < src.indexOf('rpc("ai_reserve"'),
    );
  }

  // -------------------------------------------------------------------------
  console.log("\n=== the CRON_SECRET gate is unchanged ===");
  {
    const aiBefore = aiRequests;
    t("no secret → 401", (await cron(null)).status === 401);
    t("a wrong secret → 401", (await cron("not-the-secret")).status === 401);
    t("the secret with one character more → 401", (await cron(`${CRON}x`)).status === 401);
    t("the secret with one character less → 401", (await cron(CRON.slice(0, -1))).status === 401);
    t("an empty secret header → 401", (await cron("")).status === 401);
    const src = readFileSync(join(ROOT, "supabase/functions/coach-briefing-cron/index.ts"), "utf8");
    t(
      "the comparison is constant time over SHA-256 digests (no === / !== on the secret)",
      /async function secretMatches\(/.test(src) && /crypto\.subtle\.digest\("SHA-256"/.test(src) &&
        /if \(!\(await secretMatches\(req\.headers\.get\("x-cron-secret"\), CRON_SECRET\)\)\)/.test(src) &&
        !/!== CRON_SECRET|=== CRON_SECRET/.test(src),
    );
    g.__edgeEnv.CRON_SECRET = undefined;
    t("unset on the function → 503 (fails closed)", (await cron(CRON)).status === 503);
    g.__edgeEnv.CRON_SECRET = CRON;
    t("…and none of them reached the database or the provider", aiRequests === aiBefore);
    const failures = await Promise.all([cron("nope")]);
    const text = await failures[0]!.text();
    t("the refusal body is a code, never database or provider text", /^\{"error":"(unauthorized|cron_not_configured)"\}$/.test(text), text);
  }
} finally {
  console.error = origError;
}

t("no log line carries the OpenAI key", !logs.some((l) => l.includes("sk-test-briefing-key")));
{
  const pkg = readFileSync(join(ROOT, "package.json"), "utf8");
  t("this suite is in the test chain", /--preload \.\/tests\/_preload\/deno-edge-function\.ts tests\/coach-briefing\.test\.ts/.test(pkg));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}
