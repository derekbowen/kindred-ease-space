/**
 * THE model policy. The only OpenAI models founders.click may send a request
 * to, and the only way a caller can influence which one: a quality TIER, never
 * a model name. Pure and client-safe (no I/O, no secrets) so a picker can show
 * tier labels, but the mapping from tier to model happens on the server only.
 *
 *   standard → gpt-5-nano   the default for every AI route
 *   premium  → gpt-5-mini   an explicit, optional choice where a UI offers a
 *                           quality choice (page generation). Never automatic:
 *                           nothing escalates a request to premium on its own.
 *
 * The database enforces the same allowlist (ai_spend_reservations CHECK and
 * ai_reserve, migration 20260925000800), so a model outside this list cannot
 * even be reserved for.
 */

export const AI_MODELS = ["gpt-5-nano", "gpt-5-mini"] as const;
export type AiModelId = (typeof AI_MODELS)[number];

export const AI_QUALITY_TIERS = ["standard", "premium"] as const;
export type AiQualityTier = (typeof AI_QUALITY_TIERS)[number];

export const AI_DEFAULT_TIER: AiQualityTier = "standard";

const TIER_MODEL: Readonly<Record<AiQualityTier, AiModelId>> = Object.freeze({
  standard: "gpt-5-nano",
  premium: "gpt-5-mini",
});

export const AI_DEFAULT_MODEL: AiModelId = TIER_MODEL.standard;

/**
 * The lowest reasoning effort OpenAI documents for the GPT-5 family
 * ("Reasoning.effort supports: minimal, low, medium, and high" — model page
 * for gpt-5; gpt-5-mini and gpt-5-nano share it). Reasoning tokens still count
 * toward max_output_tokens and are billed as output, so every limit below is
 * sized with that in mind. Sampling parameters (temperature, top_p) are never
 * sent: reasoning models reject them.
 */
export const AI_REASONING_EFFORT = "minimal" as const;

export function isAllowedModel(value: unknown): value is AiModelId {
  return typeof value === "string" && (AI_MODELS as readonly string[]).includes(value);
}

export function isQualityTier(value: unknown): value is AiQualityTier {
  return typeof value === "string" && (AI_QUALITY_TIERS as readonly string[]).includes(value);
}

/**
 * Tier → model. Exhaustive over the tier enum and never a fallback: an
 * unknown tier is a programming error (the input schemas only admit the
 * enum), so it throws instead of quietly picking a model.
 */
export function modelForTier(tier: AiQualityTier): AiModelId {
  const model = TIER_MODEL[tier];
  if (!model) throw new Error(`unknown AI quality tier: ${String(tier)}`);
  return model;
}

/**
 * The tier a stored, server-resolved model belongs to (a batch job records
 * the model it was started with). null for anything outside the allowlist —
 * the caller refuses such a job; it never maps it to a model.
 */
export function tierForModel(model: unknown): AiQualityTier | null {
  for (const tier of AI_QUALITY_TIERS) if (TIER_MODEL[tier] === model) return tier;
  return null;
}

/** Customer-facing labels for a quality picker. No model names, no prices. */
export const AI_TIER_OPTIONS: ReadonlyArray<{ tier: AiQualityTier; label: string; hint: string }> =
  Object.freeze([
    {
      tier: "standard",
      label: "Standard",
      hint: "Fast and economical. The default for every page.",
    },
    {
      tier: "premium",
      label: "Premium",
      hint: "Stronger writing for important pages. Uses more of your included AI.",
    },
  ]);
