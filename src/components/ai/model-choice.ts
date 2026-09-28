import type { AiModelOption, AvailableAiModels } from "@/lib/ai-models.functions";

/**
 * THE MODEL PICKER'S RULES, pure so tests can drive them.
 *
 * The options come only from the server (getAvailableAiModels): grouped by
 * provider, only providers that are really configured for this workspace, and
 * nothing at all unless the state is "ok". The browser never holds a model
 * list of its own. What it sends back is the chosen option's TIER (the
 * `quality` field of createQuickPage / startGenerationJob); the server maps
 * the tier to the model again, so no model string from the browser is used.
 */

/** Every option the server offers, in its order ([] unless state is "ok"). */
export function modelOptions(available: AvailableAiModels | null | undefined): AiModelOption[] {
  if (!available || available.state !== "ok") return [];
  return available.providers.flatMap((p) => p.models);
}

/**
 * The tier to have selected: the current choice while it is still offered,
 * else the only option when there is exactly one, else the server's default,
 * else the first option. "" when nothing is offered (loading, not configured,
 * paused), which keeps every Generate button disabled.
 */
export function pickModelTier(
  available: AvailableAiModels | null | undefined,
  current: string,
): string {
  const options = modelOptions(available);
  if (options.length === 0) return "";
  if (options.some((o) => o.tier === current)) return current;
  if (options.length === 1) return options[0]!.tier;
  return (options.find((o) => o.isDefault) ?? options[0]!).tier;
}

/** The request field for a picked tier: only ever one of the two the server accepts. */
export function qualityForRequest(tier: string): "standard" | "premium" {
  return tier === "premium" ? "premium" : "standard";
}
