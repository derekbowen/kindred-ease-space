// Deno mirror of src/lib/ai-pricing.ts, for the one Supabase function that
// makes OpenAI requests (coach-briefing-cron). OpenAI list prices, Standard
// tier, verified 2026-09-25 at https://developers.openai.com/api/docs/pricing.
// USD micros (1 USD = 1_000_000) per 1M tokens. tests/ai-provider.test.ts
// checks these rows are identical to the Worker's table.
//
// The briefing is billed 'system' (the platform's own feature: the global
// ceiling only, never a customer's credits), so no credit math lives here.

export type ModelPrice = { input: number; cachedInput: number; output: number };

export const MODEL_PRICES_MICROS_PER_1M: Record<string, ModelPrice> = {
  "gpt-5-nano": { input: 50_000, cachedInput: 5_000, output: 400_000 },
  "gpt-5-mini": { input: 250_000, cachedInput: 25_000, output: 2_000_000 },
  // Unknown model: priced as the most expensive allowlisted one.
  default: { input: 250_000, cachedInput: 25_000, output: 2_000_000 },
};

export function priceFor(model: string): ModelPrice {
  return MODEL_PRICES_MICROS_PER_1M[model] ?? MODEL_PRICES_MICROS_PER_1M.default;
}

const tokens = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
};

export function costMicrosForUsage(
  model: string,
  usage: { inputTokens: number; cachedInputTokens?: number; outputTokens: number },
): number {
  const p = priceFor(model);
  const input = tokens(usage.inputTokens);
  const cached = Math.min(tokens(usage.cachedInputTokens), input);
  const output = tokens(usage.outputTokens);
  return Math.ceil(((input - cached) * p.input + cached * p.cachedInput + output * p.output) / 1_000_000);
}

export function maxCostMicros(model: string, maxInputTokens: number, maxOutputTokens: number): number {
  return costMicrosForUsage(model, { inputTokens: maxInputTokens, cachedInputTokens: 0, outputTokens: maxOutputTokens });
}

/** Same bound as the Worker's estimateMaxInputTokens: tokens never exceed UTF-8 bytes. */
export function estimateMaxInputTokens(instructions: string, input: string, schema?: Record<string, unknown>): number {
  const bytes = (s: string) => new TextEncoder().encode(String(s ?? "")).length;
  let total = bytes(instructions) + bytes(input) + 16;
  if (schema) total += bytes(JSON.stringify(schema)) + 64;
  return total + 1024;
}
