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
 *   - the daily cap is a reservation (done + running + pending), the attempt
 *     ceiling is 3, the pause switch accepts true and "true"
 *   - the platform key must afford a WHOLE page; a failed deduction is
 *     recorded as unbilled, never as a charge
 *   - the quick page accepts only picker models, defaults to the cheap one,
 *     and carries an idempotency key
 *   - the OpenRouter caller times out, rejects what must be rejected, and
 *     never lets a provider body reach the customer
 *   - the migration carries the idempotency keys, billing_status, the pause
 *     seed and the write REVOKEs; the rollback undoes the tenant_pages column
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ATTEMPTS_EXHAUSTED_MESSAGE,
  DAILY_CAP_COUNTED_STATUSES,
  GENERATION_DEFAULT_MODEL,
  GENERATION_MODEL_IDS,
  GENERATION_MODEL_OPTIONS,
  GENERATION_PAUSED_MESSAGE,
  MAX_ITEM_ATTEMPTS,
  MIN_BODY_CHARS,
  OPENROUTER_TIMEOUT_MS,
  PROVIDER_ERROR_MESSAGE,
  PROVIDER_TIMEOUT_MESSAGE,
  STALE_RUNNING_MS,
  attemptsExhausted,
  billingStatusFor,
  buildCityBrief,
  buildTargetKey,
  callOpenRouterWritePage,
  countsTowardDailyCap,
  dailyCapRemaining,
  estimatedCreditsPerPage,
  formatInventoryFacts,
  hasPlatformFunds,
  initialBillingStatus,
  isGenerationPaused,
  isStaleRunning,
  pageCoversCity,
  planJobItems,
  selectTargets,
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

  t(
    "the counted statuses are exactly done, running and pending",
    [...DAILY_CAP_COUNTED_STATUSES].sort().join() === "done,pending,running",
  );
  t(
    "a done item in the window counts",
    countsTowardDailyCap({ status: "done", updated_at: ago(3600_000) }, NOW),
  );
  t(
    "a running item counts (reservation)",
    countsTowardDailyCap({ status: "running", updated_at: ago(60_000) }, NOW),
  );
  t(
    "a pending item counts (reservation)",
    countsTowardDailyCap({ status: "pending", updated_at: ago(60_000) }, NOW),
  );
  t(
    "a failed item releases its slot",
    !countsTowardDailyCap({ status: "failed", updated_at: ago(60_000) }, NOW),
  );
  t(
    "a skipped item releases its slot",
    !countsTowardDailyCap({ status: "skipped", updated_at: ago(60_000) }, NOW),
  );
  t(
    "a done item from 25 hours ago no longer counts",
    !countsTowardDailyCap({ status: "done", updated_at: ago(25 * 3600_000) }, NOW),
  );
  t(
    "an item of unknown age counts (fail closed)",
    countsTowardDailyCap({ status: "done", updated_at: null }, NOW),
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
  const settle = server.slice(server.indexOf("export async function settleGeneration"));
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

  // Settlement is idempotent by PAGE against the credit ledger, which
  // deduct_credits writes in the same transaction as the balance change. A
  // run that died after deducting but before recording it on the item must
  // not deduct again on the retry.
  const ledgerCheck = settle.indexOf("findLedgerCharge(opts.workspaceId, opts.refId)");
  t("settleGeneration consults the ledger for this page first", ledgerCheck > 0);
  t(
    "the ledger check precedes the free-quota consume",
    ledgerCheck < settle.indexOf('rpc("consume_platform_ai_credit"'),
  );
  t(
    "the ledger check precedes the deduction",
    ledgerCheck < settle.indexOf('rpc("deduct_credits"'),
  );
  t(
    "a prior ledger charge is reported as the charge, not re-deducted",
    /if \(prior !== null\) \{\s*billing = "credits";\s*creditsCharged = prior;/.test(settle),
  );
  const ledgerFn = server.slice(
    server.indexOf("export async function findLedgerCharge"),
    server.indexOf("export async function settleGeneration"),
  );
  t(
    "the ledger lookup is keyed by workspace, page id and the ai_usage reason, spends only",
    ledgerFn.includes('.eq("workspace_id", workspaceId)') &&
      ledgerFn.includes('.eq("ref_id", refId)') &&
      ledgerFn.includes('.eq("reason", "ai_usage")') &&
      ledgerFn.includes('.lt("delta", 0)'),
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

  const logs: string[] = [];
  err = "";
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
    err = (e as Error).message;
  }
  t("non-2xx throws the generic customer message", err === PROVIDER_ERROR_MESSAGE, err);
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
    err = (e as Error).message;
  }
  t("a hung provider is abandoned with the timeout message", err === PROVIDER_TIMEOUT_MESSAGE, err);
  t(
    "the timeout is logged server-side",
    logs.some((l) => /timeout/.test(l)),
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
  t(
    "the daily cap is re-checked per item, excluding the item's own slot",
    runItem.indexOf("countConsumedLast24h(workspaceId, { excludeItemId: row.id })") < claim,
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
  const handler = quick.slice(quick.indexOf("export const createQuickPage"));
  const gen = handler.indexOf("generatePageContent(");
  t("createQuickPage was found", handler.length > 0 && gen > 0);
  t("replays by request id before generating", handler.indexOf("findPageByRequestId(") < gen);
  t("checks the pause switch before generating", handler.indexOf("readPlatformSettings()") < gen);
  t("applies the daily cap before generating", handler.indexOf("countConsumedLast24h(") < gen);
  t("resolves who pays before generating", handler.indexOf("resolveBillingMode(") < gen);
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
  t("the preview link is /s/{workspace}/{slug}", qpb.includes("`/s/${ws.slug}/${result.slug}`"));
  const genUi = read("src/routes/_authenticated/app.content.generate.tsx");
  t(
    "Stop after this one cancels the job server-side",
    genUi.includes("cancelGenerationJob") && /onClick=\{stop\}/.test(genUi),
  );
  t("Generate Content copy has no /p/", !genUi.includes("/p/"));
  t("given-up cities cannot be selected", genUi.includes("!t.attemptsExhausted"));
}

console.log("\n=== migration text ===");
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
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}
