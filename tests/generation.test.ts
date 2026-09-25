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
 *   - the platform key must afford a WHOLE page; settlement is idempotent by
 *     page through the credit ledger whichever currency paid; a failed
 *     deduction is recorded as unbilled, never as a charge; a provider that
 *     omits usage is billed as a typical page, never as a free one
 *   - pre-claim item writes are fenced on the state the driver read, so a
 *     refusal from one driver cannot void another's live claim
 *   - the quick page accepts only picker models, defaults to the cheap one,
 *     carries an idempotency key and settles a replayed platform page
 *   - the coach's create_city_page runs through the core (pause, cap, who
 *     pays, settlement, deterministic request id), never the gateway
 *   - the OpenRouter caller times out (even mid-body), rejects what must be
 *     rejected, and never lets a provider body reach the customer; no
 *     database text reaches the customer either (customerMessage)
 *   - out-of-funds copy sends customers to support, not to a withdrawn purchase
 *   - the migrations carry the idempotency keys, billing_status, the pause
 *     seed, the write REVOKEs, the settlement index, the reservation state
 *     machine (reserve / mark / release), the billing-mode column and the
 *     pin trigger; the rollbacks undo them (tests/generation-sql.test.ts runs
 *     the 000600 SQL itself in PGlite)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ATTEMPTS_EXHAUSTED_MESSAGE,
  CustomerFacingError,
  GENERATION_ALREADY_USED_MESSAGE,
  GENERATION_DEFAULT_MODEL,
  GENERATION_IN_PROGRESS_MESSAGE,
  GENERATION_LEDGER_REF_TYPES,
  GENERATION_MODEL_IDS,
  GENERATION_MODEL_OPTIONS,
  GENERATION_PAUSED_MESSAGE,
  GENERATION_UNAVAILABLE_MESSAGE,
  MAX_ITEM_ATTEMPTS,
  MIN_BODY_CHARS,
  OPENROUTER_TIMEOUT_MS,
  PAGE_SLUG_UNDERIVABLE_MESSAGE,
  PAGE_TITLE_INVALID_MESSAGE,
  PROVIDER_ERROR_MESSAGE,
  PROVIDER_TIMEOUT_MESSAGE,
  STALE_RUNNING_MS,
  TYPICAL_PAGE_TOKENS,
  UNBILLED_ITEM_MESSAGE,
  attemptsExhausted,
  batchAttemptRequestId,
  billableUsage,
  billingStatusFor,
  buildCityBrief,
  buildTargetKey,
  callOpenRouterWritePage,
  customerMessage,
  dailyCapRemaining,
  deterministicRequestId,
  estimatedCreditsPerPage,
  formatInventoryFacts,
  generatedPageBaseSlug,
  hasPlatformFunds,
  initialBillingStatus,
  isGenerationPaused,
  isSettlementConflict,
  isStaleRunning,
  outOfCreditsMessage,
  pageCoversCity,
  parseGenerationSlot,
  planJobItems,
  providerUsageOf,
  selectTargets,
  validatePageRequest,
} from "../src/lib/generation.server";
import { PLATFORM_MODEL_ALLOWLIST, resolvePlatformModel } from "../src/lib/ai-pricing";
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
    OPENROUTER_TIMEOUT_MS < STALE_RUNNING_MS,
    `${OPENROUTER_TIMEOUT_MS} vs ${STALE_RUNNING_MS}`,
  );
  t("the provider timeout is 120 seconds", OPENROUTER_TIMEOUT_MS === 120_000);
}

console.log("\n=== platform funds: a page must be affordable, not just balance > 0 ===");
{
  const pro = "google/gemini-3.1-pro-preview";
  const perPage = estimatedCreditsPerPage(pro);
  t("a Pro page is estimated at more than one credit", perPage > 1, String(perPage));
  t(
    "free quota left → available regardless of balance",
    hasPlatformFunds({ freeQuotaRemaining: 1, balance: 0, model: pro }),
  );
  t(
    "no quota row yet → available (the RPC seeds the free allowance)",
    hasPlatformFunds({ freeQuotaRemaining: null, balance: 0, model: pro }),
  );
  t(
    "quota exhausted + balance 1 → NOT available (the old > 0 bug)",
    !hasPlatformFunds({ freeQuotaRemaining: 0, balance: 1, model: pro }),
  );
  t(
    "quota exhausted + balance one short of a page → not available",
    !hasPlatformFunds({ freeQuotaRemaining: 0, balance: perPage - 1, model: pro }),
  );
  t(
    "quota exhausted + balance exactly a page → available",
    hasPlatformFunds({ freeQuotaRemaining: 0, balance: perPage, model: pro }),
  );
  t(
    "the bar depends on the model (cheaper model, lower bar)",
    estimatedCreditsPerPage(GENERATION_DEFAULT_MODEL) < perPage &&
      hasPlatformFunds({
        freeQuotaRemaining: 0,
        balance: estimatedCreditsPerPage(GENERATION_DEFAULT_MODEL),
        model: GENERATION_DEFAULT_MODEL,
      }),
  );
  t(
    "null balance reads as 0",
    !hasPlatformFunds({ freeQuotaRemaining: 0, balance: null, model: pro }),
  );
}

console.log("\n=== settlement → billing_status ===");
{
  t("byok → free", billingStatusFor("byok", 0) === "free");
  t("beta grant → free", billingStatusFor("granted", 0) === "free");
  t("free platform quota → free", billingStatusFor("free_quota", 0) === "free");
  t("credits actually deducted → charged", billingStatusFor("credits", 3) === "charged");
  t("credits path with nothing owed → free", billingStatusFor("credits", 0) === "free");
  t("a failed deduction → unbilled, never charged", billingStatusFor("unbilled", 0) === "unbilled");
  t("before settling, a platform page is pending", initialBillingStatus("platform") === "pending");
  t("before settling, a BYOK page owes nothing", initialBillingStatus("byok") === "free");
  t("before settling, a granted page owes nothing", initialBillingStatus("granted") === "free");
  const server = read("src/lib/generation.server.ts");
  // settleOnPlatform is the platform branch; settleGeneration wraps it.
  const settle = server.slice(server.indexOf("async function settleOnPlatform("));
  const platform = server.slice(
    server.indexOf("async function settleOnPlatform("),
    server.indexOf("export async function settleGeneration"),
  );
  t("the platform branch was found", platform.length > 0);
  t(
    "settleGeneration zeroes creditsCharged on any failure",
    /billing = "unbilled";\s*creditsCharged = 0;/.test(settle),
  );
  t("an unbilled settlement is logged loudly", settle.includes("UNBILLED generation"));
  t(
    "a beta grant skips platform metering entirely",
    settle.includes('if (mode === "platform")') &&
      server.includes('ent.billingState === "granted"'),
  );

  // Settlement is idempotent by PAGE against the credit ledger: the ledger
  // row is the settlement record, one per page, whichever currency paid.
  // A run that died after settling but before recording it on the item must
  // not settle again on the retry — in either currency.
  const ledgerCheck = platform.indexOf("findLedgerCharge(p.workspaceId, p.refId)");
  t("the platform branch consults the ledger for this page first", ledgerCheck > 0);
  t(
    "the ledger check precedes the free-quota settlement",
    ledgerCheck < platform.indexOf('rpc("settle_generation_free_quota"'),
  );
  t(
    "the ledger check precedes the deduction",
    ledgerCheck < platform.indexOf('rpc("deduct_credits"'),
  );
  t(
    "a prior ledger row is reported as the settlement, whichever currency paid",
    /if \(prior\) return \{ ok: true, billing: prior\.billing, creditsCharged: prior\.amount \};/.test(
      platform,
    ),
  );
  t(
    "the free quota is settled through settle_generation_free_quota keyed by feature + page id + model",
    /rpc\("settle_generation_free_quota", \{\s*_workspace_id: p\.workspaceId,\s*_ref_type: p\.feature,\s*_ref_id: p\.refId,\s*_ai_model: p\.model,\s*\}\)/.test(
      platform,
    ),
  );
  t(
    "losing the settlement index re-reads the ledger and adopts the winner (free quota)",
    /if \(isSettlementConflict\(qErr\)\) return adopt\("settle_generation_free_quota"\);/.test(
      platform,
    ),
  );
  t(
    "losing the settlement index re-reads the ledger and adopts the winner (credits)",
    /if \(p\.refId && isSettlementConflict\(error\)\) return adopt\("deduct_credits"\);/.test(
      platform,
    ),
  );
  t(
    "a conflict with no ledger row is a failure (unbilled), never a charge",
    /settlement conflict but no ledger row for this page/.test(platform),
  );
  t(
    "an exhausted free quota falls through to purchased credits",
    /if \(quotaExhausted\(qErr\)\) return deduct\(\);/.test(platform),
  );
  t(
    "the deduction carries the page id as the ledger ref",
    /_ref_type: p\.feature,\s*_ref_id: p\.refId \?\? undefined,/.test(platform),
  );
  t(
    "without a page id the old unkeyed consume path is kept (nothing else regresses)",
    platform.indexOf('rpc("consume_platform_ai_credit"') > platform.indexOf("if (p.refId) {") &&
      /both always pass the page\s*\*?\s*id/.test(server),
  );
  t(
    "the invariant is written down: one ledger row per page, whichever currency paid",
    /one per page, whichever currency paid/.test(server),
  );

  const ledgerFn = server.slice(
    server.indexOf("export async function findLedgerCharge"),
    server.indexOf("const quotaExhausted"),
  );
  t(
    "the ledger lookup is keyed by workspace, page id, the ai_usage reason and the two generation ref types",
    ledgerFn.includes('.eq("workspace_id", workspaceId)') &&
      ledgerFn.includes('.eq("ref_id", refId)') &&
      ledgerFn.includes('.eq("reason", "ai_usage")') &&
      ledgerFn.includes('.in("ref_type", [...GENERATION_LEDGER_REF_TYPES])') &&
      [...GENERATION_LEDGER_REF_TYPES].sort().join() === "batch_generation,quick_page",
  );
  t(
    "the ledger lookup sees free-quota rows (delta 0) as well as deductions (delta < 0)",
    ledgerFn.includes('.lte("delta", 0)') && !ledgerFn.includes('.lt("delta", 0)'),
  );
  t(
    "delta < 0 reads as credits, delta 0 as free_quota, amount is the absolute delta",
    /billing: delta < 0 \? "credits" : "free_quota", amount: Math\.abs\(delta\)/.test(ledgerFn),
  );
  t(
    "a ledger read failure throws instead of deducting blind",
    /if \(error\) throw new Error\(`credit ledger read failed/.test(ledgerFn),
  );
  const fns = read("src/lib/generation.functions.ts");
  t(
    "batch settlement passes the page id as the ledger key",
    (fns.match(/feature: "batch_generation",\s*refId: (page\.id|row\.page_id),/g) ?? []).length ===
      2,
  );
  t(
    "quick page settlement passes the page id as the ledger key",
    /feature: "quick_page",\s*refId: page\.id,/.test(read("src/lib/admin-quick-page.functions.ts")),
  );

  // Settlement conflict detection (pure).
  t("unique_violation code is a conflict", isSettlementConflict({ code: "23505", message: "dup" }));
  t(
    "the settlement index named in the message is a conflict even without a code",
    isSettlementConflict({
      message:
        'duplicate key value violates unique constraint "credit_ledger_generation_settlement_uidx"',
    }),
  );
  t(
    "an exhausted quota is not a conflict",
    !isSettlementConflict({ code: "P0001", message: "platform_ai_quota_exhausted" }),
  );
  t("nothing is not a conflict", !isSettlementConflict(null) && !isSettlementConflict(undefined));
  t(
    "a different unique index is not a settlement conflict by name (only by code)",
    !isSettlementConflict({ message: 'violates unique constraint "tenant_pages_workspace_id_slug_key"' }),
  );

  // Usage fallback (pure): a provider that omits usage is billed as a
  // typical page, never as a free one.
  const assumed = billableUsage(0, 0);
  t(
    "zero usage bills a typical page",
    assumed.promptTokens === TYPICAL_PAGE_TOKENS.prompt &&
      assumed.completionTokens === TYPICAL_PAGE_TOKENS.completion &&
      assumed.assumed,
  );
  const real = billableUsage(812, 1204);
  t(
    "real usage is billed as reported",
    real.promptTokens === 812 && real.completionTokens === 1204 && !real.assumed,
  );
  t(
    "garbage usage (NaN, negative) is treated as omitted",
    billableUsage(Number.NaN, -5).assumed && billableUsage(Number.NaN, -5).promptTokens > 0,
  );
  const partial = billableUsage(5, 0);
  t(
    "partial usage is real usage, not omitted",
    partial.promptTokens === 5 && partial.completionTokens === 0 && !partial.assumed,
  );
  t(
    "settleGeneration applies the fallback in one place and warns, naming feature and refId",
    /const usage = billableUsage\(opts\.promptTokens, opts\.completionTokens\);/.test(settle) &&
      /provider omitted usage; billing a typical page feature=\$\{opts\.feature\} refId=/.test(
        settle,
      ),
  );
  t(
    "the deduction is priced on the billable usage",
    /creditsForUsage\(p\.model, p\.usage\.promptTokens, p\.usage\.completionTokens\)/.test(platform),
  );
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
  t(
    "GENERATION_MODEL_IDS is exactly the picker",
    GENERATION_MODEL_IDS.join() === GENERATION_MODEL_OPTIONS.map((m) => m.id).join(),
  );
  t(
    "the default model is offered by the picker",
    GENERATION_MODEL_IDS.includes(GENERATION_DEFAULT_MODEL),
  );

  const base = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    title: "Boats in Austin",
    topic: "City hub page for boats in Austin, Texas",
  };
  const parsed = QuickPageInputSchema.safeParse(base);
  t(
    "quick page defaults to the cheap batch default model",
    parsed.success && parsed.data.model === GENERATION_DEFAULT_MODEL,
  );
  t(
    "quick page rejects an unknown model instead of upgrading it",
    !QuickPageInputSchema.safeParse({ ...base, model: "openai/gpt-5" }).success,
  );
  t(
    "quick page rejects an off-picker gemini id",
    !QuickPageInputSchema.safeParse({ ...base, model: "google/gemini-2.5-flash" }).success,
  );
  t(
    "quick page accepts every picker model",
    GENERATION_MODEL_IDS.every(
      (id) => QuickPageInputSchema.safeParse({ ...base, model: id }).success,
    ),
  );
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
  t(
    "the refusals a customer reads are thrown as CustomerFacingError (key, funds, slug, provider, thin output)",
    /throw new CustomerFacingError\(\s*"Page generation is not available right now/.test(server) &&
      server.includes("throw new CustomerFacingError(outOfCreditsMessage(model))") &&
      server.includes('throw new CustomerFacingError("Could not derive slug from title")') &&
      (server.match(/throw new CustomerFacingError\(timedOut \? PROVIDER_TIMEOUT_MESSAGE : PROVIDER_ERROR_MESSAGE\)/g) ?? []).length === 2 &&
      server.includes("throw new CustomerFacingError(PROVIDER_ERROR_MESSAGE)") &&
      server.includes('throw new CustomerFacingError("AI response missing tool call")') &&
      server.includes('throw new CustomerFacingError("AI response was not valid JSON")') &&
      /throw new CustomerFacingError\(\s*`Generated body too short/.test(server),
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
    /const \{ error: failErr \} = await sb\(\)\s*\.from\("generation_items"\)\s*\.update\(\{ status: "failed", error: msg\.slice\(0, 300\) \}\)/.test(
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
  const strings = [
    outOfCreditsMessage("google/gemini-3.1-pro-preview"),
    UNBILLED_ITEM_MESSAGE,
  ];
  const quick = read("src/lib/admin-quick-page.functions.ts");
  const draftReason = quick.match(/const UNBILLED_DRAFT_REASON =\s*"([^"]+)"/)?.[1] ?? "";
  const metering = read("src/lib/ai-metering.server.ts");
  const meteringMsg = metering.match(/OUT_OF_INCLUDED_AI_MESSAGE =\s*"([^"]+)"/)?.[1] ?? "";
  t("the quick page draft reason was found", draftReason.length > 0);
  t("the metering message was found", meteringMsg.length > 0);
  for (const [label, s] of [
    ["outOfCreditsMessage", strings[0]!],
    ["UNBILLED_ITEM_MESSAGE", strings[1]!],
    ["quick page draft reason", draftReason],
    ["ai-metering refusal", meteringMsg],
  ] as const) {
    t(`${label} names the included allowance and support`, /included AI generation/.test(s) && /contact support/i.test(s), s);
    t(`${label} has no purchase path`, !/top up/i.test(s) && !/Billing/.test(s) && !/buy|purchase/i.test(s), s);
  }
  t(
    "the metering refusal is customer-facing",
    metering.includes("throw new CustomerFacingError(OUT_OF_INCLUDED_AI_MESSAGE)"),
  );
  t(
    "no generation module still says Top up in Billing",
    ![
      "src/lib/generation.server.ts",
      "src/lib/admin-quick-page.functions.ts",
      "src/lib/ai-metering.server.ts",
      "src/lib/generation.functions.ts",
    ].some((f) => /Top up in Billing/.test(read(f))),
  );
  for (const f of [
    "src/lib/coach-actions.functions.ts",
    "src/lib/admin-page-auditor.functions.ts",
    "src/lib/admin-seo-coach.functions.ts",
  ]) {
    t(
      `${f} no longer sends customers to the hidden API Keys page`,
      !read(f).includes("Settings → API Keys") &&
        read(f).includes("AI tools are not available right now. Contact support."),
    );
  }
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
  t("every call carries an abort signal (timeout)", captured!.init?.signal instanceof AbortSignal);

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
  let caught: unknown = null;
  try {
    await callOpenRouterWritePage({
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      userPrompt: "u",
      fetchImpl: async () => okResponse(short),
    });
  } catch (e) {
    caught = e;
    err = (e as Error).message;
  }
  t(`rejects a body under ${MIN_BODY_CHARS} chars`, /too short/.test(err), err);
  t("…as a customer-facing error", caught instanceof CustomerFacingError);
  // The provider billed the key for that answer: the refusal carries the
  // usage it reported, so a failure after the call logs real spend.
  const thinUsage = providerUsageOf(caught);
  t(
    "…carrying the usage the provider reported (for the failed-spend log)",
    thinUsage?.promptTokens === 812 && thinUsage?.completionTokens === 1204,
    JSON.stringify(thinUsage),
  );
  t(
    "…without changing what the error looks like (the usage is not enumerable)",
    !Object.keys(caught as object).some((k) => /usage|token/i.test(k)) &&
      !JSON.stringify(caught).includes("812") &&
      (caught as Error).message === `Generated body too short (9 chars)`,
  );

  err = "";
  caught = null;
  try {
    await callOpenRouterWritePage({
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      userPrompt: "u",
      fetchImpl: async () => okResponse({ choices: [{ message: { content: "plain text" } }] }),
    });
  } catch (e) {
    caught = e;
    err = (e as Error).message;
  }
  t("rejects a response without a tool call", /missing tool call/.test(err), err);
  t("…as a customer-facing error", caught instanceof CustomerFacingError);

  err = "";
  caught = null;
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
    caught = e;
    err = (e as Error).message;
  }
  t("rejects malformed tool arguments", /not valid JSON/.test(err), err);
  t("…as a customer-facing error", caught instanceof CustomerFacingError);

  const logs: string[] = [];
  err = "";
  caught = null;
  try {
    await callOpenRouterWritePage({
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      userPrompt: "u",
      fetchImpl: async () => new Response("rate limited, slow down: req_abc123", { status: 429 }),
      log: (m) => logs.push(m),
    });
  } catch (e) {
    caught = e;
    err = (e as Error).message;
  }
  t("non-2xx throws the generic customer message", err === PROVIDER_ERROR_MESSAGE, err);
  t("…as a customer-facing error", caught instanceof CustomerFacingError);
  t("…with no usage attached (none was reported: a typical page is logged)", providerUsageOf(caught) === null);
  t(
    "the provider body never reaches the customer",
    !err.includes("rate limited") && !err.includes("429"),
  );
  t(
    "the status and raw body go to the server log",
    logs.some((l) => l.includes("429") && l.includes("rate limited") && l.includes("req_abc123")),
    logs.join(" | "),
  );

  logs.length = 0;
  err = "";
  try {
    await callOpenRouterWritePage({
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      userPrompt: "u",
      fetchImpl: async () => new Response("x".repeat(1000), { status: 500 }),
      log: (m) => logs.push(m),
    });
  } catch (e) {
    err = (e as Error).message;
  }
  t("a 500 also yields the generic message", err === PROVIDER_ERROR_MESSAGE, err);
  t(
    "the logged body is truncated",
    logs.length === 1 && logs[0]!.length < 600,
    String(logs[0]?.length),
  );

  // A provider that never answers: the signal fires and fetch rejects the way
  // the real one does (DOMException TimeoutError as the abort reason).
  const fetchHonouringAbort = (_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      const sig = init?.signal;
      if (!sig) return reject(new Error("no signal"));
      if (sig.aborted) return reject(sig.reason);
      sig.addEventListener("abort", () => reject(sig.reason), { once: true });
    });
  logs.length = 0;
  err = "";
  caught = null;
  try {
    await callOpenRouterWritePage({
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      userPrompt: "u",
      fetchImpl: fetchHonouringAbort,
      timeoutMs: 5,
      log: (m) => logs.push(m),
    });
  } catch (e) {
    caught = e;
    err = (e as Error).message;
  }
  t("a hung provider is abandoned with the timeout message", err === PROVIDER_TIMEOUT_MESSAGE, err);
  t("…as a customer-facing error", caught instanceof CustomerFacingError);
  t(
    "the timeout is logged server-side",
    logs.some((l) => /timeout/.test(l)),
    logs.join(" | "),
  );

  // A provider that answers 200 and then stalls mid-body: the abort fires
  // while resp.json() is still reading. That must surface as the timeout
  // sentence, never the runtime's own "The operation was aborted".
  logs.length = 0;
  err = "";
  caught = null;
  try {
    await callOpenRouterWritePage({
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      userPrompt: "u",
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          json: () =>
            Promise.reject(
              Object.assign(new Error("The operation was aborted due to timeout"), {
                name: "TimeoutError",
              }),
            ),
          text: async () => "",
        }) as unknown as Response,
      log: (m) => logs.push(m),
    });
  } catch (e) {
    caught = e;
    err = (e as Error).message;
  }
  t("a timeout during the body read yields the timeout message", err === PROVIDER_TIMEOUT_MESSAGE, err);
  t("…as a customer-facing error", caught instanceof CustomerFacingError);
  t("the raw abort message never reaches the customer", !/aborted/i.test(err));
  t(
    "the abort detail stays in the log",
    logs.some((l) => /timeout/.test(l) && /aborted/.test(l)),
    logs.join(" | "),
  );

  // A 200 whose body is not JSON at all (a proxy page, a truncated stream).
  logs.length = 0;
  err = "";
  caught = null;
  try {
    await callOpenRouterWritePage({
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      userPrompt: "u",
      fetchImpl: async () =>
        new Response("<html>bad gateway trace-id=xyz</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      log: (m) => logs.push(m),
    });
  } catch (e) {
    caught = e;
    err = (e as Error).message;
  }
  t("an unreadable 200 body yields the generic provider message", err === PROVIDER_ERROR_MESSAGE, err);
  t("…as a customer-facing error", caught instanceof CustomerFacingError);
  t(
    "the parse failure is logged as an unreadable body",
    logs.some((l) => /unreadable body/.test(l)),
    logs.join(" | "),
  );

  logs.length = 0;
  err = "";
  try {
    await callOpenRouterWritePage({
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      userPrompt: "u",
      fetchImpl: async () => {
        throw new TypeError("fetch failed: ECONNRESET 10.0.0.1");
      },
      log: (m) => logs.push(m),
    });
  } catch (e) {
    err = (e as Error).message;
  }
  t("a network failure yields the generic message", err === PROVIDER_ERROR_MESSAGE, err);
  t(
    "the network failure detail stays in the log",
    logs.some((l) => l.includes("ECONNRESET")),
  );
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
  // The daily cap is a reservation PER ATTEMPT now (one row per provider
  // call), not the pending item row: an item row can be re-armed, a
  // reservation cannot be taken back once its provider call is marked.
  const attemptIdAt = runItem.indexOf("const attemptId = await batchAttemptRequestId(row);");
  const reserveAt = runItem.indexOf(
    "slot = await reserveGenerationSlot(workspaceId, attemptId, settings.dailyCap);",
  );
  t(
    "each attempt reserves its own daily-cap slot, under its attempt id, BEFORE the claim",
    attemptIdAt > 0 && reserveAt > attemptIdAt && reserveAt < claim,
    `${attemptIdAt} ${reserveAt} ${claim}`,
  );
  t(
    "the batch no longer counts the cap in TypeScript per item",
    !runItem.includes("countConsumedLast24h(") && !runItem.includes("excludeItemId"),
  );
  t(
    "a settlement-only retry (the draft exists) takes no slot",
    /let slotId: string \| null = null;\s*if \(!row\.page_id\) \{\s*const attemptId = await batchAttemptRequestId\(row\);/.test(
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
    /slot = await reserveGenerationSlot\(workspaceId, attemptId, settings\.dailyCap\);\s*\} catch \(e\) \{\s*return refuse\(customerMessage\(e, GENERATION_UNAVAILABLE_MESSAGE\)\.slice\(0, 300\)\);/.test(
      runItem,
    ),
  );
  t(
    "the batch reservation is documented as one slot per attempt",
    /daily cap is a RESERVATION per attempt/.test(fns) &&
      /The daily-cap reservation for THIS attempt, before the claim/.test(runItem),
  );
  // The slot goes back ONLY on a way out that never reached the provider.
  t(
    "a billing refusal releases the attempt's slot before refusing",
    /\} catch \(e\) \{[\s\S]{0,200}?await releaseSlot\(\);\s*return refuse\(customerMessage\(e, GENERATION_UNAVAILABLE_MESSAGE\)/.test(
      runItem,
    ),
  );
  t(
    "a claim error or a lost claim releases the slot",
    /if \(claimErr\) \{\s*await releaseSlot\(\);\s*throw new Error\(claimErr\.message\);/.test(runItem) &&
      /if \(!claimed\) \{[\s\S]*?await releaseSlot\(\);\s*return \{ item: await freshItem\(row\.id\), changed: false \};/.test(runItem),
  );
  t(
    "linking an existing page instead of generating releases the slot",
    /billing_status: "free",\s*error: null,\s*\}\);[\s\S]{0,120}?await releaseSlot\(\);/.test(runItem),
  );
  const markAt = runItem.indexOf("await markGenerationProviderCalled(workspaceId, slotId);");
  t(
    "the attempt's reservation is marked spent in beforeProviderCall, then providerCalled is set",
    markAt > 0 &&
      /beforeProviderCall: async \(\) => \{[\s\S]*?await markGenerationProviderCalled\(workspaceId, slotId\);\s*providerCalled = true;/.test(
        runItem,
      ),
  );
  t(
    "after the provider call the slot is never released; a failure with no page logs the spend",
    /\} catch \(e\) \{\s*if \(!providerCalled\) \{[\s\S]*?await releaseSlot\(\);\s*\} else if \(!pageLinked\) \{[\s\S]*?await recordFailedGeneration\(\{[\s\S]*?feature: "batch_generation",/.test(
      runItem,
    ),
  );
  t(
    "pageLinked is set only once the item knows its page",
    runItem.indexOf("pageLinked = true;") > runItem.indexOf("page_id: page.id") &&
      runItem.indexOf("pageLinked = true;") < runItem.indexOf("const settled = await settleGeneration({\n          workspaceId,\n          userId,\n          keySource: gen.keySource"),
  );
  t(
    "releaseSlot touches only this run's own reservation",
    /const releaseSlot = async \(\) => \{\s*if \(slotId\) await releaseGenerationSlot\(workspaceId, slotId\);\s*\};/.test(runItem),
  );
  t(
    "who pays is resolved before the claim (no attempt burned on no-credits)",
    runItem.indexOf("resolveBillingMode(") < claim,
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
  const persist = runItem.indexOf("const page = await persistGeneratedPage(");
  const link = runItem.indexOf("page_id: page.id", persist);
  const settle = runItem.indexOf("settleGeneration(", persist);
  t(
    "page_id is written to the item BEFORE settlement",
    persist > 0 && link > persist && settle > link,
  );
  t(
    "the page_id write is fenced and error-checked",
    /await markItemFenced\(row\.id, token, \{\s*page_id: page\.id/.test(runItem),
  );
  t(
    "the fenced write throws when it lands on no row",
    /if \(!data \|\| data\.length === 0\) throw new LostClaimError\(\)/.test(fns),
  );
  t(
    "an unbilled settlement fails the item with credits_charged 0",
    /status: "failed",\s*credits_charged: 0,\s*billing_status: "unbilled"/.test(fns),
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
    "the reservation is keyed by the request id and the platform cap",
    /reserveGenerationSlot\(\s*data\.workspaceId,\s*generationRequestId,\s*settings\.dailyCap,\s*\)/.test(
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
    /throw new CustomerFacingError\("Generation is paused platform-wide right now\."\)/.test(handler),
  );
  t("resolves who pays before generating", handler.indexOf("resolveBillingMode(") < gen);
  t("resolves who pays after reserving (a refusal releases the slot)", handler.indexOf("resolveBillingMode(") > reserve);
  const release = handler.indexOf("releaseGenerationSlot(");
  t(
    "a failure BEFORE the provider call releases the reservation; one after it never does — it logs the spend — and both rethrow",
    release > reserve &&
      release < handler.indexOf("settleGeneration(") &&
      /\} catch \(e\) \{\s*if \(!providerCalled\) \{[\s\S]*?await releaseGenerationSlot\(data\.workspaceId, generationRequestId\);\s*\} else \{[\s\S]*?await recordFailedGeneration\(\{[\s\S]*?feature: "quick_page",[\s\S]*?\}\);\s*\}\s*throw e;/.test(
        handler,
      ) &&
      (handler.match(/releaseGenerationSlot\(/g) ?? []).length === 1,
  );
  t(
    "the reservation is marked spent immediately before the provider request, then providerCalled is set",
    /beforeProviderCall: async \(\) => \{\s*await markGenerationProviderCalled\(data\.workspaceId, generationRequestId\);\s*providerCalled = true;\s*\}/.test(
      handler,
    ),
  );
  t(
    "the failed-spend row uses the provider's usage when known (gen, or the refusal's), a typical page otherwise",
    /usage: gen\s*\?\s*\{ promptTokens: gen\.promptTokens, completionTokens: gen\.completionTokens \}\s*:\s*providerUsageOf\(e\),/.test(
      handler,
    ),
  );
  t(
    "persists with the request id",
    handler.includes("generationRequestId,") && quick.includes("generation_request_id") === false,
  );
  t(
    "a replayed persist does not settle",
    handler.indexOf("if (page.replayed)") < handler.indexOf("settleGeneration("),
  );
  t(
    "an unbilled quick page is kept as a draft, not published",
    handler.includes('settled.billing === "unbilled"'),
  );
  t("uses z.enum over the picker ids", quick.includes("z.enum(GENERATION_MODEL_IDS)"));
  t("quick page module says /a/, never /p/", !quick.includes("/p/") && quick.includes("/a/"));

  // Replay settles a platform page (idempotent through the ledger) instead of
  // reporting a hard-coded free result.
  const replay = quick.slice(
    quick.indexOf("async function replayResult("),
    quick.indexOf("export async function runQuickPage"),
  );
  t("replayResult was found", replay.length > 0);
  t(
    "a replayed platform page is settled by page id with typical tokens",
    replay.includes('existing.generation_billing_mode === "platform"') &&
      /feature: "quick_page",\s*refId: existing\.id,/.test(replay) &&
      replay.includes("promptTokens: TYPICAL_PAGE_TOKENS.prompt") &&
      replay.includes("completionTokens: TYPICAL_PAGE_TOKENS.completion") &&
      replay.includes('keySource: "platform"') &&
      replay.includes('billingMode: "platform"'),
  );
  t(
    "the replay reports the settled charge, not 0 / free",
    /creditsCharged = settled\.creditsCharged;\s*billing = settled\.billingStatus;/.test(replay),
  );
  t(
    "a non-platform replay owes nothing",
    /let creditsCharged = 0;\s*let billing: ItemBillingStatus = "free";/.test(replay),
  );
  t(
    "all three replay paths (step 0, a spent id with its page, post-persist) go through replayResult",
    (handler.match(/return replayResult\(existing, \{ workspaceId: data\.workspaceId, userId, model: data\.model \}\);/g) ?? [])
      .length === 3,
  );
  const server = read("src/lib/generation.server.ts");
  t(
    "findPageByRequestId selects the billing mode",
    /\.select\("id, slug, title, status, body_markdown, generation_billing_mode"\)/.test(server),
  );
  const persistFn = server.slice(
    server.indexOf("export async function persistGeneratedPage"),
    server.indexOf("export type LedgerSettlement"),
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
  t("it never calls the gateway", !create.includes("callAI(") && !create.includes("AI_URL") && !create.includes("fetch("));
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
    "an existing page for the city is a refusal via the core predicate, not a slug lookup",
    create.includes("findExistingCityPage(workspaceId, city, state || null)") &&
      !create.includes('.eq("slug"') &&
      /throw new CustomerFacingError\(\s*`A page for \$\{city\} already exists/.test(create),
  );
  const run = coach.slice(coach.indexOf("export const runCoachAction"));
  const branch = run.indexOf('if (data.actionType === "create_city_page")');
  t("the core branch comes before any key resolution", branch > 0 && branch < run.indexOf("getWorkspaceSecretWithSource"));
  t("the core branch comes before any platform metering", branch < run.indexOf("reservePlatformAi"));
  t(
    "the core branch neither reserves nor settles platform AI",
    !run.slice(branch, run.indexOf("getWorkspaceSecretWithSource")).includes("PlatformAi"),
  );
  t(
    "the core branch still writes the coach_action_log row",
    (run.match(/await logAction\(errorMessage, result\);/g) ?? []).length === 2 &&
      run.includes('from("coach_action_log")'),
  );
  t(
    "the core branch throws only a customer message",
    /errorMessage = customerMessage\(e, GENERATION_UNAVAILABLE_MESSAGE\);/.test(run.slice(branch)),
  );
  t("the gateway switch no longer has a create_city_page case", !/case "create_city_page"/.test(run));
  t(
    "internal-link counting matches the /a/ links the prompt asks for",
    coach.includes("/\\]\\(\\/a\\//g") && !coach.includes("/\\]\\(\\/p\\//g"),
  );
  const cron = read("supabase/functions/coach-briefing-cron/index.ts");
  t("the briefing cron points at /a/, not /p/", cron.includes("Start with /a/${") && !cron.includes("/p/"));
}

console.log("\n=== approveOpportunity: idempotent and guarded ===");
{
  const opp = read("src/lib/opportunities.functions.ts");
  const approve = opp.slice(opp.indexOf("export const approveOpportunity"), opp.indexOf("export const skipOpportunity"));
  t("approveOpportunity was found", approve.length > 0);
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
  t("a generation failure reports only a customer message", /customerMessage\(e, GENERATION_UNAVAILABLE_MESSAGE\)/.test(approve));
}

console.log("\n=== UI copy and wiring ===");
{
  const qpb = read("src/routes/_authenticated/app.content.quick-page-builder.tsx");
  t("Quick Page Builder never shows /p/", !qpb.includes("/p/"));
  t("Quick Page Builder shows the /a/ live prefix", qpb.includes("/a/"));
  t(
    "Quick Page Builder takes its default model from the server, not a hardcoded Pro id",
    qpb.includes("defaultModel") && !/useState\("google\/gemini/.test(qpb),
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
