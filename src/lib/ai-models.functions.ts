import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import {
  AI_DEFAULT_TIER,
  AI_QUALITY_TIERS,
  AI_TIER_OPTIONS,
  modelForTier,
  type AiModelId,
  type AiQualityTier,
} from "@/lib/ai/models";
import { AI_ROUTE_LIMITS } from "@/lib/ai/limits";
import { AI_MESSAGES, customerMessage } from "@/lib/ai/customer-error";

/**
 * WHICH AI MODELS THIS WORKSPACE CAN USE — the one source for a model picker
 * (the Quick Page Builder and the batch "Generate Content" page).
 *
 * Built from the single model allowlist (src/lib/ai/models.ts: standard →
 * gpt-5-nano, premium → gpt-5-mini) and the workspace's actual key situation,
 * the same precedence resolveAiKey uses when it runs a call:
 *   1. the workspace's own OpenAI key (BYOK, workspace secret) → source "byok"
 *      — the platform kill switch does not apply to it;
 *   2. else the platform's OpenAI key (the Worker secret) → source "platform"
 *      — state "platform_paused" while the kill switch is off (or its settings
 *      row is missing, as ai_reserve fails closed);
 *   3. else nothing → state "none_configured", with what to configure and
 *      where (settingsPath).
 * Only OpenAI exists: no other provider, model or label is ever listed.
 * Premium is listed because this picker is for page generation, the one
 * route that offers it (AI_ROUTE_LIMITS.page_generation.tiers); every other
 * AI route runs on standard only.
 *
 * Member-only and read-only. Nothing here reveals a key, part of one, or
 * whether a particular key string exists — only which kind of key is
 * configured. What the picker sends back is the TIER of the chosen model
 * (the `quality` field of createQuickPage / startGenerationJob, a strict
 * enum); the server maps it to the model again (routeModel), so no provider
 * or model string from the browser is ever used.
 */

export const AI_MODEL_STATES = ["ok", "none_configured", "platform_paused"] as const;
export type AiModelState = (typeof AI_MODEL_STATES)[number];

export type AiModelOption = {
  /** What the picker sends as `quality`. */
  tier: AiQualityTier;
  /** The exact model the server runs for this tier (from the allowlist). */
  model: AiModelId;
  label: string;
  hint: string;
  isDefault: boolean;
};

export type AiProviderModels = {
  provider: "openai";
  label: "OpenAI";
  /** Whose OpenAI key the calls run on. */
  source: "platform" | "byok";
  models: AiModelOption[];
};

export type AvailableAiModels = {
  state: AiModelState;
  /** Empty unless state is "ok". */
  providers: AiProviderModels[];
  /** A customer sentence for any state but "ok". */
  message?: string;
  /** Where to configure AI (for "none_configured"). */
  settingsPath?: string;
};

export const AI_SETTINGS_PATH = "/app/settings/ai";

/** Customer sentences (they pass isCustomerSentence: no provider or key names). */
export const AI_MODELS_MESSAGES = Object.freeze({
  none_configured:
    "AI isn't set up for this workspace yet. Add your own AI key under Settings → AI Providers, or contact support.",
  platform_paused: AI_MESSAGES.platformPaused,
});

export const AI_MODELS_UNAVAILABLE_MESSAGE =
  "Couldn't load the AI models for this workspace. Try again in a minute.";

/** The display name OpenAI gives each allowlisted model. */
const MODEL_LABEL: Readonly<Record<AiModelId, string>> = Object.freeze({
  "gpt-5-nano": "GPT-5 nano",
  "gpt-5-mini": "GPT-5 mini",
});

/** Pure: the options for page generation, for one key source. */
export function pageGenerationModelOptions(source: "platform" | "byok"): AiModelOption[] {
  const offered = AI_ROUTE_LIMITS.page_generation.tiers;
  return AI_QUALITY_TIERS.filter((tier) => offered.includes(tier)).map((tier) => {
    const model = modelForTier(tier);
    const base = AI_TIER_OPTIONS.find((o) => o.tier === tier)!;
    const hint =
      source === "byok" ? `${base.hint.split(". ")[0]}. Runs on this workspace's own key.` : base.hint;
    return {
      tier,
      model,
      label: `${MODEL_LABEL[model]} (${base.label})`,
      hint,
      isDefault: tier === AI_DEFAULT_TIER,
    };
  });
}

export type AiKeySituation = {
  /** The workspace has its own OpenAI key stored (existence only). */
  byokConfigured: boolean;
  /** The platform's OpenAI key is set on this Worker (existence only). */
  platformConfigured: boolean;
  /** ai_platform_settings.platform_ai_enabled (a missing row counts as off). */
  platformEnabled: boolean;
};

/** Pure: the contract from the key situation. */
export function availableModelsFor(k: AiKeySituation): AvailableAiModels {
  if (k.byokConfigured) {
    return {
      state: "ok",
      providers: [{ provider: "openai", label: "OpenAI", source: "byok", models: pageGenerationModelOptions("byok") }],
    };
  }
  if (!k.platformConfigured) {
    return {
      state: "none_configured",
      providers: [],
      message: AI_MODELS_MESSAGES.none_configured,
      settingsPath: AI_SETTINGS_PATH,
    };
  }
  if (!k.platformEnabled) {
    return { state: "platform_paused", providers: [], message: AI_MODELS_MESSAGES.platform_paused };
  }
  return {
    state: "ok",
    providers: [
      { provider: "openai", label: "OpenAI", source: "platform", models: pageGenerationModelOptions("platform") },
    ],
  };
}

type Reader = { from: (table: string) => any };

/** Read the key situation (service role; existence checks only) and derive the contract. */
export async function readAvailableAiModels(
  workspaceId: string,
  deps: { db?: Reader; env?: Record<string, string | undefined> } = {},
): Promise<AvailableAiModels> {
  const db = deps.db ?? (supabaseAdmin as unknown as Reader);
  const env = deps.env ?? process.env;
  const [secret, settings] = await Promise.all([
    // The ONE BYOK store (resolveAiKey reads the same secret). Its id only:
    // the value is never read here.
    db
      .from("workspace_secrets")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("key_name", "OPENAI_API_KEY")
      .maybeSingle(),
    db.from("ai_platform_settings").select("platform_ai_enabled").eq("id", true).maybeSingle(),
  ]);
  for (const r of [secret, settings]) {
    if (r?.error) throw new Error(`ai models read failed: ${r.error.message}`);
  }
  return availableModelsFor({
    byokConfigured: !!secret.data,
    platformConfigured: typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim().length > 0,
    platformEnabled: settings.data?.platform_ai_enabled === true,
  });
}

export const GetAvailableAiModelsInputSchema = z.object({ workspaceId: workspaceIdSchema }).strict();

/** The model picker's contract. Member-only; answers the documented shape or a customer sentence. */
export const getAvailableAiModels = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => GetAvailableAiModelsInputSchema.parse(d))
  .handler(async ({ data, context }): Promise<AvailableAiModels> => {
    try {
      await assertWorkspaceMember(data.workspaceId, context.userId);
      return await readAvailableAiModels(data.workspaceId);
    } catch (e) {
      throw new Error(customerMessage(e, AI_MODELS_UNAVAILABLE_MESSAGE));
    }
  });
