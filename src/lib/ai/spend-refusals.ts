/**
 * The spend refusals decided BEFORE the provider call that leave the request
 * id unspent — nothing was held, or the hold was released — so the same id
 * may be reserved again later. These are the CustomerFacingError codes
 * runMeteredAiCall (src/lib/ai/spend.server.ts) throws for them.
 *
 * A batch item refused this way keeps its attempt (round-4 correctness M1):
 * the attempt budget bounds provider calls, and none was made. Not here:
 * in_progress / done / conflict (the id is someone else's or already spent),
 * and every failure at or after the provider call.
 *
 * Pure and client-safe (generation.functions.ts is reachable from the
 * client graph; the spend flow is not).
 */
export const SPEND_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "insufficient",
  "budget_exhausted",
  "workspace_budget_exhausted",
  "platform_paused",
  "generation_paused",
  "rate_limited",
  "mark_refused",
]);
