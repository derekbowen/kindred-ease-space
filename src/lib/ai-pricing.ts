import { AI_MODELS, type AiModelId } from "@/lib/ai/models";

/**
 * The pricing table for every AI call founders.click makes: OpenAI list prices
 * for the two allowlisted models, and the credit math customers are charged
 * in. Pure (env reads only) so it runs in the Worker and in tests alike.
 *
 * Source: https://developers.openai.com/api/docs/pricing — Standard tier,
 * verified 2026-09-25:
 *   gpt-5-nano  input $0.05 / cached input $0.005 / output $0.40  per 1M tokens
 *   gpt-5-mini  input $0.25 / cached input $0.025 / output $2.00  per 1M tokens
 * Reasoning tokens are billed as output tokens. The Deno mirror used by the
 * daily briefing (supabase/functions/_shared/ai-pricing.ts) carries the same
 * numbers; tests/ai-provider.test.ts keeps the two identical.
 *
 * Credit model (unchanged): credits = ceil(cost_micros × AI_CREDIT_MARKUP ÷
 * AI_CREDIT_VALUE_MICROS), at least 1 for any non-zero cost. Tunable through
 * the two env vars; anything that is not a positive number falls back to the
 * default rather than turning every price into NaN.
 */

export const AI_PRICE_SOURCE =
  "https://developers.openai.com/api/docs/pricing (Standard tier, verified 2026-09-25)";

/** USD micros (1 USD = 1_000_000) per 1M tokens. */
export type ModelPrice = { input: number; cachedInput: number; output: number };

export const MODEL_PRICES_MICROS_PER_1M: Readonly<Record<AiModelId | "default", ModelPrice>> =
  Object.freeze({
    "gpt-5-nano": Object.freeze({ input: 50_000, cachedInput: 5_000, output: 400_000 }),
    "gpt-5-mini": Object.freeze({ input: 250_000, cachedInput: 25_000, output: 2_000_000 }),
    // An unknown model is priced as the most expensive allowlisted one, so a
    // mistake can only ever over-reserve, never under-reserve.
    default: Object.freeze({ input: 250_000, cachedInput: 25_000, output: 2_000_000 }),
  });

function positiveFromEnv(name: string, fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

export const AI_CREDIT_MARKUP = positiveFromEnv("AI_CREDIT_MARKUP", 5);
export const AI_CREDIT_VALUE_MICROS = positiveFromEnv("AI_CREDIT_VALUE_MICROS", 10_000);

export function priceFor(model: string): ModelPrice {
  return (AI_MODELS as readonly string[]).includes(model)
    ? MODEL_PRICES_MICROS_PER_1M[model as AiModelId]
    : MODEL_PRICES_MICROS_PER_1M.default;
}

const tokens = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
};

export type TokenUsage = {
  inputTokens: number;
  /** Part of inputTokens served from the prompt cache (billed at the cached rate). */
  cachedInputTokens?: number;
  /** Includes reasoning tokens. */
  outputTokens: number;
};

/** What a call actually cost, in USD micros, rounded up. */
export function costMicrosForUsage(model: string, usage: TokenUsage): number {
  const p = priceFor(model);
  const input = tokens(usage.inputTokens);
  const cached = Math.min(tokens(usage.cachedInputTokens), input);
  const output = tokens(usage.outputTokens);
  const scaled = (input - cached) * p.input + cached * p.cachedInput + output * p.output;
  return Math.ceil(scaled / 1_000_000);
}

/**
 * The most a call can cost: every input token uncached, every allowed output
 * token used. This is what a spend hold reserves before the provider is
 * called.
 */
export function maxCostMicros(model: string, maxInputTokens: number, maxOutputTokens: number): number {
  return costMicrosForUsage(model, {
    inputTokens: maxInputTokens,
    cachedInputTokens: 0,
    outputTokens: maxOutputTokens,
  });
}

export function creditsForCostMicros(costMicros: number): number {
  const c = Number(costMicros);
  if (!Number.isFinite(c) || c <= 0) return 0;
  return Math.max(1, Math.ceil((c * AI_CREDIT_MARKUP) / AI_CREDIT_VALUE_MICROS));
}

/** Credits for a model and token usage (cost hints, estimates). */
export function creditsForUsage(model: string, inputTokens: number, outputTokens: number): number {
  return creditsForCostMicros(costMicrosForUsage(model, { inputTokens, outputTokens }));
}
