// Central AI pricing + credit model for the platform (resold) AI path.
//
// Business model: clients buy credits; the platform holds one OpenRouter key and
// resells inference at a markup. There is NO hard cap — when credits run out the
// client tops up (ideally via auto-recharge). The only "limit" is the client's
// own balance, which they can refill at any time.
//
// Tunable via env so pricing can change without a code edit:
//   AI_CREDIT_MARKUP       multiple applied to raw provider cost (default 5)
//   AI_CREDIT_VALUE_MICROS USD-micros that one credit represents at retail
//                          (default 10_000 => 1 credit = $0.01, i.e. 100 credits = $1)
//   PLATFORM_AI_MODEL      default OpenRouter model id for the platform path

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export const AI_CREDIT_MARKUP = Number(Deno.env.get("AI_CREDIT_MARKUP") ?? "5");
export const AI_CREDIT_VALUE_MICROS = Number(Deno.env.get("AI_CREDIT_VALUE_MICROS") ?? "10000");

// Provider token prices in USD-micros per 1K tokens (1 USD = 1_000_000 micros).
// Source: OpenRouter / Google Gemini API pricing, June 2026.
// A price of $P per 1M tokens == P * 1000 micros per 1K tokens.
export const MODEL_COST_PER_1K_MICROS: Record<string, { in: number; out: number }> = {
  // --- Gemini 3.x (OpenRouter ids) ---
  "google/gemini-3.1-pro-preview": { in: 2000, out: 12000 },
  "google/gemini-3.5-flash": { in: 1500, out: 9000 },
  "google/gemini-3-flash-preview": { in: 500, out: 3000 },
  "google/gemini-3.1-flash-lite-preview": { in: 250, out: 1500 },
  // --- legacy / BYOK estimates (kept for cost logging on other providers) ---
  "gpt-5-mini": { in: 250, out: 2000 },
  "gpt-4o-mini": { in: 150, out: 600 },
  "claude-haiku-4-5": { in: 1000, out: 5000 },
  "gemini-2.5-flash": { in: 300, out: 2500 },
  default: { in: 2000, out: 12000 }, // assume Pro-tier so we never under-bill
};

// Platform models a caller may select. Anything else falls back to the default —
// this prevents a client from forcing an exotic/expensive model we don't price.
export const PLATFORM_MODEL_ALLOWLIST = [
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.5-flash",
  "google/gemini-3-flash-preview",
  "google/gemini-3.1-flash-lite-preview",
];

// Default per the product decision: Gemini 3.1 Pro for everything (highest quality).
// Override per-deployment with PLATFORM_AI_MODEL, or per-call within the allowlist.
export const PLATFORM_DEFAULT_MODEL =
  Deno.env.get("PLATFORM_AI_MODEL") ?? "google/gemini-3.1-pro-preview";

export function resolvePlatformModel(requested?: string): string {
  if (requested && PLATFORM_MODEL_ALLOWLIST.includes(requested)) return requested;
  return PLATFORM_DEFAULT_MODEL;
}

/** Raw provider cost (no markup) in USD-micros for a given model + token usage. */
export function estimateCostMicros(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const c = MODEL_COST_PER_1K_MICROS[model] ?? MODEL_COST_PER_1K_MICROS.default;
  return Math.round((promptTokens * c.in + completionTokens * c.out) / 1000);
}

/** Credits to charge the client for a given raw provider cost (cost × markup ÷ credit value). */
export function creditsForCostMicros(costMicros: number): number {
  if (costMicros <= 0) return 0;
  return Math.max(1, Math.ceil((costMicros * AI_CREDIT_MARKUP) / AI_CREDIT_VALUE_MICROS));
}

/** Convenience: credits for a model + token usage. */
export function creditsForUsage(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  return creditsForCostMicros(estimateCostMicros(model, promptTokens, completionTokens));
}

/** Rough pre-call credit estimate (no tokenizer): ~4 chars/token + assumed completion. */
export function estimateCreditsBeforeCall(
  model: string,
  promptChars: number,
  maxTokens?: number,
): number {
  const promptTokens = Math.ceil(promptChars / 4);
  const completionTokens = maxTokens ?? 1024;
  return creditsForUsage(model, promptTokens, completionTokens);
}
