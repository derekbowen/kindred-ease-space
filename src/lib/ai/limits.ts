import { AI_DEFAULT_TIER, modelForTier, type AiModelId, type AiQualityTier } from "@/lib/ai/models";

/**
 * Per-route hard limits — ONE table, used by every AI call site through
 * runMeteredAiCall (src/lib/ai/spend.server.ts). Nothing a customer sends can
 * raise any of these: no input schema accepts a model, a token count, a
 * timeout or any other provider parameter.
 *
 * maxOutputTokens includes reasoning tokens (billed as output). timeoutMs is
 * the wall-clock ceiling for one provider call; the page-generation ceiling
 * MUST stay below STALE_RUNNING_MS (180 s, src/lib/generation.server.ts) so a
 * driver still waiting on the provider never looks abandoned.
 *
 * The daily briefing runs in the coach-briefing-cron Supabase function; its
 * Deno mirror (supabase/functions/_shared/openai.ts) carries the same numbers
 * and tests/ai-provider.test.ts keeps the two in step.
 */
export const AI_ROUTES = [
  "page_generation",
  "add_meta",
  "fix_thin_page",
  "add_internal_links",
  "seo_coach",
  "page_audit",
  "daily_briefing",
] as const;
export type AiRoute = (typeof AI_ROUTES)[number];

export type AiRouteLimit = {
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  /** Quality tiers this route may use. Only page generation offers premium. */
  readonly tiers: readonly AiQualityTier[];
};

export const AI_ROUTE_LIMITS: Readonly<Record<AiRoute, AiRouteLimit>> = Object.freeze({
  page_generation: Object.freeze({
    maxOutputTokens: 6000,
    timeoutMs: 120_000,
    tiers: Object.freeze(["standard", "premium"] as const),
  }),
  add_meta: Object.freeze({ maxOutputTokens: 800, timeoutMs: 30_000, tiers: Object.freeze(["standard"] as const) }),
  fix_thin_page: Object.freeze({ maxOutputTokens: 3000, timeoutMs: 90_000, tiers: Object.freeze(["standard"] as const) }),
  add_internal_links: Object.freeze({
    maxOutputTokens: 4000,
    timeoutMs: 90_000,
    tiers: Object.freeze(["standard"] as const),
  }),
  seo_coach: Object.freeze({ maxOutputTokens: 1200, timeoutMs: 60_000, tiers: Object.freeze(["standard"] as const) }),
  page_audit: Object.freeze({ maxOutputTokens: 1500, timeoutMs: 60_000, tiers: Object.freeze(["standard"] as const) }),
  daily_briefing: Object.freeze({
    maxOutputTokens: 1000,
    timeoutMs: 60_000,
    tiers: Object.freeze(["standard"] as const),
  }),
});

/** add_meta writes at most this many pages per confirmed action (one call each). */
export const ADD_META_MAX_PAGES = 20;

/**
 * The input a single call may carry, as an upper bound in tokens (see
 * estimateMaxInputTokens in spend.server.ts). Generous for every prompt the
 * app builds, far below the models' 272K input window, and part of the hold:
 * a request whose bound exceeds this is refused before anything is reserved.
 */
export const AI_MAX_INPUT_TOKENS = 64_000;

export function isAiRoute(value: unknown): value is AiRoute {
  return typeof value === "string" && (AI_ROUTES as readonly string[]).includes(value);
}

/**
 * The model a route runs on for a tier. A tier the route does not offer is a
 * programming error (the input schemas only admit tiers a UI offers), never a
 * silent downgrade or upgrade.
 */
export function routeModel(route: AiRoute, tier: AiQualityTier = AI_DEFAULT_TIER): AiModelId {
  const limits = AI_ROUTE_LIMITS[route];
  if (!limits) throw new Error(`unknown AI route: ${String(route)}`);
  if (!limits.tiers.includes(tier)) {
    throw new Error(`AI route ${route} does not offer the ${tier} tier`);
  }
  return modelForTier(tier);
}
