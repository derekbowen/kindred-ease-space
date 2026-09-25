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
}

console.log("\n=== the reads (fake PostgREST) ===");
function world(o: { enabled?: boolean | null; budget?: number; spent?: number; quota?: number | null; balance?: number | null; ownKey?: boolean; used?: number; cap?: number; paused?: boolean }) {
  backend.reset();
  backend.rest["GET ai_platform_settings"] = () =>
    o.enabled === null ? [] : [{ platform_ai_enabled: o.enabled ?? true, daily_budget_micros: o.budget ?? 10_000_000 }];
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
    "exactly the documented fields — no quota units, no credit balance, no ceiling",
    Object.keys(a).sort().join() === "dailyCap,generationMessage,generationPaused,generationsUsedToday,message,state",
    Object.keys(a).join(),
  );
  t("the sentences are the fixed ones", a.message === AI_ALLOWANCE_MESSAGES.ok && a.generationMessage === "7 of 50 AI-generated pages used in the last 24 hours.");
  t("nothing was reserved, marked or sent to reach it", backend.noSpend());

  world({ quota: null });
  t("no quota row yet reads as the default free allowance (ok)", (await readAiAllowance(WS)).state === "ok");
  world({ quota: 0, balance: 0 });
  t("no free quota and no credits → exhausted, with its sentence", (await readAiAllowance(WS)).message === AI_ALLOWANCE_MESSAGES.exhausted);
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
  world({ quota: 20, paused: true, used: 3 });
  {
    const a = await readAiAllowance(WS);
    t("the generation pause is reported with its own sentence", a.generationPaused === true && /paused/.test(a.generationMessage));
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
