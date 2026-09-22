/**
 * Batch generation rules, asserted offline. Run: bun tests/generation.test.ts
 *
 * What is protected here:
 *   - a target is identified by city+state, never by slug (so retries and
 *     re-runs cannot produce austin, austin-2, austin-3 ...)
 *   - only cities with enough real listings and no page get generated
 *   - the daily cap arithmetic and job planning (dedupe) are exact
 *   - the OpenRouter caller rejects what must be rejected before anything is
 *     persisted or charged
 *   - the migration carries the idempotency key, the pause seed and the
 *     write REVOKEs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GENERATION_DEFAULT_MODEL,
  GENERATION_MODEL_OPTIONS,
  MIN_BODY_CHARS,
  buildCityBrief,
  buildTargetKey,
  callOpenRouterWritePage,
  dailyCapRemaining,
  formatInventoryFacts,
  isStaleRunning,
  planJobItems,
  selectTargets,
} from "../src/lib/generation.server";
import { PLATFORM_MODEL_ALLOWLIST, resolvePlatformModel } from "../src/lib/ai-pricing";

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

console.log("\n=== target key normalisation ===");
{
  t(
    "lowercases and joins city|state",
    buildTargetKey({ city: "Austin", state: "TX" }) === "city:austin|tx",
  );
  t(
    "trims and collapses whitespace",
    buildTargetKey({ city: "  New   York ", state: " NY " }) === "city:new york|ny",
  );
  t(
    "missing state is an empty segment",
    buildTargetKey({ city: "Lisbon", state: null }) === "city:lisbon|",
  );
  t(
    "undefined state same as null",
    buildTargetKey({ city: "Lisbon" }) === buildTargetKey({ city: "Lisbon", state: null }),
  );
  t(
    "case variants collapse to one key",
    buildTargetKey({ city: "AUSTIN", state: "tx" }) ===
      buildTargetKey({ city: "austin", state: "TX" }),
  );
  t(
    "different states are different targets",
    buildTargetKey({ city: "Portland", state: "OR" }) !==
      buildTargetKey({ city: "Portland", state: "ME" }),
  );
}

console.log("\n=== selectTargets ===");
{
  const cities = [
    { city: "Austin", state: "TX", listingCount: 12, hasPage: false },
    { city: "Dallas", state: "TX", listingCount: 3, hasPage: false },
    { city: "Waco", state: "TX", listingCount: 2, hasPage: false },
    { city: "Houston", state: "TX", listingCount: 40, hasPage: true },
    { city: "", state: "TX", listingCount: 99, hasPage: false },
    { city: "austin", state: "tx", listingCount: 1, hasPage: false },
  ];
  const out = selectTargets({ cities }, 3);
  const keys = out.map((o) => o.targetKey);
  t("keeps cities at or above the minimum", keys.includes("city:dallas|tx"));
  t("drops cities below the minimum", !keys.includes("city:waco|tx"));
  t("drops cities that already have a page", !keys.includes("city:houston|tx"));
  t("drops blank city names", !keys.some((k) => k === "city:|tx"));
  t("dedupes case variants of one city", keys.filter((k) => k === "city:austin|tx").length === 1);
  t(
    "sorted by inventory size, biggest first",
    out[0]?.city === "Austin" && out[1]?.city === "Dallas",
  );
  t("default minimum is 3", selectTargets({ cities }).length === out.length);
  t("higher minimum narrows", selectTargets({ cities }, 10).length === 1);
  t("empty context is empty", selectTargets({ cities: [] }).length === 0);
}

console.log("\n=== daily cap ===");
{
  t("cap 50, 0 done → 50", dailyCapRemaining(50, 0) === 50);
  t("cap 50, 20 done → 30", dailyCapRemaining(50, 20) === 30);
  t("never negative", dailyCapRemaining(50, 80) === 0);
  t("cap 0 means nothing", dailyCapRemaining(0, 0) === 0);
  t("NaN cap is treated as 0", dailyCapRemaining(Number.NaN, 0) === 0);
  t("negative done counts as 0", dailyCapRemaining(10, -5) === 10);
  t("fractional cap rounds down", dailyCapRemaining(10.9, 0) === 10);
}

console.log("\n=== job planning is idempotent by target key ===");
{
  const existing = [
    { target_key: "city:austin|tx", status: "done" },
    { target_key: "city:dallas|tx", status: "failed" },
    { target_key: "city:waco|tx", status: "pending" },
    { target_key: "city:plano|tx", status: "running" },
  ];
  const plan = planJobItems(
    [
      "city:austin|tx",
      "city:dallas|tx",
      "city:waco|tx",
      "city:plano|tx",
      "city:houston|tx",
      "city:houston|tx",
    ],
    existing,
  );
  t(
    "done keys are reused, never regenerated",
    plan.alreadyDone.length === 1 && plan.alreadyDone[0] === "city:austin|tx",
  );
  t("failed keys are re-attached, not duplicated", plan.reattach.includes("city:dallas|tx"));
  t("pending keys are re-attached", plan.reattach.includes("city:waco|tx"));
  t(
    "running keys are re-attached (stale check happens at run time)",
    plan.reattach.includes("city:plano|tx"),
  );
  t("unknown keys are created", plan.create.length === 1 && plan.create[0] === "city:houston|tx");
  t(
    "a key requested twice is planned once",
    plan.create.filter((k) => k === "city:houston|tx").length === 1,
  );
  t(
    "no key lands in two buckets",
    new Set([...plan.create, ...plan.reattach, ...plan.alreadyDone]).size ===
      plan.create.length + plan.reattach.length + plan.alreadyDone.length,
  );
  const again = planJobItems(["city:austin|tx"], existing);
  t(
    "re-running for a done key creates nothing",
    again.create.length === 0 && again.reattach.length === 0,
  );
}

console.log("\n=== stale running detection ===");
{
  const now = Date.parse("2026-09-22T12:00:00Z");
  t("updated 1 minute ago is live", !isStaleRunning(new Date(now - 60_000).toISOString(), now));
  t(
    "updated 4 minutes ago is stale",
    isStaleRunning(new Date(now - 4 * 60_000).toISOString(), now),
  );
  t("missing timestamp is stale", isStaleRunning(null, now));
  t("garbage timestamp is stale", isStaleRunning("not a date", now));
}

console.log("\n=== model policy ===");
{
  t(
    "default model is on the allowlist",
    PLATFORM_MODEL_ALLOWLIST.includes(GENERATION_DEFAULT_MODEL),
  );
  t(
    "default model resolves to itself (no silent Pro upgrade)",
    resolvePlatformModel(GENERATION_DEFAULT_MODEL) === GENERATION_DEFAULT_MODEL,
  );
  t(
    "old default gemini-2.5-flash would have upgraded silently (the bug this guards)",
    resolvePlatformModel("google/gemini-2.5-flash") !== "google/gemini-2.5-flash",
  );
  t(
    "picker only offers allowlisted models",
    GENERATION_MODEL_OPTIONS.every((m) => PLATFORM_MODEL_ALLOWLIST.includes(m.id)),
  );
  t(
    "picker has a cost hint per model",
    GENERATION_MODEL_OPTIONS.every((m) => /credit/.test(m.hint)),
  );
}

console.log("\n=== brief + inventory grounding ===");
{
  const b = buildCityBrief({ city: "Austin", state: "TX", categoryPlural: "boat rentals" });
  t("title names the category and place", b.title === "Boat rentals in Austin, TX");
  t("topic forbids invented facts", /do not invent/i.test(b.topic));
  t(
    "missing category falls back to listings",
    /listings/i.test(buildCityBrief({ city: "Austin" }).title.toLowerCase()),
  );

  const facts = formatInventoryFacts("Austin", [
    { title: "Pontoon", price_amount: 15000, price_currency: "USD" },
    { title: "Kayak", price_amount: 2500, price_currency: "USD" },
    { title: "Untitled", price_amount: null, price_currency: null },
  ]);
  t("keeps the ONLY-numbers grounding rule", facts.includes("the ONLY numbers you may use"));
  t("states the real listing count", facts.includes("3 published listings"));
  t("price range in whole currency units", facts.includes("Price range 25–150 USD"));
  t("lists example listings", facts.includes("- Pontoon") && facts.includes("- Kayak"));
  const none = formatInventoryFacts("Nowhere", []);
  t("no prices → forbids estimating", none.includes("do not state or estimate prices"));
  t("no listings → says so", none.includes("No example listings yet"));
}

console.log("\n=== OpenRouter caller (stubbed fetch) ===");
{
  const body = "# Boats in Austin\n\n" + "Real copy about real boats. ".repeat(40);
  const okResponse = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const good = {
    usage: { prompt_tokens: 812, completion_tokens: 1204 },
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
                  seo_description: "Rent a boat.",
                  body_markdown: body,
                }),
              },
            },
          ],
        },
      },
    ],
  };

  let captured: { url: string; init?: RequestInit } | null = null;
  const fetchOk = async (url: string, init?: RequestInit) => {
    captured = { url, init };
    return okResponse(good);
  };

  const r = await callOpenRouterWritePage({
    apiKey: "test-key",
    model: "google/gemini-3-flash-preview",
    systemPrompt: "sys",
    userPrompt: "usr",
    fetchImpl: fetchOk,
  });
  t("parses the tool call", r.title === "Boats in Austin" && r.body_markdown === body);
  t("reports token usage", r.promptTokens === 812 && r.completionTokens === 1204);
  t(
    "hits the chat completions endpoint",
    !!captured && captured!.url.endsWith("/chat/completions"),
  );
  const sent = JSON.parse(String(captured!.init?.body ?? "{}"));
  t("forces the write_page tool", sent.tool_choice?.function?.name === "write_page");
  t("sends the requested model", sent.model === "google/gemini-3-flash-preview");
  t(
    "bearer auth header set",
    String((captured!.init?.headers as any)?.Authorization).startsWith("Bearer "),
  );

  const short = {
    ...good,
    choices: [
      {
        message: {
          tool_calls: [
            {
              function: {
                arguments: JSON.stringify({
                  title: "x",
                  seo_title: "x",
                  seo_description: "x",
                  body_markdown: "too short",
                }),
              },
            },
          ],
        },
      },
    ],
  };
  let err = "";
  try {
    await callOpenRouterWritePage({
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      userPrompt: "u",
      fetchImpl: async () => okResponse(short),
    });
  } catch (e) {
    err = (e as Error).message;
  }
  t(`rejects a body under ${MIN_BODY_CHARS} chars`, /too short/.test(err), err);

  err = "";
  try {
    await callOpenRouterWritePage({
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      userPrompt: "u",
      fetchImpl: async () => okResponse({ choices: [{ message: { content: "plain text" } }] }),
    });
  } catch (e) {
    err = (e as Error).message;
  }
  t("rejects a response without a tool call", /missing tool call/.test(err), err);

  err = "";
  try {
    await callOpenRouterWritePage({
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      userPrompt: "u",
      fetchImpl: async () =>
        okResponse({
          choices: [{ message: { tool_calls: [{ function: { arguments: "{not json" } }] } }],
        }),
    });
  } catch (e) {
    err = (e as Error).message;
  }
  t("rejects malformed tool arguments", /not valid JSON/.test(err), err);

  err = "";
  try {
    await callOpenRouterWritePage({
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      userPrompt: "u",
      fetchImpl: async () => new Response("rate limited, slow down", { status: 429 }),
    });
  } catch (e) {
    err = (e as Error).message;
  }
  t(
    "non-2xx surfaces the status and provider text",
    err.includes("429") && err.includes("rate limited"),
    err,
  );

  err = "";
  try {
    await callOpenRouterWritePage({
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      userPrompt: "u",
      fetchImpl: async () => new Response("x".repeat(1000), { status: 500 }),
    });
  } catch (e) {
    err = (e as Error).message;
  }
  t("provider text is truncated", err.length < 400, String(err.length));
}

console.log("\n=== migration text ===");
{
  const sql = readFileSync(
    join(import.meta.dir, "../supabase/migrations/20260923000300_generation_jobs.sql"),
    "utf8",
  );
  t(
    "items unique on (workspace_id, target_key)",
    /UNIQUE\s*\(\s*workspace_id\s*,\s*target_key\s*\)/.test(sql),
  );
  t("generation_paused seeded false", /\('generation_paused',\s*'false'::jsonb\)/.test(sql));
  t("generation_daily_cap seeded", /\('generation_daily_cap',\s*'50'::jsonb\)/.test(sql));
  t("seed is idempotent", /ON CONFLICT \(key\) DO NOTHING/.test(sql));
  t(
    "REVOKE writes on generation_jobs",
    /REVOKE INSERT, UPDATE, DELETE ON public\.generation_jobs FROM authenticated, anon/.test(sql),
  );
  t(
    "REVOKE writes on generation_items",
    /REVOKE INSERT, UPDATE, DELETE ON public\.generation_items FROM authenticated, anon/.test(sql),
  );
  t(
    "REVOKE ALL on platform_settings",
    /REVOKE ALL ON public\.platform_settings FROM authenticated, anon/.test(sql),
  );
  t(
    "no read policy on platform_settings",
    !/CREATE POLICY[^;]*ON public\.platform_settings/.test(sql),
  );
  t(
    "member read policies use is_workspace_member",
    (sql.match(/is_workspace_member\(workspace_id, auth\.uid\(\)\)/g) ?? []).length === 2,
  );
  t(
    "RLS enabled on all three tables",
    ["generation_jobs", "generation_items", "platform_settings"].every((tbl) =>
      sql.includes(`ALTER TABLE public.${tbl} ENABLE ROW LEVEL SECURITY`),
    ),
  );
  t(
    "page_id nulls on page delete",
    /page_id uuid REFERENCES public\.tenant_pages\(id\) ON DELETE SET NULL/.test(sql),
  );
  t(
    "item status check includes all five states",
    /CHECK \(status IN \('pending','running','done','failed','skipped'\)\)/.test(sql),
  );
  t(
    "job status check includes all five states",
    /CHECK \(status IN \('queued','running','done','failed','cancelled'\)\)/.test(sql),
  );
  t(
    "idempotent DDL",
    /CREATE TABLE IF NOT EXISTS public\.generation_items/.test(sql) &&
      /DROP POLICY IF EXISTS/.test(sql) &&
      /DROP TRIGGER IF EXISTS/.test(sql),
  );
  t(
    "updated_at triggers on all three tables",
    (sql.match(/EXECUTE FUNCTION public\.update_updated_at_column\(\)/g) ?? []).length === 3,
  );
  t(
    "ends with the verification block",
    /SELECT 'generation_jobs' AS check,[\s\S]*UNION ALL SELECT 'RLS enabled on all 3 new tables'/.test(
      sql,
    ),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}
