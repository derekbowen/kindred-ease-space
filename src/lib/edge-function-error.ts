/**
 * The sentence an edge function put in its JSON error body.
 *
 * supabase.functions.invoke turns every non-2xx answer into a
 * FunctionsHttpError whose message is "Edge Function returned a non-2xx
 * status code" — which userMessage rightly refuses to show — and whose
 * `context` is the Response. create-checkout answers its refusals with
 * `{ error, message }` ("Referral tracking needs the Integration API
 * connection…", "This workspace already has an active plan…"), so without
 * this the customer only ever read the generic fallback.
 *
 * Returns an Error carrying the body's `message` when there is one, otherwise
 * the original error — either way for userMessage() to judge. Pure; safe in
 * the browser.
 */
export async function edgeFunctionError(error: unknown): Promise<unknown> {
  const ctx = (error as { context?: unknown } | null)?.context as Response | undefined;
  if (ctx && typeof ctx.clone === "function") {
    try {
      const body = (await ctx.clone().json()) as { message?: unknown } | null;
      if (body && typeof body.message === "string" && body.message.trim()) {
        return new Error(body.message.trim());
      }
    } catch {
      // Not JSON: fall through to the original error.
    }
  }
  return error;
}
