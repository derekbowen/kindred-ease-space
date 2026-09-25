/**
 * An error whose message was written for the customer. Everything else that
 * escapes a server path — PostgREST text, constraint and column names, a
 * provider's error body, half a stack trace — is replaced by a generic
 * sentence at the boundary (customerMessage). Throw this only with one of the
 * fixed sentences below or another sentence written for a customer.
 *
 * Pure and client-safe.
 */
export class CustomerFacingError extends Error {
  /** Machine-readable reason, for logs and tests. Never shown to anyone. */
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "CustomerFacingError";
    this.code = code;
  }
}

/**
 * The one place a thrown error becomes something a tenant may read: a
 * CustomerFacingError passes through, anything else is logged in full for
 * ops (server log only) and replaced by `fallback`.
 */
export function customerMessage(e: unknown, fallback: string): string {
  if (e instanceof CustomerFacingError) return e.message;
  console.error(
    "[ai] internal error withheld from the customer:",
    e instanceof Error ? (e.stack ?? e.message) : String(e),
  );
  return fallback;
}

/** Fixed customer-facing sentences for every AI route. Provider text never reaches these. */
export const AI_MESSAGES = Object.freeze({
  unavailable: "AI is temporarily unavailable. Please try again in a few minutes.",
  notConfigured: "AI tools are not available right now. Contact support.",
  providerError: "The AI provider returned an error; try again or contact support.",
  timeout: "The AI provider took too long to respond. Try again in a minute.",
  providerBusy: "The AI provider is busy right now. Try again in a minute.",
  rateLimited: "Too many AI requests for this workspace right now. Wait a minute and try again.",
  platformPaused: "AI features are paused platform-wide right now. Try again later.",
  generationPaused: "Paused: page generation is paused platform-wide right now. Try again later.",
  budgetExhausted: "AI features have reached today's platform limit. Try again tomorrow.",
  workspaceBudgetExhausted:
    "This workspace has reached today's AI limit. Try again tomorrow, or contact support if you need more today.",
  outOfFunds:
    "This workspace has used up its included AI generation. Contact support to continue using this tool.",
  inProgress: "This AI request is already running. Refresh in a minute.",
  alreadyDone: "This AI request already ran. Start a new one.",
  refusal: "The AI declined this request. Try rephrasing it.",
  incomplete: "The AI response was cut off before it finished. Try a shorter request.",
  malformed: "The AI returned a response we could not use. Try again.",
  tooLong: "That request is too long for the AI. Shorten it and try again.",
});
