/**
 * App-side (Node/Workers) mirror of supabase/functions/_shared/ai-pricing.ts.
 *
 * TanStack server functions run in the app runtime and cannot import the Deno
 * edge-function module (it reads `Deno.env` at load). Keep the two in sync — they
 * are the single conceptual source of truth for the platform credit model:
 * clients buy credits; the platform resells OpenRouter inference at a markup.
 *
 * Tunable via env (same names as the edge module):
 *   AI_CREDIT_MARKUP, AI_CREDIT_VALUE_MICROS, PLATFORM_AI_MODEL
 */

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export const AI_CREDIT_MARKUP = Number(process.env.AI_CREDIT_MARKUP ?? "5");
export const AI_CREDIT_VALUE_MICROS = Number(process.env.AI_CREDIT_VALUE_MICROS ?? "10000");

// USD-micros per 1K tokens (a price of $P per 1M tokens == P * 1000 micros / 1K).
// Source: OpenRouter / Google Gemini pricing, June 2026.
export const MODEL_COST_PER_1K_MICROS: Record<string, { in: number; out: number }> = {
  "google/gemini-3.1-pro-preview": { in: 2000, out: 12000 },
  "google/gemini-3.5-flash": { in: 1500, out: 9000 },
  "google/gemini-3-flash-preview": { in: 500, out: 3000 },
  "google/gemini-3.1-flash-lite-preview": { in: 250, out: 1500 },
  default: { in: 2000, out: 12000 },
};

export const PLATFORM_MODEL_ALLOWLIST = [
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.5-flash",
  "google/gemini-3-flash-preview",
  "google/gemini-3.1-flash-lite-preview",
];

export const PLATFORM_DEFAULT_MODEL =
  process.env.PLATFORM_AI_MODEL ?? "google/gemini-3.1-pro-preview";

export function resolvePlatformModel(requested?: string): string {
  if (requested && PLATFORM_MODEL_ALLOWLIST.includes(requested)) return requested;
  return PLATFORM_DEFAULT_MODEL;
}

export function estimateCostMicros(model: string, promptTokens: number, completionTokens: number): number {
  const c = MODEL_COST_PER_1K_MICROS[model] ?? MODEL_COST_PER_1K_MICROS.default;
  return Math.round((promptTokens * c.in + completionTokens * c.out) / 1000);
}

export function creditsForCostMicros(costMicros: number): number {
  if (costMicros <= 0) return 0;
  return Math.max(1, Math.ceil((costMicros * AI_CREDIT_MARKUP) / AI_CREDIT_VALUE_MICROS));
}

export function creditsForUsage(model: string, promptTokens: number, completionTokens: number): number {
  return creditsForCostMicros(estimateCostMicros(model, promptTokens, completionTokens));
}
