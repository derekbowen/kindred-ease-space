/**
 * Generation rules (batch + quick page), asserted offline.
 * Run: bun tests/generation.test.ts
 *
 * What is protected here:
 *   - a target is identified by city+state, never by slug (so retries and
 *     re-runs cannot produce austin, austin-2, austin-3 ...)
 *   - only cities with enough real listings and no page get generated, and
 *     "has a page" matches city AND state (Portland, OR ≠ Portland, ME)
 *   - a live `running` item is never handed to a second driver; only a stale
 *     one is; a done item whose draft was deleted is generatable again
 *   - the daily cap counts ONE thing — reservations, one per provider call —
 *     in ONE place (the database); every generator (quick page, coach,
 *     Opportunity Engine, each batch item attempt) reserves before its
 *     provider call; a reservation is marked spent right before the call and
 *     never released after it; a request that can only fail (an underivable
 *     slug) fails before anything is reserved; the attempt ceiling is 3, the
 *     pause switch accepts true and "true"
 *   - money goes through the ONE spend path (src/lib/ai/spend.server.ts):
 *     the maximum cost of a whole page is HELD before the call (not a
 *     balance > 0 check), the call is settled once per request id in the
 *     database, a provider that omits usage is charged the full hold — never
 *     a free page — and a settled page can no longer be "unbilled"
 *   - pre-claim item writes are fenced on the state the driver read, so a
 *     refusal from one driver cannot void another's live claim
 *   - the quick page accepts a quality TIER only (never a model), defaults to
 *     standard, carries an idempotency key and replays with the charge the
 *     database recorded
 *   - the coach's create_city_page runs through the core (pause, cap, who
 *     pays, the spend hold, deterministic request id)
 *   - the OpenAI page writer times out (even mid-body), rejects what must be
 *     rejected, and never lets a provider body reach the customer; no
 *     database text reaches the customer either (customerMessage)
 *   - out-of-funds copy sends customers to support, not to a withdrawn purchase
 *   - the migrations carry the idempotency keys, billing_status, the pause
 *     seed, the write REVOKEs, the settlement index, the reservation state
 *     machine (reserve / mark / release), the billing-mode column and the
 *     pin trigger; the rollbacks undo them (tests/generation-sql.test.ts runs
 *     the 000600 SQL itself in PGlite; tests/ai-spend-sql.test.ts runs 000800)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ATTEMPTS_EXHAUSTED_MESSAGE,
  CustomerFacingError,
  GENERATION_ALREADY_USED_MESSAGE,
  GENERATION_DEFAULT_TIER,
  GENERATION_IN_PROGRESS_MESSAGE,
  GENERATION_PAUSED_MESSAGE,
  GENERATION_TIERS,
  GENERATION_TIER_OPTIONS,
  GENERATION_UNAVAILABLE_MESSAGE,
  MAX_ITEM_ATTEMPTS,
  MIN_BODY_CHARS,
  PAGE_GENERATION_TIMEOUT_MS,
  PAGE_SLUG_UNDERIVABLE_MESSAGE,
  PAGE_TITLE_INVALID_MESSAGE,
  PROVIDER_ERROR_MESSAGE,
  PROVIDER_TIMEOUT_MESSAGE,
  STALE_RUNNING_MS,
  TYPICAL_PAGE_TOKENS,
  WRITE_PAGE_SCHEMA,
  attemptsExhausted,
  batchAttemptRequestId,
  billingModeFor,
  billingStatusFor,
  buildCityBrief,
  buildTargetKey,
  customerMessage,
  dailyCapRemaining,
  deterministicRequestId,
  estimatedCreditsPerPage,
  formatInventoryFacts,
  generatePageContent,
  generatedPageBaseSlug,
  isGenerationPaused,
  isStaleRunning,
  outOfCreditsMessage,
  pageCoversCity,
  parseGenerationSlot,
  planJobItems,
  selectTargets,
  validatePageRequest,
  type ResolvedBilling,
} from "../src/lib/generation.server";
import { AI_MODELS, isAllowedModel, modelForTier, tierForModel } from "../src/lib/ai/models";
import { AI_ROUTE_LIMITS } from "../src/lib/ai/limits";
import { AI_MESSAGES } from "../src/lib/ai/customer-error";
import { creditsForCostMicros, creditsForUsage, maxCostMicros } from "../src/lib/ai-pricing";
import { QuickPageInputSchema } from "../src/lib/admin-quick-page.functions";

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
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const MIGRATION_600 = "supabase/migrations/20260924000600_generation_settlement_and_reservations.sql";
const ROLLBACK_600 =
  "supabase/rollback/20260924000600_generation_settlement_and_reservations_rollback.sql";

const NOW = Date.parse("2026-09-22T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

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

console.log("\n=== page covers city (the shared eligibility predicate) ===");
{
  t(
    "same city and state is covered",
    pageCoversCity({ city: "Portland", state: "OR" }, { city: "Portland", state: "OR" }),
  );
  t(
    "Portland, OR does not hide Portland, ME",
    !pageCoversCity({ city: "Portland", state: "OR" }, { city: "Portland", state: "ME" }),
  );
  t(
    "a page with no state covers the city in any state",
    pageCoversCity({ city: "Portland", state: null }, { city: "Portland", state: "ME" }),
  );
  t(
    "a target with no state is covered by a stated page",
    pageCoversCity({ city: "Portland", state: "OR" }, { city: "Portland", state: null }),
  );
  t("a different city is not covered", !pageCoversCity({ city: "Salem" }, { city: "Portland" }));
  t(
    "case and whitespace do not matter",
    pageCoversCity({ city: "  portland ", state: "or" }, { city: "PORTLAND", state: " OR" }),
  );
  t("a page without a city covers nothing", !pageCoversCity({ city: "" }, { city: "Portland" }));
  t(
    "page-builder hasPage uses the shared predicate",
    read("src/lib/page-builder.functions.ts").includes("pageCoversCity(p, { city, state })"),
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
  t("cap 50, 0 consumed → 50", dailyCapRemaining(50, 0) === 50);
  t("cap 50, 20 consumed → 30", dailyCapRemaining(50, 20) === 30);
  t("never negative", dailyCapRemaining(50, 80) === 0);
  t("cap 0 means nothing", dailyCapRemaining(0, 0) === 0);
  t("NaN cap is treated as 0", dailyCapRemaining(Number.NaN, 0) === 0);
  t("negative consumed counts as 0", dailyCapRemaining(10, -5) === 10);
  t("fractional cap rounds down", dailyCapRemaining(10.9, 0) === 10);

  // The count lives in SQL (ONE definition, shared with the reservation
  // RPC), and it counts ONE thing: reservations — one per provider call.
  // Pages and batch items are rows a customer can delete, edit or re-arm;
  // counting them let a deleted draft free a slot.
  const sql = read(MIGRATION_600);
  const consumedFn = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.generation_consumed_last_24h"),
    sql.indexOf("REVOKE EXECUTE ON FUNCTION public.generation_consumed_last_24h"),
  );
  t("generation_consumed_last_24h was found", consumedFn.length > 0);
  t(
    "the SQL count has exactly one source: reservations (never pages, never items)",
    (consumedFn.match(/count\(\*\)/g) ?? []).length === 1 &&
      consumedFn.includes("FROM public.generation_reservations r") &&
      !consumedFn.includes("tenant_pages") &&
      !consumedFn.includes("generation_items"),
  );
  t(
    "reservations count whether or not a page exists (no page join can neutralise one)",
    !/NOT EXISTS/.test(consumedFn) && !/generation_request_id/.test(consumedFn),
  );
  t(
    "the one source is bounded to the 24-hour window by created_at",
    (consumedFn.match(/r\.created_at >= now\(\) - interval '24 hours'/g) ?? []).length === 1,
  );
  t(
    "nothing can exclude itself from the count: it takes the workspace only",
    /generation_consumed_last_24h\(\s*_workspace_id uuid\s*\)/.test(consumedFn) &&
      !consumedFn.includes("_exclude_item_id"),
  );
  const server = read("src/lib/generation.server.ts");
  const countFn = server.slice(
    server.indexOf("export async function countConsumedLast24h"),
    server.indexOf("export type GenerationSlot"),
  );
  t(
    "countConsumedLast24h is a thin wrapper over the RPC (no second definition in TypeScript)",
    countFn.includes('rpc("generation_consumed_last_24h"') &&
      /rpc\("generation_consumed_last_24h", \{\s*_workspace_id: workspaceId,\s*\}\)/.test(countFn) &&
      !countFn.includes("_exclude_item_id") &&
      !countFn.includes('.from("generation_items")') &&
      !countFn.includes('.from("tenant_pages")'),
  );
  t("an RPC error throws instead of reading as zero", /if \(error\) throw new Error/.test(countFn));
  t("the dead countsTowardDailyCap helper is gone", !server.includes("countsTowardDailyCap"));
  t(
    "DAILY_CAP_COUNTED_STATUSES is gone with the item count it described",
    !server.includes("DAILY_CAP_COUNTED_STATUSES") &&
      !read("src/lib/generation.functions.ts").includes("DAILY_CAP_COUNTED_STATUSES"),
  );
}

console.log("\n=== reservation answers (reserve_generation_slot) ===");
{
  for (const v of ["reserved", "cap_reached", "in_progress", "consumed"] as const) {
    t(`'${v}' is understood`, parseGenerationSlot(v) === v);
  }
  // The old boolean answer, or anything unexpected, must never read as a slot.
  for (const bad of [true, false, null, undefined, "", "RESERVED", 1, { v: "reserved" }]) {
    let threw = false;
    try {
      parseGenerationSlot(bad);
    } catch {
      threw = true;
    }
    t(`an unexpected answer (${JSON.stringify(bad) ?? "undefined"}) throws, never "reserved"`, threw);
  }
  t(
    "the in-progress and already-used refusals are the customer-facing sentences",
    GENERATION_IN_PROGRESS_MESSAGE === "This page is still being generated. Refresh in a minute." &&
      GENERATION_ALREADY_USED_MESSAGE ===
        "This request already generated a page. Start a new one from the Page Builder.",
  );
}

console.log("\n=== deterministic validation before anything is reserved or spent ===");
{
  const refusal = (input: { title: string; slug?: string | null }) => {
    try {
      validatePageRequest(input);
      return null;
    } catch (e) {
      return e;
    }
  };
  const dashes = refusal({ title: "Boats in Austin", slug: "---" });
  t(
    'an underivable slug ("---") is refused as a customer-facing error, even with a good title',
    dashes instanceof CustomerFacingError && (dashes as Error).message === PAGE_SLUG_UNDERIVABLE_MESSAGE,
    String(dashes),
  );
  t(
    "…exactly as persistGeneratedPage would derive it (slug first, then the title)",
    generatedPageBaseSlug("---", "Boats in Austin") === "" &&
      generatedPageBaseSlug("", "Boats in Austin") === "boats-in-austin" &&
      generatedPageBaseSlug(undefined, "Boats in Austin") === "boats-in-austin" &&
      generatedPageBaseSlug("My Slug!", "ignored") === "my-slug",
  );
  const symbols = refusal({ title: "!!!" });
  t("a title with nothing to slug is refused", symbols instanceof CustomerFacingError);
  t(
    "a too-short or too-long title is refused before anything else",
    refusal({ title: "ab" }) instanceof CustomerFacingError &&
      (refusal({ title: "ab" }) as Error).message === PAGE_TITLE_INVALID_MESSAGE &&
      refusal({ title: "x".repeat(141) }) instanceof CustomerFacingError &&
      refusal({ title: "   " }) instanceof CustomerFacingError,
  );
  t(
    "a good request passes and reports the base slug persist will use",
    validatePageRequest({ title: "Boats in Austin" }).baseSlug === "boats-in-austin" &&
      validatePageRequest({ title: "Boats in Austin", slug: "austin-boats" }).baseSlug === "austin-boats",
  );
  const server = read("src/lib/generation.server.ts");
  const persistFn = server.slice(
    server.indexOf("export async function persistGeneratedPage"),
    server.indexOf("export type LedgerSettlement"),
  );
  t(
    "persistGeneratedPage derives its slug with the same helper",
    persistFn.includes("const baseSlug = generatedPageBaseSlug(input.slug, input.requestedTitle);"),
  );
}

console.log("\n=== batch attempt ids (one reservation per attempt) ===");
{
  const item = { id: "11111111-1111-4111-8111-111111111111", job_id: "22222222-2222-4222-8222-222222222222", attempts: 0 };
  const a = await batchAttemptRequestId(item);
  const again = await batchAttemptRequestId({ ...item });
  const next = await batchAttemptRequestId({ ...item, attempts: 1 });
  const otherJob = await batchAttemptRequestId({ ...item, job_id: "33333333-3333-4333-8333-333333333333" });
  const otherItem = await batchAttemptRequestId({ ...item, id: "44444444-4444-4444-8444-444444444444" });
  t("two drivers reading the same row compute the same attempt id", a === again);
  t("the next attempt gets a new id (a new slot)", a !== next);
  t(
    "a new life of the item (deleted draft: attempts reset to 0 in a NEW job) never collides with the old attempt 1",
    a !== otherJob,
  );
  t("another item never shares an id", a !== otherItem);
  t(
    "the id is seeded by item, job and the attempt the claim will write",
    a === (await deterministicRequestId(`item:${item.id}:${item.job_id}:1`)),
  );
  t(
    "the id is a v4 uuid (the reservation key)",
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a),
  );
}

console.log("\n=== pause switch ===");
{
  t("boolean true pauses", isGenerationPaused(true));
  t('string "true" pauses', isGenerationPaused("true"));
  t('string " TRUE " pauses', isGenerationPaused(" TRUE "));
  t("boolean false does not", !isGenerationPaused(false));
  t('string "false" does not', !isGenerationPaused("false"));
  t("missing does not", !isGenerationPaused(undefined));
  t("a number does not", !isGenerationPaused(1));
  t(
    "the item error for a paused refusal starts with Paused",
    /^paused/i.test(GENERATION_PAUSED_MESSAGE),
  );
}

console.log("\n=== attempt ceiling ===");
{
  t("the ceiling is 3 attempts", MAX_ITEM_ATTEMPTS === 3);
  t(
    "0, 1 and 2 attempts may still run",
    [0, 1, 2].every((n) => !attemptsExhausted(n)),
  );
  t("3 attempts is exhausted", attemptsExhausted(3));
  t("more than 3 is exhausted", attemptsExhausted(7));
  t("missing attempts counts as 0", !attemptsExhausted(null) && !attemptsExhausted(undefined));
  t(
    "the message says how many attempts were made",
    ATTEMPTS_EXHAUSTED_MESSAGE.includes("3 attempts"),
  );
}

console.log("\n=== job planning is idempotent by target key ===");
{
  const existing = [
    {
      target_key: "city:austin|tx",
      status: "done",
      page_id: "p1",
      updated_at: ago(3600_000),
      attempts: 1,
    },
    {
      target_key: "city:dallas|tx",
      status: "failed",
      page_id: null,
      updated_at: ago(60_000),
      attempts: 1,
    },
    {
      target_key: "city:waco|tx",
      status: "pending",
      page_id: null,
      updated_at: ago(60_000),
      attempts: 0,
    },
    {
      target_key: "city:plano|tx",
      status: "running",
      page_id: null,
      updated_at: ago(60_000),
      attempts: 1,
    },
    {
      target_key: "city:tyler|tx",
      status: "running",
      page_id: null,
      updated_at: ago(4 * 60_000),
      attempts: 1,
    },
    {
      target_key: "city:frisco|tx",
      status: "done",
      page_id: null,
      updated_at: ago(60_000),
      attempts: 3,
    },
    {
      target_key: "city:laredo|tx",
      status: "failed",
      page_id: null,
      updated_at: ago(60_000),
      attempts: 3,
    },
    {
      target_key: "city:odessa|tx",
      status: "skipped",
      page_id: null,
      updated_at: ago(60_000),
      attempts: 0,
    },
  ];
  const requested = [
    "city:austin|tx",
    "city:dallas|tx",
    "city:waco|tx",
    "city:plano|tx",
    "city:tyler|tx",
    "city:frisco|tx",
    "city:laredo|tx",
    "city:odessa|tx",
    "city:houston|tx",
    "city:houston|tx",
  ];
  const plan = planJobItems(requested, existing, NOW);
  t(
    "done keys with a live draft are reused, never regenerated",
    plan.alreadyDone.length === 1 && plan.alreadyDone[0] === "city:austin|tx",
  );
  t(
    "failed keys are re-attached (idle), not duplicated",
    plan.reattach.includes("city:dallas|tx") && plan.reattachBy.idle.includes("city:dallas|tx"),
  );
  t("pending keys are re-attached (idle)", plan.reattachBy.idle.includes("city:waco|tx"));
  t("skipped keys are re-attached (idle)", plan.reattachBy.idle.includes("city:odessa|tx"));
  t(
    "a LIVE running key is left alone — never reset to pending",
    plan.inProgress.includes("city:plano|tx") && !plan.reattach.includes("city:plano|tx"),
  );
  t(
    "a STALE running key is re-attached (staleRunning)",
    plan.reattach.includes("city:tyler|tx") &&
      plan.reattachBy.staleRunning.includes("city:tyler|tx"),
  );
  t(
    "a done key whose draft was deleted is generatable again (pageDeleted)",
    plan.reattach.includes("city:frisco|tx") &&
      plan.reattachBy.pageDeleted.includes("city:frisco|tx") &&
      !plan.alreadyDone.includes("city:frisco|tx"),
  );
  t(
    "a deleted-draft key is re-attached even with attempts exhausted (fresh life)",
    !plan.exhausted.includes("city:frisco|tx"),
  );
  t(
    "a failed key at the attempt ceiling is exhausted, not re-attached",
    plan.exhausted.includes("city:laredo|tx") && !plan.reattach.includes("city:laredo|tx"),
  );
  t("unknown keys are created", plan.create.length === 1 && plan.create[0] === "city:houston|tx");
  t(
    "a key requested twice is planned once",
    plan.create.filter((k) => k === "city:houston|tx").length === 1,
  );
  const all = [
    ...plan.create,
    ...plan.reattach,
    ...plan.alreadyDone,
    ...plan.inProgress,
    ...plan.exhausted,
  ];
  t("no key lands in two buckets", new Set(all).size === all.length);
  t("every requested key lands somewhere", new Set(all).size === new Set(requested).size);
  t(
    "reattach is exactly the union of its sub-buckets",
    [...plan.reattach].sort().join() ===
      [...plan.reattachBy.idle, ...plan.reattachBy.staleRunning, ...plan.reattachBy.pageDeleted]
        .sort()
        .join(),
  );
  const again = planJobItems(["city:austin|tx"], existing, NOW);
  t(
    "re-running for a done key creates nothing",
    again.create.length === 0 && again.reattach.length === 0,
  );
  t(
    "a running key just past the stale window is re-attached",
    planJobItems(
      ["city:x|"],
      [
        {
          target_key: "city:x|",
          status: "running",
          page_id: null,
          updated_at: ago(STALE_RUNNING_MS + 1),
          attempts: 1,
        },
      ],
      NOW,
    ).reattachBy.staleRunning.length === 1,
  );
  t(
    "a running key exactly at the stale window is still live",
    planJobItems(
      ["city:x|"],
      [
        {
          target_key: "city:x|",
          status: "running",
          page_id: null,
          updated_at: ago(STALE_RUNNING_MS),
          attempts: 1,
        },
      ],
      NOW,
    ).inProgress.length === 1,
  );
}

console.log("\n=== stale running detection ===");
{
  t("updated 1 minute ago is live", !isStaleRunning(ago(60_000), NOW));
  t("updated 4 minutes ago is stale", isStaleRunning(ago(4 * 60_000), NOW));
  t("missing timestamp is stale", isStaleRunning(null, NOW));
  t("garbage timestamp is stale", isStaleRunning("not a date", NOW));
  t(
    "the provider timeout is shorter than the stale window (no double drivers)",
    PAGE_GENERATION_TIMEOUT_MS < STALE_RUNNING_MS,
    `${PAGE_GENERATION_TIMEOUT_MS} vs ${STALE_RUNNING_MS}`,
  );
  t("the provider timeout is 120 seconds", PAGE_GENERATION_TIMEOUT_MS === 120_000);
  t(
    "…and it is the page_generation route's own limit (one table, no second constant)",
    PAGE_GENERATION_TIMEOUT_MS === AI_ROUTE_LIMITS.page_generation.timeoutMs,
  );
}

console.log("\n=== platform funds: a whole page is HELD before the call, not balance > 0 ===");
{
  // The old check compared a balance with an estimate in TypeScript and then
  // charged after the call. Now ai_reserve holds the MAXIMUM a page can cost
  // (every input token uncached, every allowed output token) atomically, in
  // credits for a tenant, before anything is sent: a balance of 1 credit can
  // no longer start a page that costs more. tests/ai-spend-sql.test.ts runs
  // the SQL (a balance one credit short of the hold is refused, exactly the
  // hold is granted); tests/ai-concurrency.pg.ts proves it under 50-way
  // concurrency on PostgreSQL 16.
  const premium = estimatedCreditsPerPage("premium");
  const standard = estimatedCreditsPerPage("standard");
  t("a premium page is estimated at more than a standard one", premium > standard, `${premium} vs ${standard}`);
  t("a standard page is estimated at one credit or more", standard >= 1, String(standard));
  const limits = AI_ROUTE_LIMITS.page_generation;
  for (const tier of GENERATION_TIERS) {
    const model = modelForTier(tier);
    const hold = maxCostMicros(model, TYPICAL_PAGE_TOKENS.prompt, limits.maxOutputTokens);
    t(
      `the ${tier} hold covers a typical page with room to spare`,
      creditsForCostMicros(hold) >= creditsForUsage(model, TYPICAL_PAGE_TOKENS.prompt, TYPICAL_PAGE_TOKENS.completion),
      `${creditsForCostMicros(hold)} credits held`,
    );
  }
  const spend = read("src/lib/ai/spend.server.ts");
  t(
    "a tenant hold is at least one credit and covers the maximum cost",
    /maxCredits: call\.billingClass === "tenant" \? Math\.max\(1, creditsForCostMicros\(holdMicros\)\) : 0,/.test(spend) &&
      /const holdMicros = maxCostMicros\(model, maxInputTokens, limits\.maxOutputTokens\);/.test(spend),
  );
  t(
    "the hold is taken before the provider call, and a refusal throws before it",
    spend.indexOf("await aiReserve(db,") > 0 &&
      spend.indexOf("await aiReserve(db,") < spend.indexOf("result = await callOpenAI<T>(") &&
      /if \(reserved\.status !== "reserved"\) \{[\s\S]*?throw new CustomerFacingError\(refusalMessage\(reserved\.status, call\.refusalMessages\), reserved\.status\);/.test(
        spend,
      ),
  );
  const server = read("src/lib/generation.server.ts");
  t(
    "nothing in generation reads a balance to decide affordability any more",
    !/hasPlatformFunds|credit_balances/.test(server),
  );
}

console.log("\n=== settlement → billing_status ===");
{
  const s = (settled: boolean, billing: any, creditsCharged: number) => ({ settled, billing, creditsCharged });
  t("byok → free", billingStatusFor(s(true, "byok", 0)) === "free");
  t("beta grant → free", billingStatusFor(s(true, "granted", 0)) === "free");
  t("free platform quota → free", billingStatusFor(s(true, "free_quota", 0)) === "free");
  t("credits actually charged → charged", billingStatusFor(s(true, "credits", 3)) === "charged");
  t("credits path with nothing owed → free", billingStatusFor(s(true, "credits", 0)) === "free");
  t(
    "a settle that could not be recorded → pending (the hold covers it; the reaper settles it), never charged or free",
    billingStatusFor(s(false, "credits", 0)) === "pending" && billingStatusFor(s(false, "free_quota", 0)) === "pending",
  );
  t(
    "the page's billing mode follows the hold's billing",
    billingModeFor("byok") === "byok" &&
      billingModeFor("granted") === "granted" &&
      billingModeFor("credits") === "platform" &&
      billingModeFor("free_quota") === "platform",
  );

  // Settlement is idempotent by REQUEST ID in the database: ai_settle closes
  // the one ai_spend_reservations row for (workspace, request id) and a
  // second settle is answered 'already_settled' without charging again
  // (tests/ai-spend-sql.test.ts). The app-side ledger lookups, conflict
  // adoption and "unbilled" branch are gone with the app-side settlement.
  const server = read("src/lib/generation.server.ts");
  const spend = read("src/lib/ai/spend.server.ts");
  t(
    "generation has no settlement of its own (no ledger lookups, deductions or free-quota RPCs)",
    !/settleGeneration|settleOnPlatform|findLedgerCharge|settle_generation_free_quota|deduct_credits|consume_platform_ai_credit|recordFailedGeneration/.test(
      server,
    ),
  );
  t(
    "the spend flow settles through ai_settle exactly once per call, and accepts only 'settled' / 'already_settled'",
    // Three exits, each settling once: a failed beforeCall (at zero, round-4
    // L7), an exception out of callOpenAI (round-4 L6) — both rethrow at once,
    // never reaching the final settle — and the normal settle.
    (spend.match(/await settleSafely\(/g) ?? []).length === 3 &&
      (spend.match(/await settleSafely\(db, call, model, billing, settleInputFor\(model, (?:notSent|result), null\)\);\s*throw e;/g) ?? [])
        .length === 2 &&
      /const settlement = await settleSafely\(db, call, model, billing, settleInputFor\(model, result, failCode\)\);/.test(spend) &&
      /if \(s\.status !== "settled" && s\.status !== "already_settled"\) \{/.test(spend),
  );
  t(
    "a settle that fails is logged loudly and left for the reaper at the full hold",
    /UNSETTLED call \(the reaper settles it within 35 minutes\)/.test(spend),
  );
  const fns = read("src/lib/generation.functions.ts");
  t(
    "the batch item records what the settlement charged",
    /credits_charged: gen\.settlement\.creditsCharged,\s*billing_status: billingStatusFor\(gen\.settlement\),/.test(fns),
  );
  t(
    "an item can no longer be failed as 'unbilled' after a settled generation",
    !/billing_status: "unbilled"/.test(fns),
  );

  // Two books (settleInputFor; the full table is driven in
  // tests/ai-provider.test.ts and tests/ai-spend-sql.test.ts). A delivered
  // page whose usage OpenAI omitted is charged the FULL hold — never a free
  // page; every failure refunds the customer in full while the platform
  // budget keeps what OpenAI may have been paid.
  t(
    "a delivered page without usage settles at the full hold (cost null) with the reason usage_missing",
    /if \(!r\.usage\) return \{ usage: null, costMicros: null, credits: null, outcome: "ok", error: "usage_missing" \};/.test(spend),
  );
  t(
    "a failure with reported usage refunds the customer (credits 0) and records the cost on the platform budget",
    /if \(usage\) return \{ usage, costMicros: cost\(usage\), credits: 0, outcome: "failed", error \};/.test(spend),
  );
  t(
    "a failure after the request left, without usage, keeps the full hold on the platform budget only",
    /return \{ usage: null, costMicros: null, credits: null, outcome: "failed", error \};/.test(spend),
  );
  t(
    "the charge is priced on the reported usage (input, cached input, output)",
    /const cost = \(u: AiUsage\) => costMicrosForUsage\(model, u\);/.test(spend),
  );
}

console.log("\n=== model policy (a quality tier, never a model) ===");
{
  t("the allowlist is exactly gpt-5-nano and gpt-5-mini", AI_MODELS.join() === "gpt-5-nano,gpt-5-mini");
  t("the default tier is standard", GENERATION_DEFAULT_TIER === "standard");
  t(
    "standard → gpt-5-nano, premium → gpt-5-mini (server-side mapping)",
    modelForTier("standard") === "gpt-5-nano" && modelForTier("premium") === "gpt-5-mini",
  );
  t("every tier maps to an allowlisted model", GENERATION_TIERS.every((q) => isAllowedModel(modelForTier(q))));
  t(
    "an unknown tier throws instead of mapping to some model",
    (() => {
      try {
        modelForTier("ultra" as any);
        return false;
      } catch {
        return true;
      }
    })(),
  );
  t(
    "a stored model outside the allowlist has no tier (a job carrying one is refused, not upgraded)",
    tierForModel("google/gemini-3.1-pro-preview") === null &&
      tierForModel("gpt-5") === null &&
      tierForModel("gpt-5-nano") === "standard" &&
      tierForModel("gpt-5-mini") === "premium",
  );
  t("the old OpenRouter ids are not allowed models", !isAllowedModel("google/gemini-3-flash-preview"));
  t(
    "the picker offers exactly the tiers, standard first",
    GENERATION_TIER_OPTIONS.map((o) => o.tier).join() === GENERATION_TIERS.join() &&
      GENERATION_TIERS[0] === "standard",
  );
  t(
    "the picker shows no model names",
    GENERATION_TIER_OPTIONS.every((o) => !/gpt|nano|mini|gemini|openai/i.test(`${o.label} ${o.hint}`)),
    JSON.stringify(GENERATION_TIER_OPTIONS),
  );
  t("the picker has a cost hint per tier", GENERATION_TIER_OPTIONS.every((o) => /credit/.test(o.hint)));

  const base = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    title: "Boats in Austin",
    topic: "City hub page for boats in Austin, Texas",
  };
  const parsed = QuickPageInputSchema.safeParse(base);
  t(
    "quick page defaults to the standard tier",
    parsed.success && parsed.data.quality === "standard",
  );
  t(
    "quick page accepts both tiers",
    GENERATION_TIERS.every((q) => QuickPageInputSchema.safeParse({ ...base, quality: q }).success),
  );
  t(
    "quick page rejects an unknown tier instead of mapping it",
    !QuickPageInputSchema.safeParse({ ...base, quality: "ultra" }).success,
  );
  for (const key of ["model", "max_output_tokens", "maxOutputTokens", "temperature", "provider", "reasoning"]) {
    t(
      `quick page rejects a body carrying \`${key}\` (strict schema)`,
      !QuickPageInputSchema.safeParse({ ...base, [key]: key === "model" ? "gpt-5-mini" : 1 }).success,
    );
  }
  t(
    "quick page request id must be a uuid when given",
    !QuickPageInputSchema.safeParse({ ...base, generationRequestId: "abc" }).success &&
      QuickPageInputSchema.safeParse({
        ...base,
        generationRequestId: "22222222-2222-4222-8222-222222222222",
      }).success,
  );
  t(
    "quick page request id is optional (Opportunity Engine)",
    parsed.success && parsed.data.generationRequestId === undefined,
  );
}

console.log("\n=== deterministic request id (coach insight → same page on replay) ===");
{
  const a = await deterministicRequestId("coach:11111111-1111-4111-8111-111111111111:0");
  const b = await deterministicRequestId("coach:11111111-1111-4111-8111-111111111111:0");
  const c = await deterministicRequestId("coach:11111111-1111-4111-8111-111111111111:1");
  const d = await deterministicRequestId("coach:22222222-2222-4222-8222-222222222222:0");
  t("same seed → same id", a === b, `${a} vs ${b}`);
  t("a different insight index → a different id", a !== c);
  t("a different briefing → a different id", a !== d);
  t(
    "the id is a version-4, RFC-variant uuid",
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a),
    a,
  );
  t(
    "the id passes the quick page's request-id gate",
    QuickPageInputSchema.safeParse({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      title: "Boats in Austin",
      topic: "City hub page for boats in Austin, Texas",
      generationRequestId: a,
    }).success,
  );
  t(
    "the coach derives the id from briefing + insight and falls back to a random uuid only without a briefing",
    /deterministicRequestId\(`coach:\$\{origin\.briefingId\}:\$\{origin\.insightIndex \?\? 0\}`\)/.test(
      read("src/lib/coach-actions.functions.ts"),
    ) &&
      /origin\.briefingId\s*\?\s*await deterministicRequestId[\s\S]*?:\s*crypto\.randomUUID\(\)/.test(
        read("src/lib/coach-actions.functions.ts"),
      ),
  );
}

console.log("\n=== customerMessage: no database text reaches a tenant ===");
{
  const origError = console.error;
  const captured: string[] = [];
  console.error = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  try {
    const raw = new Error(
      'duplicate key value violates unique constraint "tenant_pages_workspace_id_slug_key"',
    );
    const out = customerMessage(raw, GENERATION_UNAVAILABLE_MESSAGE);
    t("an internal error maps to the fallback", out === GENERATION_UNAVAILABLE_MESSAGE, out);
    t(
      "the raw error is logged, never returned",
      captured.some((l) => l.includes("tenant_pages_workspace_id_slug_key")) &&
        !out.includes("tenant_pages"),
    );
    captured.length = 0;
    const passed = customerMessage(
      new CustomerFacingError("Out of funds"),
      GENERATION_UNAVAILABLE_MESSAGE,
    );
    t("a CustomerFacingError passes through verbatim", passed === "Out of funds");
    t("…without a log line", captured.length === 0);
    t("a non-Error value maps to the fallback", customerMessage("boom", "fb") === "fb");
    t(
      "the fallback is generic and actionable",
      /temporarily unavailable/i.test(GENERATION_UNAVAILABLE_MESSAGE) &&
        /try again/i.test(GENERATION_UNAVAILABLE_MESSAGE),
    );
    t("CustomerFacingError is an Error with its own name", new CustomerFacingError("x") instanceof Error && new CustomerFacingError("x").name === "CustomerFacingError");
  } finally {
    console.error = origError;
  }

  const server = read("src/lib/generation.server.ts");
  const spend = read("src/lib/ai/spend.server.ts");
  t(
    "the refusals a customer reads are thrown as CustomerFacingError (title, slug, key, funds, provider, thin output)",
    server.includes("throw new CustomerFacingError(PAGE_TITLE_INVALID_MESSAGE)") &&
      server.includes("throw new CustomerFacingError(PAGE_SLUG_UNDERIVABLE_MESSAGE)") &&
      /throw new CustomerFacingError\(AI_MESSAGES\.notConfigured, "no_key"\)/.test(spend) &&
      /throw new CustomerFacingError\(refusalMessage\(reserved\.status, call\.refusalMessages\), reserved\.status\);/.test(spend) &&
      /throw new CustomerFacingError\(failureMessage\(result\.kind\), result\.kind\);/.test(spend) &&
      /if \(checked\) throw new CustomerFacingError\(checked\.message, checked\.code\);/.test(spend) &&
      /message: `Generated body too short \(\$\{n\} chars\)`/.test(server) &&
      /insufficient: outOfCreditsMessage\(\),/.test(server),
  );
  const fns = read("src/lib/generation.functions.ts");
  const runItem = fns.slice(fns.indexOf("async function runItem("), fns.indexOf("const itemInput"));
  t(
    "runItem's gate refusal stores only a customer message",
    /return refuse\(customerMessage\(e, GENERATION_UNAVAILABLE_MESSAGE\)/.test(runItem) &&
      !/refuse\(\(e instanceof Error \? e\.message/.test(runItem),
  );
  t(
    "runItem's catch-all stores only a customer message",
    /const msg = customerMessage\(e, GENERATION_UNAVAILABLE_MESSAGE\);/.test(runItem) &&
      !/const msg = e instanceof Error \? e\.message : "Generation failed"/.test(runItem),
  );
  t(
    "the catch-all failure write's error is checked and logged, never swallowed",
    // Round-4 M1: the write gives the attempt back (token - 1) only for a
    // spend refusal before the provider call; fenced on the claim's token.
    /const \{ error: failErr \} = await sb\(\)\s*\.from\("generation_items"\)\s*\.update\(\{\s*status: "failed",\s*error: msg\.slice\(0, 300\),\s*\.\.\.\(refusedBeforeCall \? \{ attempts: token - 1 \} : \{\}\),\s*\}\)\s*\.eq\("id", row\.id\)\s*\.eq\("status", "running"\)\s*\.eq\("attempts", token\);/.test(
      runItem,
    ) && /if \(failErr\) \{[\s\S]*?console\.error\("\[generation\] could not record item failure"/.test(runItem),
  );
  const quick = read("src/lib/admin-quick-page.functions.ts");
  const serverFn = quick.slice(quick.indexOf("export const createQuickPage"));
  t(
    "the quick page server fn rethrows only a customer message",
    /return await runQuickPage\(data, context\.userId\);/.test(serverFn) &&
      /throw new Error\(customerMessage\(e, GENERATION_UNAVAILABLE_MESSAGE\)\);/.test(serverFn),
  );
}

console.log("\n=== out-of-funds copy points at support, not a withdrawn purchase ===");
{
  const strings: Array<[string, string]> = [
    ["outOfCreditsMessage", outOfCreditsMessage()],
    ["AI_MESSAGES.outOfFunds", AI_MESSAGES.outOfFunds],
  ];
  for (const [label, s] of strings) {
    t(`${label} names the included allowance and support`, /included AI generation/.test(s) && /contact support/i.test(s), s);
    t(`${label} has no purchase path`, !/top up/i.test(s) && !/Billing/.test(s) && !/buy|purchase/i.test(s), s);
  }
  t(
    "an out-of-funds hold is refused with the customer sentence (generation: outOfCreditsMessage)",
    /case "insufficient":\s*return AI_MESSAGES\.outOfFunds;/.test(read("src/lib/ai/spend.server.ts")) &&
      /insufficient: outOfCreditsMessage\(\),/.test(read("src/lib/generation.server.ts")),
  );
  t(
    "no generation or AI module still says Top up in Billing",
    ![
      "src/lib/generation.server.ts",
      "src/lib/admin-quick-page.functions.ts",
      "src/lib/ai/spend.server.ts",
      "src/lib/ai/customer-error.ts",
      "src/lib/generation.functions.ts",
    ].some((f) => /Top up in Billing/.test(read(f))),
  );
  for (const f of [
    "src/lib/coach-actions.functions.ts",
    "src/lib/admin-page-auditor.functions.ts",
    "src/lib/admin-seo-coach.functions.ts",
  ]) {
    t(
      `${f} does not send customers to the hidden API Keys page`,
      !read(f).includes("Settings → API Keys"),
    );
  }
  t(
    "a missing key is the plain 'not available, contact support' sentence for every route",
    AI_MESSAGES.notConfigured === "AI tools are not available right now. Contact support.",
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

console.log("\n=== OpenAI page writer (stubbed fetch, through the spend flow) ===");
{
  // generatePageContent → runMeteredAiCall → callOpenAI, with the provider
  // behind an injected fetch and the spend RPCs behind an injected db. No
  // city is passed, so no inventory read happens. What is asserted is what
  // would be sent to OpenAI, what reaches the customer, and what is settled.
  const WS = "11111111-1111-4111-8111-111111111111";
  const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const KEY = "sk-test-byok-0123456789";
  const body = "# Boats in Austin\n\n" + "Real copy about real boats. ".repeat(40);
  const page = {
    title: "Boats in Austin",
    seo_title: "Boats in Austin, TX",
    seo_description: "Rent a boat.",
    body_markdown: body,
  };
  const USAGE = {
    input_tokens: 812,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 1204,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 2016,
  };
  const responseObject = (content: unknown[], usage: unknown = USAGE, extra: Record<string, unknown> = {}) => ({
    id: "resp_test",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-5-nano-2025-08-07",
    output: [{ type: "message", id: "msg_test", status: "completed", role: "assistant", content }],
    usage,
    ...extra,
  });
  const textPart = (text: string) => ({ type: "output_text", text, annotations: [] });
  const jsonResponse = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json", "x-request-id": "req_test" },
    });

  type Event = { kind: "rpc" | "fetch"; name: string; args?: any };
  const makeDb = (events: Event[]) => ({
    rpc: async (name: string, args: any) => {
      events.push({ kind: "rpc", name, args });
      if (name === "ai_reserve") return { data: { status: "reserved", billing: "byok", hold_seq: 1, credits_charged: 0 }, error: null };
      if (name === "ai_mark_called") return { data: true, error: null };
      if (name === "ai_release") return { data: true, error: null };
      if (name === "ai_settle") {
        return {
          data: { status: "settled", billing: "byok", credits_charged: 0, cost_micros: args._cost_micros, full_hold: args._cost_micros === null },
          error: null,
        };
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
  });
  const billing: ResolvedBilling = {
    key: { apiKey: KEY, source: "byok" },
    keySource: "byok",
    billingClass: "byok",
    mode: "byok",
  };
  type Captured = { url: string; init?: RequestInit };
  async function write(
    respond: (req: Captured) => Promise<Response> | Response,
    opts: { tier?: "standard" | "premium" } = {},
  ) {
    const events: Event[] = [];
    const requests: Captured[] = [];
    const logs: string[] = [];
    const origError = console.error;
    const origWarn = console.warn;
    console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    console.warn = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    let out: Awaited<ReturnType<typeof generatePageContent>> | null = null;
    let caught: unknown = null;
    try {
      out = await generatePageContent({
        workspaceId: WS,
        userId: USER,
        requestId: crypto.randomUUID(),
        source: "quick_page",
        tier: opts.tier ?? "standard",
        title: "Boats in Austin",
        topic: "City hub page for boats in Austin, Texas",
        billing,
        deps: {
          db: makeDb(events),
          transport: {
            fetch: async (input, init) => {
              const req = { url: String(input instanceof Request ? input.url : input), init };
              requests.push(req);
              events.push({ kind: "fetch", name: req.url });
              return respond(req);
            },
          },
        },
      });
    } catch (e) {
      caught = e;
    } finally {
      console.error = origError;
      console.warn = origWarn;
    }
    const settle = events.find((e) => e.name === "ai_settle")?.args ?? null;
    return { out, caught, err: caught instanceof Error ? caught.message : "", events, requests, logs, settle };
  }

  const ok = await write(() => jsonResponse(responseObject([textPart(JSON.stringify(page))])));
  t("parses the structured page", ok.out?.title === "Boats in Austin" && ok.out?.body_markdown === body, ok.err);
  t(
    "reports token usage",
    ok.out?.usage?.inputTokens === 812 && ok.out?.usage?.outputTokens === 1204,
    JSON.stringify(ok.out?.usage),
  );
  t("exactly one request, to the Responses API", ok.requests.length === 1 && ok.requests[0]!.url === "https://api.openai.com/v1/responses", ok.requests[0]?.url);
  const sent = JSON.parse(String(ok.requests[0]?.init?.body ?? "{}"));
  t(
    "Structured Outputs with the write_page schema, strict",
    sent.text?.format?.type === "json_schema" &&
      sent.text?.format?.name === "write_page" &&
      sent.text?.format?.strict === true &&
      JSON.stringify(sent.text?.format?.schema) === JSON.stringify(WRITE_PAGE_SCHEMA),
    JSON.stringify(sent.text),
  );
  t("standard sends gpt-5-nano", sent.model === "gpt-5-nano", sent.model);
  t(
    "the route's output limit, store off, minimal reasoning, no sampling parameters",
    sent.max_output_tokens === AI_ROUTE_LIMITS.page_generation.maxOutputTokens &&
      sent.store === false &&
      sent.reasoning?.effort === "minimal" &&
      !("temperature" in sent) &&
      !("top_p" in sent),
    JSON.stringify({ ...sent, instructions: undefined, input: undefined }),
  );
  t(
    "bearer auth with the resolved key",
    new Headers(ok.requests[0]?.init?.headers).get("authorization") === `Bearer ${KEY}`,
  );
  t("every call carries an abort signal (timeout)", ok.requests[0]?.init?.signal instanceof AbortSignal);
  const order = ok.events.map((e) => (e.kind === "fetch" ? "provider" : e.name)).join(" → ");
  t("order: ai_reserve → ai_mark_called → provider → ai_settle", order === "ai_reserve → ai_mark_called → provider → ai_settle", order);
  t(
    "the hold is for the page route and the standard model",
    ok.events[0]?.args?._feature === "page_generation" && ok.events[0]?.args?._model === "gpt-5-nano",
  );
  t(
    "settled with the reported usage, outcome ok",
    ok.settle?._input_tokens === 812 && ok.settle?._output_tokens === 1204 && ok.settle?._outcome === "ok" && ok.settle?._error === null,
    JSON.stringify(ok.settle),
  );

  const premium = await write(() => jsonResponse(responseObject([textPart(JSON.stringify(page))])), { tier: "premium" });
  const premiumSent = JSON.parse(String(premium.requests[0]?.init?.body ?? "{}"));
  t("premium sends gpt-5-mini, and holds for it", premiumSent.model === "gpt-5-mini" && premium.events[0]?.args?._model === "gpt-5-mini");

  const thin = await write(() => jsonResponse(responseObject([textPart(JSON.stringify({ ...page, body_markdown: "too short" }))])));
  t(`rejects a body under ${MIN_BODY_CHARS} chars`, thin.err === "Generated body too short (9 chars)", thin.err);
  t("…as a customer-facing error", thin.caught instanceof CustomerFacingError);
  t(
    "…settled as 'failed' with the usage the provider reported (the call was paid for)",
    thin.settle?._outcome === "failed" && thin.settle?._error === "thin_output" && thin.settle?._input_tokens === 812 && thin.settle?._output_tokens === 1204,
    JSON.stringify(thin.settle),
  );

  const refused = await write(() => jsonResponse(responseObject([{ type: "refusal", refusal: "I can't help with that." }])));
  t("a model refusal is a customer sentence, not the model's text", refused.err === AI_MESSAGES.refusal && !/can't help/.test(refused.err), refused.err);
  t("…as a customer-facing error", refused.caught instanceof CustomerFacingError);

  const notJson = await write(() => jsonResponse(responseObject([textPart("plain text, not the object")])));
  t("output that is not the JSON object is rejected", notJson.err === AI_MESSAGES.malformed, notJson.err);
  t("…as a customer-facing error", notJson.caught instanceof CustomerFacingError);

  const wrongShape = await write(() => jsonResponse(responseObject([textPart(JSON.stringify({ title: "x" }))])));
  t("an object that misses the schema is rejected", wrongShape.err === AI_MESSAGES.malformed, wrongShape.err);
  t("…and settled with the usage reported", wrongShape.settle?._error === "schema_mismatch" && wrongShape.settle?._input_tokens === 812);

  const busy = await write(() => new Response("rate limited, slow down: req_abc123", { status: 429 }));
  t("a 429 is the generic 'busy' sentence", busy.err === AI_MESSAGES.providerBusy, busy.err);
  t("…as a customer-facing error", busy.caught instanceof CustomerFacingError);
  t("the provider body never reaches the customer", !busy.err.includes("rate limited") && !busy.err.includes("429"));
  t(
    "the status and the body go to the server log",
    busy.logs.some((l) => l.includes("429") && l.includes("rate limited") && l.includes("req_abc123")),
    busy.logs.join(" | "),
  );
  t("exactly one request (no SDK retry)", busy.requests.length === 1);
  t("…settled at zero: OpenAI rejected it before doing any work", busy.settle?._cost_micros === 0 && busy.settle?._error === "rate_limited", JSON.stringify(busy.settle));

  const boom = await write(() => new Response("x".repeat(1000), { status: 500 }));
  t("a 500 yields the generic provider message", boom.err === PROVIDER_ERROR_MESSAGE, boom.err);
  const boomLog = boom.logs.find((l) => l.includes("status=500")) ?? "";
  t("the logged body is truncated", boomLog.length > 0 && boomLog.length < 600, String(boomLog.length));
  t("…settled at the full hold (OpenAI may have done the work)", boom.settle?._cost_micros === null && boom.settle?._error === "server_error", JSON.stringify(boom.settle));

  // A provider that never answers: fetch rejects the way the runtime does
  // when the signal fires (a TimeoutError DOMException). The real abort
  // timing is exercised in tests/ai-provider.test.ts with a short timeout.
  const hung = await write(() => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
  t("a hung provider is abandoned with the timeout message", hung.err === PROVIDER_TIMEOUT_MESSAGE, hung.err);
  t("…as a customer-facing error", hung.caught instanceof CustomerFacingError);
  t("the timeout is logged server-side", hung.logs.some((l) => /timeout/.test(l)), hung.logs.join(" | "));
  t("…and settled at the full hold", hung.settle?._cost_micros === null && hung.settle?._error === "timeout", JSON.stringify(hung.settle));

  // 200 headers, then the body stalls until the abort fires mid-read.
  const midBody = await write(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"id":"resp_test","object":"resp'));
            controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  t("a timeout during the body read yields the timeout message", midBody.err === PROVIDER_TIMEOUT_MESSAGE, midBody.err);
  t("the raw abort message never reaches the customer", !/aborted/i.test(midBody.err));
  t("…settled at the full hold", midBody.settle?._cost_micros === null, JSON.stringify(midBody.settle));

  const html = await write(
    () =>
      new Response("<html>bad gateway trace-id=xyz</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  );
  t(
    "an unreadable 200 body is a fixed customer sentence, never the body",
    html.caught instanceof CustomerFacingError && !/html|trace-id|gateway/i.test(html.err) && [AI_MESSAGES.malformed, PROVIDER_ERROR_MESSAGE].includes(html.err as any),
    html.err,
  );
  t("…logged as a malformed body", html.logs.some((l) => /malformed/.test(l)), html.logs.join(" | "));

  const reset = await write(() => {
    throw new TypeError("fetch failed: ECONNRESET 10.0.0.1");
  });
  t("a network failure yields the generic message", reset.err === PROVIDER_ERROR_MESSAGE, reset.err);
  t("the network failure detail stays in the log", reset.logs.some((l) => l.includes("ECONNRESET")), reset.logs.join(" | "));

  const leaky = await write(() => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}`, type: "invalid_request_error", code: "invalid_api_key" } }), { status: 401, headers: { "content-type": "application/json" } }));
  t("a rejected key is the 'not available' sentence", leaky.err === AI_MESSAGES.notConfigured, leaky.err);
  t("the key never reaches a log line", !leaky.logs.some((l) => l.includes(KEY)), leaky.logs.join(" | "));
  t("…settled at zero (rejected before any work)", leaky.settle?._cost_micros === 0 && leaky.settle?._error === "auth", JSON.stringify(leaky.settle));
}

console.log("\n=== batch pipeline ordering (source guards) ===");
{
  const fns = read("src/lib/generation.functions.ts");
  const runItem = fns.slice(fns.indexOf("async function runItem("), fns.indexOf("const itemInput"));
  const claim = runItem.indexOf("attempts: row.attempts + 1");
  t("runItem was found", runItem.length > 0 && claim > 0);
  t("the pause switch is checked before the claim", runItem.indexOf("settings.paused") < claim);
  t(
    "the attempt ceiling is checked before the claim",
    runItem.indexOf("attemptsExhausted(row.attempts)") < claim,
  );
  // The job's stored model is re-validated: anything outside the allowlist
  // is refused, never mapped to another model.
  t(
    "the job's model must map back to a tier, before the claim",
    /const tier = job\?\.model \? tierForModel\(job\.model\) : GENERATION_DEFAULT_TIER;\s*if \(!tier\) \{[\s\S]*?return refuse\(GENERATION_UNAVAILABLE_MESSAGE\);/.test(runItem) &&
      runItem.indexOf("tierForModel(job.model)") < claim,
  );
  // The daily cap is a reservation PER ATTEMPT (one row per provider call),
  // not the pending item row: an item row can be re-armed, a reservation
  // cannot be taken back once its provider call is marked.
  const attemptIdAt = runItem.indexOf("const attemptId = await batchAttemptRequestId(row);");
  // The cap is the platform's, lifted (never the slot) for a workspace with
  // the founder / internal unlimited entitlement — read fresh per attempt.
  const capAt = runItem.indexOf(
    "const cap = effectiveDailyCap(settings.dailyCap, await isInternalWorkspace(workspaceId));",
  );
  const reserveAt = runItem.indexOf("slot = await reserveGenerationSlot(workspaceId, attemptId, cap);");
  t(
    "each attempt reserves its own daily-cap slot, under its attempt id, BEFORE the claim",
    attemptIdAt > 0 && capAt > attemptIdAt && reserveAt > capAt && reserveAt < claim,
    `${attemptIdAt} ${capAt} ${reserveAt} ${claim}`,
  );
  t(
    "the batch no longer counts the cap in TypeScript per item",
    !runItem.includes("countConsumedLast24h(") && !runItem.includes("excludeItemId"),
  );
  t(
    "an item whose draft exists takes no slot (nothing is generated again)",
    /let slotId: string \| null = null;\s*if \(!row\.page_id\) \{[\s\S]*?const attemptId = await batchAttemptRequestId\(row\);/.test(
      runItem,
    ),
  );
  t(
    "a full cap refuses the item without consuming an attempt (before the claim, through refuse)",
    /if \(slot === "cap_reached"\) return refuse\(dailyCapMessage\(settings\.dailyCap, 0\)\);/.test(runItem) &&
      runItem.indexOf('if (slot === "cap_reached")') < claim,
  );
  t(
    "an attempt another driver holds or spent is left alone (no claim, no write)",
    /if \(slot !== "reserved"\) \{[\s\S]*?return \{ item: await freshItem\(row\.id\), changed: false \};\s*\}/.test(runItem),
  );
  t(
    "a failed reservation read refuses the item (never generates uncapped)",
    /slot = await reserveGenerationSlot\(workspaceId, attemptId, cap\);\s*\} catch \(e\) \{\s*return refuse\(customerMessage\(e, GENERATION_UNAVAILABLE_MESSAGE\)\.slice\(0, 300\)\);/.test(
      runItem,
    ),
  );
  t(
    "the batch reservation is documented as one slot per attempt, shared with the spend hold",
    /daily cap is a RESERVATION per attempt/.test(fns) &&
      /the SAME id its spend hold\s*\* is taken under/.test(fns) &&
      /the daily-cap slot for THIS attempt, before the claim/.test(runItem),
  );
  // Who pays is decided before the slot: a billing refusal takes no slot at all.
  t(
    "who pays is resolved before the slot and the claim (a billing refusal reserves nothing)",
    runItem.indexOf("billing = await resolveBillingMode(workspaceId);") > 0 &&
      runItem.indexOf("billing = await resolveBillingMode(workspaceId);") < reserveAt &&
      /billing = await resolveBillingMode\(workspaceId\);\s*\} catch \(e\) \{[\s\S]{0,300}?return refuse\(customerMessage\(e, GENERATION_UNAVAILABLE_MESSAGE\)\.slice\(0, 300\)\);/.test(
        runItem,
      ),
  );
  // The slot goes back ONLY on a way out that never reached the provider.
  t(
    "a claim error or a lost claim releases the slot",
    /if \(claimErr\) \{\s*await releaseSlot\(\);\s*throw new Error\(claimErr\.message\);/.test(runItem) &&
      /if \(!claimed\) \{[\s\S]*?await releaseSlot\(\);\s*return \{ item: await freshItem\(row\.id\), changed: false \};/.test(runItem),
  );
  t(
    "linking an existing page instead of generating releases the slot",
    /billing_status: "free",\s*error: null,\s*\}\);[\s\S]{0,120}?await releaseSlot\(\);/.test(runItem),
  );
  t(
    "the attempt's slot is marked spent in beforeProviderCall, under the attempt id, then slotMarked is set",
    /beforeProviderCall: async \(\) => \{\s*await markGenerationProviderCalled\(workspaceId, attemptSlot\);\s*slotMarked = true;\s*\}/.test(
      runItem,
    ) && /const attemptSlot = slotId;/.test(runItem),
  );
  t(
    "the spend hold is taken under the SAME attempt id as the slot",
    /gen = await generatePageContent\(\{\s*workspaceId,\s*userId,\s*requestId: attemptSlot,\s*source: "batch_generation",\s*tier,/.test(runItem),
  );
  t(
    "after the provider call the slot is never released (the spend flow settled the call)",
    /\} catch \(e\) \{\s*if \(!slotMarked\) \{[\s\S]*?await releaseSlot\(\);\s*\}/.test(runItem) &&
      !/recordFailedGeneration|settleGeneration/.test(runItem),
  );
  t(
    "releaseSlot touches only this run's own reservation",
    /const releaseSlot = async \(\) => \{\s*if \(slotId\) await releaseGenerationSlot\(workspaceId, slotId\);\s*\};/.test(runItem),
  );
  t(
    "an item that already has a page never generates again",
    runItem.indexOf("if (row.page_id) {") > claim &&
      runItem.indexOf("if (row.page_id) {") < runItem.indexOf("generatePageContent("),
  );
  t(
    "an existing page for the city is linked instead of generated",
    runItem.indexOf("findExistingCityPage(") < runItem.indexOf("generatePageContent("),
  );
  const genAt = runItem.indexOf("gen = await generatePageContent(");
  const persist = runItem.indexOf("saved = await persistGeneratedPage(");
  const link = runItem.indexOf("page_id: page.id", persist);
  t(
    "the draft is written inside the spend flow's deliver step (before the settlement), and linked to the item after",
    genAt > 0 &&
      persist > genAt &&
      /deliver: async \(draft\) => \{\s*saved = await persistGeneratedPage\(\{\s*workspaceId,\s*generated: draft,/.test(runItem) &&
      /const page = saved as PersistedPage \| null;\s*if \(!page\) throw new Error/.test(runItem) &&
      link > persist,
  );
  t(
    "the page link and what the settlement charged land in ONE fenced write",
    /await markItemFenced\(row\.id, token, \{\s*status: "done",\s*page_id: page\.id,\s*slug: page\.slug,\s*prompt_tokens: gen\.usage\?\.inputTokens \?\? null,\s*completion_tokens: gen\.usage\?\.outputTokens \?\? null,\s*credits_charged: gen\.settlement\.creditsCharged,/.test(
      runItem,
    ),
  );
  t(
    "the fenced write throws when it lands on no row",
    /if \(!data \|\| data\.length === 0\) throw new LostClaimError\(\)/.test(fns),
  );

  // Pre-claim writes (cancel → skipped, refuse → failed) are fenced on the
  // state the driver read. A second driver refusing after the first claimed
  // must match zero rows and leave the live claim alone.
  const fence = fns.slice(
    fns.indexOf("async function markItemIfUnchanged("),
    fns.indexOf("class LostClaimError"),
  );
  t("markItemIfUnchanged was found", fence.length > 0);
  t(
    "pre-claim writes carry the status AND attempts predicates and return the matched rows",
    fence.includes('.eq("id", row.id)') &&
      fence.includes('.eq("status", row.status)') &&
      fence.includes('.eq("attempts", row.attempts)') &&
      fence.includes('.select("id")') &&
      /return !!data && data\.length > 0;/.test(fence),
  );
  t(
    "the cancel→skipped write is fenced",
    /const changed = await markItemIfUnchanged\(row, \{ status: "skipped", error: "Job was cancelled" \}\);\s*return \{ item: await freshItem\(row\.id\), changed \};/.test(
      runItem,
    ),
  );
  t(
    "the refuse→failed write is fenced",
    /const changed = await markItemIfUnchanged\(row, \{ status: "failed", error: message \}\);\s*return \{ item: await freshItem\(row\.id\), changed \};/.test(
      runItem,
    ),
  );
  t(
    "zero rows matched → changed: false (nothing else touched)",
    !/markItem\(/.test(fns) && fns.includes("Returns whether the write landed"),
  );
  t("no unconditional pre-claim item write survives", !/async function markItem\(/.test(fns));

  const start = fns.slice(
    fns.indexOf("export const startGenerationJob"),
    fns.indexOf("export const getGenerationJob"),
  );
  t(
    "the job stores the model the SERVER resolved from the tier",
    /const model = modelForTier\(data\.quality\);/.test(start) && /status: "queued",\s*model,/.test(start),
  );
  t(
    "the job input takes a tier, is strict, and never a model",
    /quality: z\.enum\(GENERATION_TIERS\)\.default\(GENERATION_DEFAULT_TIER\),/.test(fns) &&
      /export const StartGenerationJobInputSchema = z\s*\.object\(\{[\s\S]*?\}\)\s*\.strict\(\);/.test(fns),
  );
  t(
    "idle re-attach is guarded by status",
    start.includes('.in("status", ["pending", "failed", "skipped"])'),
  );
  t(
    "idle re-attach respects the attempt ceiling",
    start.includes('.lt("attempts", MAX_ITEM_ATTEMPTS)'),
  );
  t(
    "running re-attach requires staleness at write time",
    start.includes('.eq("status", "running")') && start.includes('.lt("updated_at", cutoff)'),
  );
  t(
    "deleted-draft re-attach requires page_id null at write time",
    start.includes('.is("page_id", null)'),
  );
  t(
    "live running items are reported back, not reset",
    start.includes("inProgress: plan.inProgress"),
  );
  t(
    "the plan reads page_id, updated_at and attempts",
    start.includes('select("target_key, status, page_id, updated_at, attempts")'),
  );
  t(
    "the cap check counts consumption, not just done items",
    start.includes("countConsumedLast24h(data.workspaceId)"),
  );
  t(
    "no pending reset of running rows survives",
    !/status: "pending"[^;]*\.neq\("status", "done"\)/.test(start),
  );

  t(
    "cancelGenerationJob exists and is member-checked",
    /export const cancelGenerationJob[\s\S]*?assertWorkspaceMember/.test(fns),
  );
  t(
    "cancel skips only pending items",
    /cancelGenerationJob[\s\S]*?status: "skipped"[\s\S]*?\.eq\("status", "pending"\)/.test(fns),
  );
  t(
    "settleJobStatus never overwrites a cancelled job",
    /async function settleJobStatus[\s\S]*?\.in\("status", \["queued", "running"\]\)/.test(fns),
  );
  const list = fns.slice(
    fns.indexOf("export const listGenerationTargets"),
    fns.indexOf("export const startGenerationJob"),
  );
  t(
    "listGenerationTargets is bounded to the cities on screen",
    list.includes('.in("target_key", keys)') && list.includes(".limit(keys.length)"),
  );
  t(
    "listGenerationTargets selects only needed columns",
    list.includes('select("target_key, status, page_id, attempts")'),
  );
  t(
    "alreadyGenerated requires a live page",
    list.includes('existing?.status === "done" && !!existing.page_id'),
  );
  t(
    "listGenerationTargets offers tiers, never model names",
    list.includes("tiers: GENERATION_TIER_OPTIONS") && list.includes("defaultTier: GENERATION_DEFAULT_TIER") && !/models:/.test(list),
  );
}

console.log("\n=== quick page pipeline (source guards) ===");
{
  const quick = read("src/lib/admin-quick-page.functions.ts");
  const handler = quick.slice(
    quick.indexOf("export async function runQuickPage"),
    quick.indexOf("export const createQuickPage"),
  );
  const gen = handler.indexOf("generatePageContent(");
  t("runQuickPage was found", handler.length > 0 && gen > 0);
  t("replays by request id before generating", handler.indexOf("findPageByRequestId(") < gen);
  t("checks the pause switch before generating", handler.indexOf("readPlatformSettings()") < gen);
  const reserve = handler.indexOf("reserveGenerationSlot(");
  t("reserves a daily-cap slot before generating (not a count-and-compare)", reserve > 0 && reserve < gen);
  t("the quick page no longer counts the cap in TypeScript", !quick.includes("countConsumedLast24h("));
  t(
    "the reservation is keyed by the request id and the platform cap (lifted only for the internal entitlement)",
    /const cap = effectiveDailyCap\(settings\.dailyCap, await isInternalWorkspace\(data\.workspaceId, deps\.db\)\);\s*const slot = await reserveGenerationSlot\(data\.workspaceId, generationRequestId, cap\);/.test(
      handler,
    ),
  );
  t(
    "a full cap is a customer-facing daily-cap refusal",
    /if \(slot === "cap_reached"\) \{\s*throw new CustomerFacingError\(dailyCapMessage\(settings\.dailyCap, 0\)\);/.test(
      handler,
    ),
  );
  t(
    "an id another request holds right now is refused as still being generated (no second provider call)",
    /if \(slot === "in_progress"\) throw new CustomerFacingError\(GENERATION_IN_PROGRESS_MESSAGE\);/.test(handler),
  );
  t(
    "a spent id returns its page if it still exists, and is refused otherwise (a deleted draft is not regenerated for free)",
    /if \(slot === "consumed"\) \{[\s\S]*?const existing = await findPageByRequestId\(data\.workspaceId, generationRequestId\);\s*if \(existing\) \{\s*return replayResult\([\s\S]*?throw new CustomerFacingError\(GENERATION_ALREADY_USED_MESSAGE\);/.test(
      handler,
    ),
  );
  const validateAt = handler.indexOf("validatePageRequest({ title: data.title, slug: data.slug });");
  t(
    "the title and slug are validated BEFORE the pause read, the reservation and the provider call",
    validateAt > 0 &&
      validateAt < handler.indexOf("readPlatformSettings()") &&
      validateAt < reserve &&
      validateAt < gen,
  );
  t(
    "the pause refusal is customer-facing",
    /if \(settings\.paused\) \{\s*throw new CustomerFacingError\(GENERATION_PAUSED_MESSAGE\);/.test(handler),
  );
  const payer = handler.indexOf("resolveBillingMode(");
  t("resolves who pays before generating", payer > 0 && payer < gen);
  t("resolves who pays before reserving (a no-key refusal takes no slot)", payer < reserve);
  const release = handler.indexOf("releaseGenerationSlot(");
  t(
    "a failure BEFORE the provider call releases the slot; one after it never does — and both rethrow",
    release > reserve &&
      /\} catch \(e\) \{\s*if \(!slotMarked\) \{[\s\S]*?await releaseGenerationSlot\(data\.workspaceId, generationRequestId\);\s*\}\s*throw e;/.test(
        handler,
      ) &&
      (handler.match(/releaseGenerationSlot\(/g) ?? []).length === 1,
  );
  t(
    "the slot is marked spent immediately before the provider request, then slotMarked is set",
    /beforeProviderCall: async \(\) => \{\s*await markGenerationProviderCalled\(data\.workspaceId, generationRequestId\);\s*slotMarked = true;\s*\}/.test(
      handler,
    ),
  );
  t(
    "the spend hold is taken under the SAME request id, at the requested tier",
    /generatePageContent\(\{\s*workspaceId: data\.workspaceId,\s*userId,\s*requestId: generationRequestId,[\s\S]*?tier: data\.quality,/.test(handler),
  );
  t(
    "failed spend is recorded by the spend flow, not here",
    !/recordFailedGeneration|providerUsageOf|settleGeneration/.test(quick),
  );
  t(
    "persists with the request id, inside the spend flow's deliver step (the customer pays only for a saved page)",
    handler.includes("generationRequestId,") &&
      quick.includes("generation_request_id") === false &&
      /deliver: async \(draft\) => \{\s*saved = await persistGeneratedPage\(\{\s*workspaceId: data\.workspaceId,\s*generated: draft,/.test(handler),
  );
  t(
    "a replayed persist returns the stored page (the charge the database recorded)",
    /if \(page\.replayed\) \{\s*const existing = await findPageByRequestId\(data\.workspaceId, generationRequestId\);\s*if \(existing\) \{\s*return replayResult\(/.test(handler),
  );
  t(
    "funds are held before the call, so there is no 'unbilled draft' path left",
    !quick.includes("UNBILLED_DRAFT_REASON") && !/"unbilled"/.test(quick),
  );
  t(
    "the input takes a tier through z.enum and nothing else about the model",
    quick.includes("quality: z.enum(GENERATION_TIERS).default(GENERATION_DEFAULT_TIER),") &&
      !/\bmodel:\s*z\./.test(quick),
  );
  t("quick page module says /a/, never /p/", !quick.includes("/p/") && quick.includes("/a/"));

  // Replay reports what the database settled for the request id; nothing is
  // settled or charged again.
  const replayAt = quick.indexOf("async function replayResult(");
  const replay = quick.slice(replayAt, quick.indexOf("\n}\n", replayAt) + 2);
  t("replayResult was found", replay.length > 0);
  t(
    "a replay reads the settlement recorded for its request id",
    /const spend = await readSpendSettlement\(ctx\.workspaceId, ctx\.requestId\);/.test(replay),
  );
  t(
    "a settled replay reports the settled charge, not 0 / free",
    /if \(spend\.status === "settled"\) \{\s*creditsCharged = spend\.creditsCharged;\s*billing = billingStatusFor\(\{ settled: true, billing: spend\.billing, creditsCharged \}\);/.test(
      replay,
    ),
  );
  t(
    "a replay whose call is still held or unsettled is 'pending', never 'free'",
    /else if \(spend\.status === "held" \|\| spend\.status === "called"\) \{\s*billing = "pending";/.test(replay),
  );
  t(
    "a page without a spend record owes nothing",
    /let creditsCharged = 0;\s*let billing: ItemBillingStatus = "free";/.test(replay),
  );
  t(
    "a replay settles nothing and calls nothing",
    !/runMeteredAiCall|generatePageContent|ai_settle|ai_reserve/.test(replay),
  );
  t(
    "all three replay paths (step 0, a spent id with its page, post-persist) go through replayResult",
    (handler.match(/return replayResult\(existing, \{ workspaceId: data\.workspaceId, requestId: (data\.)?generationRequestId \}\);/g) ?? [])
      .length === 3,
  );
  const server = read("src/lib/generation.server.ts");
  t(
    "findPageByRequestId selects the billing mode",
    /\.select\("id, slug, title, status, body_markdown, generation_billing_mode"\)/.test(server),
  );
  t(
    "readSpendSettlement reads the one spend row for (workspace, request id)",
    /\.from\("ai_spend_reservations"\)\s*\.select\("status, billing, credits_charged"\)\s*\.eq\("workspace_id", workspaceId\)\s*\.eq\("request_id", requestId\)/.test(server),
  );
  const persistFn = server.slice(
    server.indexOf("export async function persistGeneratedPage"),
    server.indexOf("export const DEFAULT_DAILY_CAP"),
  );
  t(
    "persistGeneratedPage records who paid on the page row",
    persistFn.includes("generation_billing_mode: input.generated.billingMode ?? null"),
  );
  t(
    "on ANY unique violation the request id is checked before the slug is retried",
    persistFn.indexOf('if (insErr.code === "23505")') > 0 &&
      persistFn.indexOf("findPageByRequestId(input.workspaceId, input.generationRequestId)") <
        persistFn.indexOf("/slug/.test(String(insErr.message ?? \"\"))") &&
      !/\/generation_request\/\.test/.test(persistFn),
  );
  t(
    "a slug collision re-derives the slug once and retries once",
    /if \(attempt === 0 && \/slug\/\.test\(String\(insErr\.message \?\? ""\)\)\) \{\s*slug = await findUniqueTenantSlug\(input\.workspaceId, baseSlug\);\s*continue;/.test(
      persistFn,
    ) && /throw new Error\(insErr\.message\);/.test(persistFn),
  );
}

console.log("\n=== coach create_city_page runs through the core ===");
{
  const coach = read("src/lib/coach-actions.functions.ts");
  const create = coach.slice(
    coach.indexOf("async function createCityPage("),
    coach.indexOf("async function addInternalLinks("),
  );
  t("createCityPage was found", create.length > 0);
  t("it calls the quick-page pipeline directly (not the server fn)", create.includes("await runQuickPage(") && !coach.includes("createQuickPage"));
  t(
    "it never calls a provider or the spend flow itself",
    !/callAI\(|AI_URL|fetch\(|runMeteredAiCall|callOpenAI/.test(create),
  );
  t("it never inserts a page row itself", !create.includes('.from("tenant_pages")'));
  t(
    "it builds the brief with buildCityBrief and keeps the dominant-category detection",
    create.includes("buildCityBrief({ city, state: state || null, categoryPlural })") &&
      /const categoryPlural = dominantCategory \|\| "listings";/.test(create) &&
      create.includes('.from("tenant_listings")'),
  );
  t(
    "it drafts, never publishes",
    /autoPublish: false,/.test(create),
  );
  t(
    "it passes a deterministic request id through the schema",
    /QuickPageInputSchema\.parse\(\{[\s\S]*?generationRequestId,\s*\}\)/.test(create),
  );
  t(
    "it never passes a model or a tier of its own (standard, the schema default)",
    !/\bmodel:|quality:/.test(create),
  );
  t(
    "an existing page for the city is a refusal via the core predicate, not a slug lookup",
    create.includes("findExistingCityPage(workspaceId, city, state || null)") &&
      !create.includes('.eq("slug"') &&
      /throw new CustomerFacingError\(\s*`A page for \$\{city\} already exists/.test(create),
  );
  const pipeline = coach.slice(
    coach.indexOf("export async function runCoachActionPipeline("),
    coach.indexOf("export const runCoachAction"),
  );
  const branch = pipeline.indexOf('if (data.actionType === "create_city_page")');
  t("the core branch comes before any key resolution", branch > 0 && branch < pipeline.indexOf("resolveAiKey("));
  t(
    "the core branch neither resolves a key nor meters by itself",
    !pipeline.slice(branch, pipeline.indexOf("resolveAiKey(")).includes("runMeteredAiCall"),
  );
  const run = coach.slice(coach.indexOf("export const runCoachAction"));
  t(
    "the server fn still writes the coach_action_log row, for success and failure alike",
    (run.match(/await logAction\(errorMessage, result\);/g) ?? []).length === 1 &&
      run.includes('from("coach_action_log")'),
  );
  t(
    "the server fn logs and throws only a customer message",
    /errorMessage = customerMessage\(e, AI_MESSAGES\.unavailable\);/.test(run) &&
      /if \(errorMessage \|\| !result\) throw new Error\(errorMessage \?\? AI_MESSAGES\.unavailable\);/.test(run),
  );
  t(
    "internal-link counting matches the /a/ links the prompt asks for",
    coach.includes("/\\]\\(\\/a\\//g") && !coach.includes("/\\]\\(\\/p\\//g"),
  );
  const cron = read("supabase/functions/coach-briefing-cron/index.ts");
  t("the briefing cron points at /a/, not /p/", cron.includes("/a/") && !cron.includes("/p/"));
}

console.log("\n=== approveOpportunity: idempotent and guarded ===");
{
  const opp = read("src/lib/opportunities.functions.ts");
  const approve = opp.slice(opp.indexOf("export async function runApproveOpportunity("), opp.indexOf("export const skipOpportunity"));
  t("approveOpportunity (its pipeline, runApproveOpportunity) was found", approve.length > 0 && /\.handler\(async \(\{ data, context \}\) => runApproveOpportunity\(data, context\.userId\)\)/.test(approve));
  t("the opportunity id is the generation request id", approve.includes("generationRequestId: opp.id,"));
  t(
    "the 'generating' transition is guarded against in-flight and finished states and reports its rows",
    /status: "generating",[\s\S]*?\.eq\("id", data\.id\)\s*\.eq\("workspace_id", data\.workspaceId\)\s*\.not\("status", "in", "\(generating,draft_ready,published\)"\)\s*\.select\("id"\)/.test(
      approve,
    ),
  );
  t(
    "zero rows matched is refused with the exact message",
    /if \(!moved \|\| moved\.length === 0\) \{\s*return \{\s*ok: false as const,\s*error: "This opportunity is already being generated or has a page\.",/.test(
      approve,
    ),
  );
  t("the guard precedes generation", approve.indexOf(".not(\"status\", \"in\"") < approve.indexOf("runQuickPage("));
  t("it calls the pipeline directly, through the schema", approve.includes("QuickPageInputSchema.parse({") && !approve.includes("createQuickPage"));
  t("it never passes a model or a tier of its own", !/\bmodel:|quality:/.test(approve));
  t("a generation failure reports only a customer message", /customerMessage\(e, GENERATION_UNAVAILABLE_MESSAGE\)/.test(approve));
}

console.log("\n=== UI copy and wiring ===");
{
  const qpb = read("src/routes/_authenticated/app.content.quick-page-builder.tsx");
  t("Quick Page Builder never shows /p/", !qpb.includes("/p/"));
  t("Quick Page Builder shows the /a/ live prefix", qpb.includes("/a/"));
  t(
    "Quick Page Builder takes its default tier from the server and sends a tier, never a model id",
    qpb.includes("defaultTier") && /quality[,:]/.test(qpb) && !/useState\("google\/gemini/.test(qpb) && !/\bmodel:\s/.test(qpb) && !/gpt-5/.test(qpb),
  );
  t(
    "Quick Page Builder sends an idempotency key",
    qpb.includes("generationRequestId: requestIdRef.current"),
  );
  t(
    "the idempotency key rotates only after a response",
    qpb.indexOf("requestIdRef.current = newRequestId()") > qpb.indexOf("await create("),
  );
  // A key buys at most one provider call, so a request the server answered
  // (even with an error) is finished: the next click needs a fresh key.
  // A lost response (fetch TypeError) and "still being generated" keep it.
  t(
    "a server-answered failure rotates the key; a lost response or 'still being generated' keeps it",
    /\} catch \(err: any\) \{[\s\S]*?if \(!\(err instanceof TypeError\) && !\/still being generated\/i\.test\(message\)\) \{\s*requestIdRef\.current = newRequestId\(\);\s*\}/.test(
      qpb,
    ) && /still being generated/i.test(GENERATION_IN_PROGRESS_MESSAGE),
  );
  t("the preview link is /s/{workspace}/{slug}", qpb.includes("`/s/${ws.slug}/${result.slug}`"));
  const genUi = read("src/routes/_authenticated/app.content.generate.tsx");
  t(
    "Stop after this one cancels the job server-side",
    genUi.includes("cancelGenerationJob") && /onClick=\{stop\}/.test(genUi),
  );
  t("Generate Content copy has no /p/", !genUi.includes("/p/"));
  t("given-up cities cannot be selected", genUi.includes("!t.attemptsExhausted"));
  t(
    "Generate Content sends a tier, never a model id",
    /quality[,:]/.test(genUi) && !/\bmodel:\s/.test(genUi) && !/gpt-5|gemini/.test(genUi),
  );
}

console.log("\n=== migration text (000300) ===");
{
  const sql = read("supabase/migrations/20260923000300_generation_jobs.sql");
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
    "items carry billing_status defaulting to pending",
    /billing_status text NOT NULL DEFAULT 'pending'/.test(sql),
  );
  t(
    "billing_status is constrained to the four honest states",
    /CHECK \(billing_status IN \('pending','charged','free','unbilled'\)\)/.test(sql),
  );
  t(
    "tenant_pages gains generation_request_id",
    /ALTER TABLE public\.tenant_pages ADD COLUMN IF NOT EXISTS generation_request_id uuid/.test(
      sql,
    ),
  );
  t(
    "generation_request_id is unique per workspace (partial index)",
    /CREATE UNIQUE INDEX IF NOT EXISTS tenant_pages_generation_request_uidx\s+ON public\.tenant_pages\(workspace_id, generation_request_id\)\s+WHERE generation_request_id IS NOT NULL/.test(
      sql,
    ),
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
    "verification covers billing_status and the request id",
    sql.includes("'items carry billing_status'") &&
      sql.includes("'tenant_pages.generation_request_id present'") &&
      sql.includes("'generation request id unique per workspace'"),
  );
  t(
    "ends with the verification block",
    /SELECT 'generation_jobs' AS check,[\s\S]*UNION ALL SELECT 'RLS enabled on all 3 new tables'/.test(
      sql,
    ),
  );
}

console.log("\n=== migration text (000600: settlement + reservations) ===");
{
  const sql = read(MIGRATION_600);
  t(
    "the settlement index is partial over the two generation ref types with a non-null ref id",
    /CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_generation_settlement_uidx\s+ON public\.credit_ledger \(workspace_id, ref_id\)\s+WHERE reason = 'ai_usage'\s+AND ref_type IN \('batch_generation','quick_page'\)\s+AND ref_id IS NOT NULL;/.test(
      sql,
    ),
  );
  t(
    "the index predicate never covers coach-chat (ref_type 'coach') or ai-proxy (ref_id NULL)",
    !/ref_type IN \([^)]*'coach'/.test(sql) && /ref_id IS NOT NULL/.test(sql),
  );

  const settleFn = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.settle_generation_free_quota"),
    sql.indexOf("REVOKE EXECUTE ON FUNCTION public.settle_generation_free_quota"),
  );
  t("settle_generation_free_quota was found", settleFn.length > 0);
  t(
    "its signature is (workspace uuid, ref_type text, ref_id text, ai_model text default null) returning int",
    /public\.settle_generation_free_quota\(\s*_workspace_id uuid,\s*_ref_type text,\s*_ref_id text,\s*_ai_model text DEFAULT NULL\s*\)\s*RETURNS int/.test(
      settleFn,
    ),
  );
  t(
    "it is SECURITY DEFINER with a pinned search_path",
    /LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = public/.test(settleFn),
  );
  t(
    "it carries the same membership guard as consume_platform_ai_credit",
    settleFn.includes(
      "IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN",
    ) && settleFn.includes("RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'"),
  );
  t(
    "it refuses a ref_type outside the two generation features and a NULL ref_id (22023)",
    /_ref_type NOT IN \('batch_generation','quick_page'\)/.test(settleFn) &&
      /IF _ref_id IS NULL THEN/.test(settleFn) &&
      (settleFn.match(/USING ERRCODE = '22023'/g) ?? []).length === 2,
  );
  const ledgerInsert = settleFn.indexOf("INSERT INTO public.credit_ledger");
  const quotaUpdate = settleFn.indexOf("UPDATE public.workspace_ai_quota");
  const quotaSeed = settleFn.indexOf("INSERT INTO public.workspace_ai_quota");
  t(
    "the ledger row is inserted BEFORE the quota is seeded or decremented",
    ledgerInsert > 0 && ledgerInsert < quotaSeed && quotaSeed < quotaUpdate,
  );
  t(
    "the ledger row is delta 0, reason ai_usage, with the model, ref and free-quota metadata",
    /VALUES \(\s*_workspace_id, 0, 'ai_usage', _ai_model, _ref_type, _ref_id,\s*jsonb_build_object\('provider', 'platform', 'billing', 'free_quota', 'feature', _ref_type\)\s*\)/.test(
      settleFn,
    ),
  );
  t(
    "the quota decrement is the consume_platform_ai_credit one",
    settleFn.includes("SET platform_credits_remaining = platform_credits_remaining - 1,") &&
      settleFn.includes("lifetime_platform_used = lifetime_platform_used + 1") &&
      settleFn.includes("AND platform_credits_remaining > 0") &&
      settleFn.includes("RETURNING platform_credits_remaining INTO v_remaining"),
  );
  t(
    "an exhausted quota raises platform_ai_quota_exhausted (P0001), rolling the ledger row back",
    /IF v_remaining IS NULL THEN[\s\S]*?RAISE EXCEPTION 'platform_ai_quota_exhausted' USING ERRCODE = 'P0001';/.test(
      settleFn,
    ) && settleFn.includes("RETURN v_remaining;"),
  );
  t(
    "settle_generation_free_quota is service-role only",
    sql.includes(
      "REVOKE EXECUTE ON FUNCTION public.settle_generation_free_quota(uuid, text, text, text) FROM PUBLIC, anon, authenticated;",
    ) &&
      sql.includes(
        "GRANT EXECUTE ON FUNCTION public.settle_generation_free_quota(uuid, text, text, text) TO service_role;",
      ),
  );

  t(
    "generation_reservations: (workspace_id, request_id) primary key, cascade on workspace delete",
    /CREATE TABLE IF NOT EXISTS public\.generation_reservations \(\s*workspace_id uuid NOT NULL REFERENCES public\.workspaces\(id\) ON DELETE CASCADE,\s*request_id uuid NOT NULL,\s*created_at timestamptz NOT NULL DEFAULT now\(\),\s*PRIMARY KEY \(workspace_id, request_id\)\s*\);/.test(
      sql,
    ),
  );
  t(
    "generation_reservations: indexed by workspace and recency",
    /CREATE INDEX IF NOT EXISTS generation_reservations_ws_created_idx\s+ON public\.generation_reservations \(workspace_id, created_at DESC\);/.test(
      sql,
    ),
  );
  t(
    "generation_reservations: RLS on, no policies, anon and authenticated revoked",
    sql.includes("ALTER TABLE public.generation_reservations ENABLE ROW LEVEL SECURITY;") &&
      sql.includes("REVOKE ALL ON public.generation_reservations FROM anon, authenticated;") &&
      !/CREATE POLICY[^;]*ON public\.generation_reservations/.test(sql),
  );

  const consumedFn = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.generation_consumed_last_24h"),
    sql.indexOf("REVOKE EXECUTE ON FUNCTION public.generation_consumed_last_24h"),
  );
  t(
    "generation_consumed_last_24h is SQL, STABLE, SECURITY DEFINER with a pinned search_path",
    /\(\s*_workspace_id uuid\s*\)\s*RETURNS int\s+LANGUAGE sql\s+STABLE\s+SECURITY DEFINER\s+SET search_path = public/.test(
      consumedFn,
    ),
  );
  t(
    "generation_consumed_last_24h is service-role only",
    sql.includes(
      "REVOKE EXECUTE ON FUNCTION public.generation_consumed_last_24h(uuid) FROM PUBLIC, anon, authenticated;",
    ) &&
      sql.includes(
        "GRANT EXECUTE ON FUNCTION public.generation_consumed_last_24h(uuid) TO service_role;",
      ),
  );
  t(
    "the earlier (uuid, uuid) signature is dropped before the new one is created (no ambiguous overload on a re-run)",
    sql.indexOf("DROP FUNCTION IF EXISTS public.generation_consumed_last_24h(uuid, uuid);") > 0 &&
      sql.indexOf("DROP FUNCTION IF EXISTS public.generation_consumed_last_24h(uuid, uuid);") <
        sql.indexOf("CREATE OR REPLACE FUNCTION public.generation_consumed_last_24h"),
  );
  t(
    "generation_reservations gains provider_called_at (idempotent) — NULL until the provider is called",
    sql.includes(
      "ALTER TABLE public.generation_reservations ADD COLUMN IF NOT EXISTS provider_called_at timestamptz;",
    ),
  );

  const reserveFn = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.reserve_generation_slot"),
    sql.indexOf("REVOKE EXECUTE ON FUNCTION public.reserve_generation_slot"),
  );
  t(
    "reserve_generation_slot is (workspace uuid, request uuid, cap int) returning text, plpgsql SECURITY DEFINER",
    /\(\s*_workspace_id uuid,\s*_request_id uuid,\s*_cap int\s*\)\s*RETURNS text\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = public/.test(
      reserveFn,
    ),
  );
  t(
    "the boolean version is dropped first (CREATE OR REPLACE cannot change a return type)",
    sql.indexOf("DROP FUNCTION IF EXISTS public.reserve_generation_slot(uuid, uuid, int);") > 0 &&
      sql.indexOf("DROP FUNCTION IF EXISTS public.reserve_generation_slot(uuid, uuid, int);") <
        sql.indexOf("CREATE OR REPLACE FUNCTION public.reserve_generation_slot"),
  );
  const lockAt = reserveFn.indexOf(
    "PERFORM pg_advisory_xact_lock(hashtext('generation_cap:' || _workspace_id::text));",
  );
  const pageAt = reserveFn.indexOf("AND p.generation_request_id = _request_id");
  const rowAt = reserveFn.indexOf("FROM public.generation_reservations r");
  const countAt = reserveFn.indexOf("v_consumed := public.generation_consumed_last_24h(_workspace_id);");
  const insertAt = reserveFn.indexOf("INSERT INTO public.generation_reservations (workspace_id, request_id)");
  t(
    "it takes the per-workspace advisory lock first, then looks for a page, then for its own row, then counts, then inserts",
    lockAt > 0 && lockAt < pageAt && pageAt < rowAt && rowAt < countAt && countAt < insertAt,
    `${lockAt} ${pageAt} ${rowAt} ${countAt} ${insertAt}`,
  );
  t(
    "a page carrying the id is 'consumed' (the work is done)",
    /AND p\.generation_request_id = _request_id\) THEN\s+RETURN 'consumed';/.test(reserveFn),
  );
  t(
    "an existing row never hands out a second slot: young → 'in_progress', spent → 'consumed' (the old replay shortcut returned true)",
    /IF FOUND THEN\s+IF v_created_at > now\(\) - interval '15 minutes' THEN\s+RETURN 'in_progress';\s+END IF;\s+IF v_provider_called_at IS NOT NULL THEN\s+RETURN 'consumed';/.test(
      reserveFn,
    ) && !/RETURN true;/.test(reserveFn),
  );
  t(
    "only a stale row whose provider was never called is retaken, against the cap, with a fresh created_at",
    /SET created_at = now\(\)/.test(reserveFn) &&
      /- CASE WHEN v_created_at >= now\(\) - interval '24 hours' THEN 1 ELSE 0 END;/.test(reserveFn),
  );
  t(
    "the cap comparison never goes negative and refuses at the cap",
    (reserveFn.match(/IF v_consumed >= GREATEST\(COALESCE\(_cap, 0\), 0\) THEN\s+RETURN 'cap_reached';/g) ?? []).length === 2,
  );
  const markFn = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.mark_generation_provider_called"),
    sql.indexOf("REVOKE EXECUTE ON FUNCTION public.mark_generation_provider_called"),
  );
  t(
    "mark_generation_provider_called(uuid, uuid) returns boolean, SECURITY DEFINER, membership-guarded",
    /\(\s*_workspace_id uuid,\s*_request_id uuid\s*\)\s*RETURNS boolean\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = public/.test(
      markFn,
    ) && markFn.includes("IF auth.uid() IS NOT NULL AND NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN"),
  );
  t(
    "marking flips provider_called_at from NULL only, once (true only for the call that flipped it)",
    /SET provider_called_at = now\(\)[\s\S]*?AND provider_called_at IS NULL;\s*GET DIAGNOSTICS v_marked = ROW_COUNT;\s*RETURN v_marked = 1;/.test(
      markFn,
    ),
  );
  const releaseFn = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.release_generation_slot"),
    sql.indexOf("REVOKE EXECUTE ON FUNCTION public.release_generation_slot"),
  );
  t(
    "release_generation_slot(uuid, uuid) deletes a row ONLY while provider_called_at is NULL",
    /\(\s*_workspace_id uuid,\s*_request_id uuid\s*\)\s*RETURNS boolean\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = public/.test(
      releaseFn,
    ) &&
      /DELETE FROM public\.generation_reservations\s+WHERE workspace_id = _workspace_id\s+AND request_id = _request_id\s+AND provider_called_at IS NULL;/.test(
        releaseFn,
      ),
  );
  for (const sig of [
    "mark_generation_provider_called(uuid, uuid)",
    "release_generation_slot(uuid, uuid)",
    "tenant_pages_pin_generation_columns()",
  ]) {
    t(
      `${sig} is service-role only`,
      sql.includes(`REVOKE EXECUTE ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`) &&
        sql.includes(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`),
    );
  }
  const pinFn = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.tenant_pages_pin_generation_columns"),
    sql.indexOf("REVOKE EXECUTE ON FUNCTION public.tenant_pages_pin_generation_columns"),
  );
  t(
    "the pin trigger function keeps OLD created_at, generation_request_id and generation_billing_mode unless the caller is the service role",
    /RETURNS trigger\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = public/.test(pinFn) &&
      /IF auth\.role\(\) IS DISTINCT FROM 'service_role' THEN\s+NEW\.created_at := OLD\.created_at;\s+NEW\.generation_request_id := OLD\.generation_request_id;\s+NEW\.generation_billing_mode := OLD\.generation_billing_mode;\s+END IF;\s+RETURN NEW;/.test(
        pinFn,
      ),
  );
  t(
    "the pin trigger is BEFORE UPDATE on tenant_pages, re-creatable",
    /DROP TRIGGER IF EXISTS tenant_pages_pin_generation_columns ON public\.tenant_pages;\s*CREATE TRIGGER tenant_pages_pin_generation_columns\s+BEFORE UPDATE ON public\.tenant_pages\s+FOR EACH ROW EXECUTE FUNCTION public\.tenant_pages_pin_generation_columns\(\);/.test(
      sql,
    ),
  );
  t(
    "every function in 000600 is SECURITY DEFINER with a pinned search_path",
    (sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length === 6 &&
      (sql.match(/SECURITY DEFINER\s+SET search_path = public/g) ?? []).length === 6,
  );
  t(
    "reserve_generation_slot is service-role only",
    sql.includes(
      "REVOKE EXECUTE ON FUNCTION public.reserve_generation_slot(uuid, uuid, int) FROM PUBLIC, anon, authenticated;",
    ) &&
      sql.includes(
        "GRANT EXECUTE ON FUNCTION public.reserve_generation_slot(uuid, uuid, int) TO service_role;",
      ),
  );

  t(
    "tenant_pages gains a nullable generation_billing_mode",
    /ALTER TABLE public\.tenant_pages ADD COLUMN IF NOT EXISTS generation_billing_mode text;/.test(sql),
  );
  t(
    "generation_billing_mode is constrained to byok / granted / platform (guarded, idempotent)",
    /IF NOT EXISTS \(SELECT 1 FROM pg_constraint\s+WHERE conname = 'tenant_pages_generation_billing_mode_check'\)/.test(sql) &&
      /CHECK \(generation_billing_mode IN \('byok','granted','platform'\)\)/.test(sql),
  );
  t(
    "verification covers the index, the ordering inside the settle function, the lock, the source, the state machine, the grants, the column and the pin trigger",
    [
      "'settlement index present with the generation predicate'",
      "'settle_generation_free_quota: service_role only'",
      "'settle_generation_free_quota: membership guard present'",
      "'settle_generation_free_quota: ledger row inserted before the quota update'",
      "'generation_reservations: RLS on, no policies'",
      "'generation_reservations.provider_called_at present'",
      "'generation_consumed_last_24h: service_role only'",
      "'generation_consumed_last_24h: counts reservations only, never pages or items'",
      "'generation_consumed_last_24h: the old (uuid, uuid) overload is gone'",
      "'reserve_generation_slot: service_role only'",
      "'reserve_generation_slot: returns text (reserved / cap_reached / in_progress / consumed)'",
      "'reserve_generation_slot: takes the per-workspace advisory lock before counting'",
      "'mark_generation_provider_called: service_role only'",
      "'release_generation_slot: service_role only'",
      "'release_generation_slot: frees only a row whose provider was never called'",
      "'tenant_pages.generation_billing_mode present'",
      "'tenant_pages.generation_billing_mode constrained to byok / granted / platform'",
      "'tenant_pages_pin_generation_columns: service_role only'",
      "'tenant_pages_pin_generation_columns: BEFORE UPDATE trigger on tenant_pages'",
    ].every((s) => sql.includes(s)),
  );
  t(
    "ends with the verification block",
    /SELECT 'settlement index present with the generation predicate' AS check,[\s\S]*UNION ALL SELECT 'tenant_pages\.generation_billing_mode constrained/.test(
      sql,
    ) && sql.trimEnd().endsWith(";"),
  );
}

console.log("\n=== rollback text ===");
{
  const sql = read("supabase/rollback/20260923000300_generation_jobs_rollback.sql");
  t(
    "drops generation_items and generation_jobs",
    sql.includes("DROP TABLE IF EXISTS public.generation_items") &&
      sql.includes("DROP TABLE IF EXISTS public.generation_jobs"),
  );
  t(
    "drops the request-id unique index",
    sql.includes("DROP INDEX IF EXISTS public.tenant_pages_generation_request_uidx"),
  );
  t(
    "drops the tenant_pages column",
    sql.includes("ALTER TABLE public.tenant_pages DROP COLUMN IF EXISTS generation_request_id"),
  );
  t("verifies the column is gone", /column_name='generation_request_id'/.test(sql));
  t("never drops tenant_pages", !/DROP TABLE[^;]*tenant_pages/.test(sql));

  const rb = read(ROLLBACK_600);
  t(
    "000600 rollback drops the two RPCs and the count function by full signature",
    rb.includes("DROP FUNCTION IF EXISTS public.reserve_generation_slot(uuid, uuid, int);") &&
      rb.includes("DROP FUNCTION IF EXISTS public.generation_consumed_last_24h(uuid, uuid);") &&
      rb.includes("DROP FUNCTION IF EXISTS public.settle_generation_free_quota(uuid, text, text, text);"),
  );
  t(
    "000600 rollback drops the reservations table, the settlement index and the column",
    rb.includes("DROP TABLE IF EXISTS public.generation_reservations;") &&
      rb.includes("DROP INDEX IF EXISTS public.credit_ledger_generation_settlement_uidx;") &&
      rb.includes("ALTER TABLE public.tenant_pages DROP COLUMN IF EXISTS generation_billing_mode;"),
  );
  t(
    "000600 rollback drops the new RPCs, the one-argument count and the pin trigger by full signature",
    rb.includes("DROP FUNCTION IF EXISTS public.mark_generation_provider_called(uuid, uuid);") &&
      rb.includes("DROP FUNCTION IF EXISTS public.release_generation_slot(uuid, uuid);") &&
      rb.includes("DROP FUNCTION IF EXISTS public.generation_consumed_last_24h(uuid);") &&
      rb.includes("DROP TRIGGER IF EXISTS tenant_pages_pin_generation_columns ON public.tenant_pages;") &&
      rb.includes("DROP FUNCTION IF EXISTS public.tenant_pages_pin_generation_columns();"),
  );
  t(
    "000600 rollback drops the pin trigger BEFORE the billing-mode column it reads",
    rb.indexOf("DROP TRIGGER IF EXISTS tenant_pages_pin_generation_columns") <
      rb.indexOf("ALTER TABLE public.tenant_pages DROP COLUMN IF EXISTS generation_billing_mode;"),
  );
  t("000600 rollback says it must be paired with a code rollback", /PAIR THIS WITH A CODE ROLLBACK/.test(rb));
  t(
    "000600 rollback says it forgets free-quota settlement records (a retry could re-settle)",
    /forgets: free-quota settlement records/.test(rb) && /settle a free-quota page a second time/.test(rb),
  );
  t("000600 rollback never drops tenant_pages or credit_ledger", !/DROP TABLE[^;]*(tenant_pages|credit_ledger)/.test(rb));
  t(
    "000600 rollback ends with a VERIFY query over functions, table, index and column",
    /-- VERIFY \(rolled back\): expect 0 rows/.test(rb) &&
      rb.indexOf("-- VERIFY") > rb.indexOf("COMMIT;") &&
      /table_name='generation_reservations'/.test(rb) &&
      /indexname='credit_ledger_generation_settlement_uidx'/.test(rb) &&
      /column_name='generation_billing_mode'/.test(rb) &&
      /'settle_generation_free_quota','reserve_generation_slot','generation_consumed_last_24h'/.test(rb) &&
      /'mark_generation_provider_called','release_generation_slot'/.test(rb) &&
      /tgname = 'tenant_pages_pin_generation_columns'/.test(rb),
  );
  const readme = read("supabase/rollback/README.md");
  t("rollback README lists 000600 in the apply order", /000500 → 000600/.test(readme));
  t(
    "rollback README verifies 000600 (index, grants, table, columns, trigger)",
    readme.includes("-- 000600:") &&
      readme.includes("credit_ledger_generation_settlement_uidx") &&
      readme.includes("'public.settle_generation_free_quota(uuid,text,text,text)'") &&
      readme.includes("'public.reserve_generation_slot(uuid,uuid,int)'") &&
      readme.includes("'public.mark_generation_provider_called(uuid,uuid)'") &&
      readme.includes("'public.release_generation_slot(uuid,uuid)'") &&
      readme.includes("'public.generation_consumed_last_24h(uuid)'") &&
      readme.includes("'public.tenant_pages_pin_generation_columns()'") &&
      readme.includes("public.generation_reservations") &&
      readme.includes("column_name='provider_called_at'") &&
      readme.includes("column_name='generation_billing_mode'") &&
      readme.includes("tgname = 'tenant_pages_pin_generation_columns'"),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}
