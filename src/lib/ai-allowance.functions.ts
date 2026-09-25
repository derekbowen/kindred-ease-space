import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import { AI_DEFAULT_MODEL } from "@/lib/ai/models";
import { AI_ROUTE_LIMITS } from "@/lib/ai/limits";
import { AI_MESSAGES, customerMessage } from "@/lib/ai/customer-error";
import { creditsForCostMicros, maxCostMicros } from "@/lib/ai-pricing";

/**
 * ONE allowance for every screen that talks about AI: how many AI-generated
 * pages the workspace used against its fair-use daily cap, and one plain
 * state for everything else — never credit arithmetic.
 *
 *   generationsUsedToday / dailyCap — page generations counted by the same
 *       reservation ledger that enforces the cap (generation_reservations,
 *       one row per provider call over the last 24 hours, every generator);
 *   state — "ok" | "low" | "exhausted" | "platform_paused", from the
 *       workspace's included AI (free quota + credits), its own key (a
 *       workspace that brought its own key is never limited by either) and
 *       the platform kill switch / daily ceiling (platform_paused);
 *   message / generationMessage — fixed customer sentences for the state and
 *       for the page count.
 *
 * Read-only and member-only. The numbers behind the state (the quota units,
 * the credit balance, the ceiling) never leave the server.
 */

export const AI_ALLOWANCE_STATES = ["ok", "low", "exhausted", "platform_paused"] as const;
export type AiAllowanceState = (typeof AI_ALLOWANCE_STATES)[number];

export const AI_ALLOWANCE_MESSAGES: Readonly<Record<AiAllowanceState, string>> = Object.freeze({
  ok: "AI features are ready to use for this workspace.",
  low: "This workspace is close to the end of its included AI generation. Contact support if you need more.",
  exhausted:
    "This workspace has used up its included AI generation. Contact support to continue using AI features.",
  platform_paused: AI_MESSAGES.platformPaused,
});

export const AI_ALLOWANCE_UNAVAILABLE_MESSAGE =
  "Couldn't load this workspace's AI allowance right now. Try again in a minute.";

export type AiAllowance = {
  /** Page generations in the last 24 hours, as the daily cap counts them. */
  generationsUsedToday: number;
  /** The fair-use cap on generated pages per workspace per day. */
  dailyCap: number;
  /** Page generation is paused platform-wide (ops switch). */
  generationPaused: boolean;
  state: AiAllowanceState;
  /** A customer sentence for `state`. */
  message: string;
  /** A customer sentence for the page count. */
  generationMessage: string;
};

/** A few calls or fewer left is "low". */
export const LOW_ALLOWANCE_CALLS = 3;

/** Credits a typical page holds on the platform key (the largest common hold). */
const PAGE_HOLD_CREDITS = Math.max(
  1,
  creditsForCostMicros(maxCostMicros(AI_DEFAULT_MODEL, 6_000, AI_ROUTE_LIMITS.page_generation.maxOutputTokens)),
);

/** The smallest hold any route takes: below it the ceiling refuses everything. */
export const MIN_HOLD_MICROS = maxCostMicros(AI_DEFAULT_MODEL, 1_100, AI_ROUTE_LIMITS.add_meta.maxOutputTokens);

export type AllowanceInputs = {
  /** The kill switch (a missing settings row counts as off, as in ai_reserve). */
  platformEnabled: boolean;
  /** What today's platform ceiling has left. */
  budgetRemainingMicros: number;
  /** The workspace brought its own key: neither the kill switch nor its funds apply. */
  ownKey: boolean;
  /** Free-quota units left. */
  freeRemaining: number;
  /** Credit balance. */
  credits: number;
};

/** Pure: the state from the inputs. */
export function deriveAllowanceState(i: AllowanceInputs): AiAllowanceState {
  if (i.ownKey) return "ok";
  if (!i.platformEnabled || !(i.budgetRemainingMicros >= MIN_HOLD_MICROS)) return "platform_paused";
  const free = Math.max(0, Math.floor(Number(i.freeRemaining) || 0));
  const credits = Math.max(0, Math.floor(Number(i.credits) || 0));
  if (free === 0 && credits < 1) return "exhausted";
  const callsLeft = free + Math.floor(credits / PAGE_HOLD_CREDITS);
  return callsLeft <= LOW_ALLOWANCE_CALLS ? "low" : "ok";
}

/** Pure: the sentence for the page count. */
export function generationSentence(used: number, cap: number, paused: boolean): string {
  if (paused) return "Page generation is paused platform-wide right now. Try again later.";
  if (!(cap > 0)) return "Page generation is not available right now. Try again later.";
  const u = Math.max(0, Math.floor(used));
  return `${Math.min(u, cap)} of ${cap} AI-generated pages used in the last 24 hours.`;
}

type Reader = { from: (table: string) => any };

/**
 * Read everything the allowance needs (service role) and derive it. Throws
 * on a read error: an allowance that cannot be read is never shown as "ok".
 */
export async function readAiAllowance(
  workspaceId: string,
  deps: { db?: Reader } = {},
): Promise<AiAllowance> {
  const db = deps.db ?? (supabaseAdmin as unknown as Reader);
  const today = new Date().toISOString().slice(0, 10);
  const { readPlatformSettings, countConsumedLast24h } = await import("@/lib/generation.server");
  const [settings, budget, quota, credits, ownKey, platform, used] = await Promise.all([
    db.from("ai_platform_settings").select("platform_ai_enabled, daily_budget_micros").eq("id", true).maybeSingle(),
    db.from("ai_budget_days").select("spent_micros").eq("day", today).maybeSingle(),
    db.from("workspace_ai_quota").select("platform_credits_remaining").eq("workspace_id", workspaceId).maybeSingle(),
    db.from("credit_balances").select("balance").eq("workspace_id", workspaceId).maybeSingle(),
    db
      .from("workspace_secrets")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("key_name", "OPENAI_API_KEY")
      .maybeSingle(),
    readPlatformSettings(),
    countConsumedLast24h(workspaceId),
  ]);
  for (const r of [settings, budget, quota, credits, ownKey]) {
    if (r?.error) throw new Error(`ai allowance read failed: ${r.error.message}`);
  }
  const enabled = settings.data?.platform_ai_enabled === true;
  const ceiling = Number(settings.data?.daily_budget_micros ?? 0);
  const spent = Number(budget.data?.spent_micros ?? 0);
  const state = deriveAllowanceState({
    platformEnabled: enabled,
    budgetRemainingMicros: ceiling - spent,
    ownKey: !!ownKey.data,
    // No quota row yet: the free allowance the first reservation seeds.
    freeRemaining: quota.data ? Number(quota.data.platform_credits_remaining) : 20,
    credits: Number(credits.data?.balance ?? 0),
  });
  return {
    generationsUsedToday: used,
    dailyCap: platform.dailyCap,
    generationPaused: platform.paused,
    state,
    message: AI_ALLOWANCE_MESSAGES[state],
    generationMessage: generationSentence(used, platform.dailyCap, platform.paused),
  };
}

export const GetAiAllowanceInputSchema = z.object({ workspaceId: workspaceIdSchema }).strict();

/** The one allowance endpoint. Member-only; answers the documented shape or a customer sentence. */
export const getAiAllowance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => GetAiAllowanceInputSchema.parse(d))
  .handler(async ({ data, context }): Promise<AiAllowance> => {
    try {
      await assertWorkspaceMember(data.workspaceId, context.userId);
      return await readAiAllowance(data.workspaceId);
    } catch (e) {
      throw new Error(customerMessage(e, AI_ALLOWANCE_UNAVAILABLE_MESSAGE));
    }
  });
