/**
 * ONE AI ALLOWANCE. Run: bun tests/ai-allowance.test.ts
 *
 * getAiAllowance (src/lib/ai-allowance.functions.ts) is the one number every
 * AI screen shows: pages used against the fair-use daily cap, and one plain
 * state for the rest — "ok" | "low" | "exhausted" | "platform_paused" — with
 * a customer sentence each. Asserted: the state table (pure), the reads
 * against a fake PostgREST (the reservation-backed page count, the kill
 * switch, the ceiling, own key, free quota, credits), that no credit
 * arithmetic leaves the server, that a read error is never shown as "ok",
 * and the endpoint's shape (strict, authenticated, member-only).
 *
 * Round 5: the per-workspace daily AI cost cap (state "workspace_limit",
 * read with the same sum ai_reserve checks) and the founder / internal
 * unlimited entitlement (internalUnlimited / planLabel /
 * revealLaunchHiddenFeatures, no daily page cap, not limited by tenant
 * funds or the workspace cap — still by the kill switch and the ceiling).
 */
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeBackend } from "./_support/fake-backend";

const backend = new FakeBackend();
backend.install();

const {
  AI_ALLOWANCE_MESSAGES,
  AI_ALLOWANCE_STATES,
  GetAiAllowanceInputSchema,
  LOW_ALLOWANCE_CALLS,
  MIN_HOLD_MICROS,
  deriveAllowanceState,
  generationSentence,
  readAiAllowance,
} = await import("../src/lib/ai-allowance.functions");
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

const WS = "11111111-1111-4111-8111-111111111111";

console.log("\n=== the state table (pure) ===");
{
  const base = { platformEnabled: true, budgetRemainingMicros: 10_000_000, ownKey: false, freeRemaining: 20, credits: 0 };
  const cases: Array<[string, Partial<typeof base>, string]> = [
    ["plenty of free quota", {}, "ok"],
    ["free quota gone, plenty of credits", { freeRemaining: 0, credits: 100 }, "ok"],
    [`${LOW_ALLOWANCE_CALLS} free calls left`, { freeRemaining: LOW_ALLOWANCE_CALLS }, "low"],
    ["one credit and no free quota (a small call still fits)", { freeRemaining: 0, credits: 1 }, "low"],
    ["nothing left", { freeRemaining: 0, credits: 0 }, "exhausted"],
    ["negative or garbage numbers read as nothing", { freeRemaining: -4, credits: Number.NaN }, "exhausted"],
    ["the kill switch is off", { platformEnabled: false }, "platform_paused"],
    ["today's ceiling cannot fit the smallest hold", { budgetRemainingMicros: MIN_HOLD_MICROS - 1 }, "platform_paused"],
    ["the ceiling fits exactly the smallest hold", { budgetRemainingMicros: MIN_HOLD_MICROS }, "ok"],
    ["own key, even with the kill switch off and nothing left", { ownKey: true, platformEnabled: false, freeRemaining: 0, credits: 0 }, "ok"],
    ["kill switch off beats an empty allowance", { platformEnabled: false, freeRemaining: 0, credits: 0 }, "platform_paused"],
    // Round 5 (H2): the workspace's own daily AI cost cap.
    ["the workspace cap cannot fit the smallest hold", { workspaceRemainingMicros: MIN_HOLD_MICROS - 1 }, "workspace_limit"],
    ["the workspace cap fits exactly the smallest hold", { workspaceRemainingMicros: MIN_HOLD_MICROS }, "ok"],
    ["the workspace cap over-spent (negative remainder)", { workspaceRemainingMicros: -5 }, "workspace_limit"],
    ["the kill switch beats the workspace cap", { platformEnabled: false, workspaceRemainingMicros: 0 }, "platform_paused"],
    ["own key is never limited by the workspace cap", { ownKey: true, workspaceRemainingMicros: 0 }, "ok"],
    ["the workspace cap beats an empty allowance (it is the reason calls are refused)", { workspaceRemainingMicros: 0, freeRemaining: 0, credits: 0 }, "workspace_limit"],
    // The founder / internal unlimited entitlement.
    ["internal: no free quota, no credits, workspace cap spent → still ok", { internalUnlimited: true, freeRemaining: 0, credits: 0, workspaceRemainingMicros: 0 }, "ok"],
    ["internal: the kill switch still applies", { internalUnlimited: true, platformEnabled: false }, "platform_paused"],
    ["internal: the platform ceiling still applies", { internalUnlimited: true, budgetRemainingMicros: 0 }, "platform_paused"],
    ["internal false changes nothing", { internalUnlimited: false, freeRemaining: 0, credits: 0 }, "exhausted"],
  ];
  for (const [label, over, want] of cases) {
    const got = deriveAllowanceState({ ...base, ...over });
    t(`${label} → ${want}`, got === want, got);
  }
  t("every state has its sentence", AI_ALLOWANCE_STATES.every((s) => typeof AI_ALLOWANCE_MESSAGES[s] === "string" && AI_ALLOWANCE_MESSAGES[s].length > 0));
  t("platform_paused says what every refused call says", AI_ALLOWANCE_MESSAGES.platform_paused === AI_MESSAGES.platformPaused);
  t(
    "no sentence offers a purchase or shows arithmetic",
    Object.values(AI_ALLOWANCE_MESSAGES).every((m) => !/top up|buy|purchase|billing|\bcredits?\b|\d/i.test(m)),
    JSON.stringify(AI_ALLOWANCE_MESSAGES),
  );
  t("the page sentence counts used of cap", generationSentence(12, 50, false) === "12 of 50 AI-generated pages used in the last 24 hours.");
  t("…never over the cap", generationSentence(60, 50, false) === "50 of 50 AI-generated pages used in the last 24 hours.");
  t("…says when generation is paused", /paused/.test(generationSentence(3, 50, true)));
  t("…and when the cap could not be read (0)", /not available/.test(generationSentence(0, 0, false)));
  t(
    "internal: no daily limit, the count still shown (never 'of 2147483647')",
    generationSentence(12, 2_147_483_647, false, true) === "No daily limit on AI-generated pages for this internal account. 12 generated in the last 24 hours.",
  );
  t("internal: the platform-wide pause still says paused", /paused/.test(generationSentence(3, 2_147_483_647, true, true)));
  t("the workspace-limit sentence is the one ai_reserve's refusal uses", AI_ALLOWANCE_MESSAGES.workspace_limit === AI_MESSAGES.workspaceBudgetExhausted);
}

console.log("\n=== the reads (fake PostgREST) ===");
function world(o: {
  enabled?: boolean | null;
  budget?: number;
  spent?: number;
  quota?: number | null;
  balance?: number | null;
  ownKey?: boolean;
  used?: number;
  cap?: number;
  paused?: boolean;
  wsBudget?: number;
  wsSpent?: number;
  internal?: boolean;
}) {
  backend.reset();
  backend.rest["GET ai_platform_settings"] = () =>
    o.enabled === null
      ? []
      : [
          {
            platform_ai_enabled: o.enabled ?? true,
            daily_budget_micros: o.budget ?? 10_000_000,
            workspace_daily_budget_micros: o.wsBudget ?? 1_000_000,
          },
        ];
  backend.rpc.ai_workspace_spent_micros = (a: any) => (a._workspace_id === WS ? (o.wsSpent ?? 0) : 999_999_999);
  backend.rpc.workspace_is_internal_unlimited = (a: any) => a._workspace_id === WS && o.internal === true;
  backend.rest["GET ai_budget_days"] = () => (o.spent === undefined ? [] : [{ spent_micros: o.spent }]);
  backend.rest["GET workspace_ai_quota"] = (h) =>
    o.quota === null || o.quota === undefined || h.query.get("workspace_id") !== `eq.${WS}` ? [] : [{ platform_credits_remaining: o.quota }];
  backend.rest["GET credit_balances"] = () => (o.balance === null || o.balance === undefined ? [] : [{ balance: o.balance }]);
  backend.rest["GET workspace_secrets"] = (h) =>
    o.ownKey && h.query.get("key_name") === "eq.OPENAI_API_KEY" ? [{ id: "secret-1" }] : [];
  backend.rest["GET platform_settings"] = () => [
    { key: "generation_paused", value: o.paused ?? false },
    { key: "generation_daily_cap", value: o.cap ?? 50 },
  ];
  backend.rpc.generation_consumed_last_24h = (a: any) => (a._workspace_id === WS ? (o.used ?? 0) : 999);
}
{
  world({ quota: 20, used: 7 });
  const a = await readAiAllowance(WS);
  t("a fresh workspace: ok, 7 of 50 pages", a.state === "ok" && a.generationsUsedToday === 7 && a.dailyCap === 50 && a.generationPaused === false, JSON.stringify(a));
  t("the page count comes from the reservation ledger's RPC, for this workspace", backend.rpcHits("generation_consumed_last_24h")[0]?.body?._workspace_id === WS);
  t(
    "exactly the documented fields — no quota units, no credit balance, no ceiling, no workspace-cap figure",
    Object.keys(a).sort().join() ===
      "dailyCap,generationPaused,generationSummary,generationsUsedToday,internalUnlimited,planLabel,revealLaunchHiddenFeatures,state,summary",
    Object.keys(a).join(),
  );
  t(
    "an ordinary workspace: internalUnlimited false, planLabel null, revealLaunchHiddenFeatures false",
    a.internalUnlimited === false && a.planLabel === null && a.revealLaunchHiddenFeatures === false,
  );
  t(
    "…decided by THE predicate for this workspace, and the workspace cap by the same sum ai_reserve checks (today, this workspace)",
    backend.rpcHits("workspace_is_internal_unlimited")[0]?.body?._workspace_id === WS &&
      backend.rpcHits("ai_workspace_spent_micros")[0]?.body?._workspace_id === WS &&
      backend.rpcHits("ai_workspace_spent_micros")[0]?.body?._day === new Date().toISOString().slice(0, 10),
  );
  t("the sentences are the fixed ones", a.summary === AI_ALLOWANCE_MESSAGES.ok && a.generationSummary === "7 of 50 AI-generated pages used in the last 24 hours.");
  t("nothing was reserved, marked or sent to reach it", backend.noSpend());

  world({ quota: null });
  t("no quota row yet reads as the default free allowance (ok)", (await readAiAllowance(WS)).state === "ok");
  world({ quota: 0, balance: 0 });
  t("no free quota and no credits → exhausted, with its sentence", (await readAiAllowance(WS)).summary === AI_ALLOWANCE_MESSAGES.exhausted);
  world({ quota: 2, balance: 0 });
  t("two free calls left → low", (await readAiAllowance(WS)).state === "low");
  world({ enabled: false, quota: 20 });
  t("the kill switch off → platform_paused", (await readAiAllowance(WS)).state === "platform_paused");
  world({ enabled: null, quota: 20 });
  t("a missing settings row fails closed → platform_paused (as ai_reserve does)", (await readAiAllowance(WS)).state === "platform_paused");
  world({ quota: 20, budget: 1_000, spent: 900 });
  t("today's ceiling spent → platform_paused", (await readAiAllowance(WS)).state === "platform_paused");
  world({ enabled: false, quota: 0, balance: 0, ownKey: true });
  t("own key → ok whatever the platform side says", (await readAiAllowance(WS)).state === "ok");
  world({ quota: 20, wsBudget: 1_000_000, wsSpent: 999_999 });
  {
    const a = await readAiAllowance(WS);
    t("today's workspace AI cost cap spent → workspace_limit, with the refusal's own sentence", a.state === "workspace_limit" && a.summary === AI_MESSAGES.workspaceBudgetExhausted, JSON.stringify(a));
    t("…and the figures behind it never leave the server", !/999999|1000000|micros/i.test(JSON.stringify(a)), JSON.stringify(a));
  }
  world({ quota: 20, wsBudget: 1_000_000, wsSpent: 10_000 });
  t("the workspace cap with room left → ok", (await readAiAllowance(WS)).state === "ok");
  world({ quota: 0, balance: 0, wsSpent: 5_000_000, internal: true, used: 180, cap: 50 });
  {
    const a = await readAiAllowance(WS);
    t(
      "internal: ok with no quota, no credits and the workspace cap far exceeded",
      a.state === "ok" && a.summary === AI_ALLOWANCE_MESSAGES.ok,
      JSON.stringify(a),
    );
    t(
      "internal: no daily page cap (2147483647, the cap reserve_generation_slot is given), the count still reported",
      a.dailyCap === 2_147_483_647 && a.generationsUsedToday === 180 && /^No daily limit/.test(a.generationSummary),
      JSON.stringify(a),
    );
    t(
      "internal: internalUnlimited true, planLabel 'Founder / Internal Unlimited', revealLaunchHiddenFeatures true",
      a.internalUnlimited === true && a.planLabel === "Founder / Internal Unlimited" && a.revealLaunchHiddenFeatures === true,
    );
  }
  world({ enabled: false, quota: 20, internal: true });
  t("internal: the kill switch still reads platform_paused", (await readAiAllowance(WS)).state === "platform_paused");
  world({ quota: 20, budget: 1_000, spent: 900, internal: true });
  t("internal: the platform ceiling still reads platform_paused", (await readAiAllowance(WS)).state === "platform_paused");
  world({ quota: 20, internal: true, paused: true });
  {
    const a = await readAiAllowance(WS);
    t("internal: the platform-wide generation pause is still reported", a.generationPaused === true && /paused/.test(a.generationSummary));
  }
  world({ quota: 20, paused: true, used: 3 });
  {
    const a = await readAiAllowance(WS);
    t("the generation pause is reported with its own sentence", a.generationPaused === true && /paused/.test(a.generationSummary));
  }
  world({ quota: 20 });
  backend.rest["GET credit_balances"] = () => ({ status: 500, body: { message: "relation exploded" } });
  let threw = false;
  try {
    await readAiAllowance(WS);
  } catch {
    threw = true;
  }
  t("a read error throws — never an 'ok' it could not check", threw);
  for (const [label, rpc] of [
    ["the internal entitlement", "workspace_is_internal_unlimited"],
    ["the workspace's AI spend today", "ai_workspace_spent_micros"],
  ] as const) {
    world({ quota: 20 });
    backend.rpc[rpc] = () => ({ status: 500, body: { message: "rpc exploded" } });
    let threwRpc = false;
    try {
      await readAiAllowance(WS);
    } catch {
      threwRpc = true;
    }
    t(`a failed read of ${label} throws too — never 'ok', never 'unlimited'`, threwRpc);
  }
}

console.log("\n=== the endpoint ===");
{
  t("the input is strict: a workspace id only", GetAiAllowanceInputSchema.safeParse({ workspaceId: WS }).success && !GetAiAllowanceInputSchema.safeParse({ workspaceId: WS, model: "gpt-5-mini" }).success && !GetAiAllowanceInputSchema.safeParse({}).success);
  const src = readFileSync(join(import.meta.dir, "../src/lib/ai-allowance.functions.ts"), "utf8");
  const fn = src.slice(src.indexOf("export const getAiAllowance"));
  t("authenticated (requireSupabaseAuth)", /\.middleware\(\[requireSupabaseAuth\]\)/.test(fn));
  t("member-only, checked before any read", /await assertWorkspaceMember\(data\.workspaceId, context\.userId\);\s*return await readAiAllowance\(data\.workspaceId\);/.test(fn));
  t("a failure is a customer sentence", /throw new Error\(customerMessage\(e, AI_ALLOWANCE_UNAVAILABLE_MESSAGE\)\);/.test(fn));
  const pkg = readFileSync(join(import.meta.dir, "..", "package.json"), "utf8");
  t("this suite is in the test chain", /bun tests\/ai-allowance\.test\.ts/.test(pkg));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failed:", failed.join(", "));
  process.exit(1);
}
