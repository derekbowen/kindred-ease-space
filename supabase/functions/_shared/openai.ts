// The ONE OpenAI wrapper a Supabase function may use — and only
// coach-briefing-cron uses it (tests/ai-source-guards.test.ts enforces both).
// The same official SDK and version as the Worker (package.json "openai"),
// the same pinned client and the same classification as
// src/lib/ai/openai.server.ts:
//   - baseURL, organization, project, admin key, webhook secret pinned, so no
//     environment variable can redirect the key; maxRetries 0; logger off;
//   - store: false, reasoning.effort "minimal", no temperature / top_p;
//   - max_output_tokens and the timeout from BRIEFING_LIMITS, which mirror
//     the daily_briefing row of the Worker's route table (1000 / 60 s);
//   - Structured Outputs (text.format json_schema, strict);
//   - the SDK timeout covers response headers only, so every call also
//     carries its own AbortSignal that stays armed while the body is read;
//   - errors never carry provider text out of here, and an auth failure logs
//     status, kind and request id only (OpenAI echoes a masked key fragment).
// Nothing here spends: the caller (coach-briefing-cron) reserves with
// ai_reserve first and settles with ai_settle after, exactly as the Worker.
import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "npm:openai@7.23.0";

export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
export const BRIEFING_MODEL = "gpt-5-nano";
export const BRIEFING_LIMITS = { maxOutputTokens: 1000, timeoutMs: 60_000 } as const;

export type Usage = { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number };
export type StructuredResult =
  | { ok: true; data: unknown; usage: Usage | null }
  | { ok: false; kind: string; sent: boolean; usage: Usage | null; httpStatus: number | null };

/** HTTP answers that reject a request before any generation (nothing billed); same set as the Worker's. */
export const REJECTED_BEFORE_GENERATION = new Set([400, 401, 403, 404, 409, 422, 429]);

function readUsage(u: any): Usage | null {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : NaN);
  if (!u || typeof u !== "object") return null;
  const inputTokens = n(u.input_tokens);
  const outputTokens = n(u.output_tokens);
  if (Number.isNaN(inputTokens) || Number.isNaN(outputTokens)) return null;
  const cached = n(u.input_tokens_details?.cached_tokens);
  const reasoning = n(u.output_tokens_details?.reasoning_tokens);
  return {
    inputTokens,
    cachedInputTokens: Number.isNaN(cached) ? 0 : Math.min(cached, inputTokens),
    outputTokens,
    reasoningTokens: Number.isNaN(reasoning) ? 0 : Math.min(reasoning, outputTokens),
  };
}

export async function callOpenAIStructured(opts: {
  apiKey: string;
  instructions: string;
  input: string;
  format: { name: string; schema: Record<string, unknown> };
}): Promise<StructuredResult> {
  let sent = false;
  let httpStatus: number | null = null;
  const tracked = async (input: string | URL | Request, init?: RequestInit) => {
    sent = true;
    const res = await globalThis.fetch(input, init);
    httpStatus = res.status;
    return res;
  };
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: OPENAI_API_BASE_URL,
    organization: null,
    project: null,
    adminAPIKey: null,
    webhookSecret: null,
    timeout: BRIEFING_LIMITS.timeoutMs,
    maxRetries: 0,
    logLevel: "off",
    fetch: tracked,
  });
  const signal = AbortSignal.timeout(BRIEFING_LIMITS.timeoutMs);
  let response: any;
  try {
    response = await client.responses.create(
      {
        model: BRIEFING_MODEL,
        instructions: opts.instructions,
        input: opts.input,
        max_output_tokens: BRIEFING_LIMITS.maxOutputTokens,
        store: false,
        reasoning: { effort: "minimal" },
        text: { format: { type: "json_schema", name: opts.format.name, schema: opts.format.schema, strict: true } },
      },
      { signal },
    );
  } catch (e) {
    if (e instanceof APIError && typeof e.status === "number") {
      const kind = e.status === 401 || e.status === 403 ? "auth" : e.status === 429 ? "rate_limited" : e.status >= 500 ? "server_error" : "bad_request";
      console.error(`[openai] ${kind} status=${e.status} request_id=${e.requestID ?? "-"}`);
      return { ok: false, kind, sent, usage: null, httpStatus: e.status };
    }
    const timedOut = e instanceof APIConnectionTimeoutError || e instanceof APIUserAbortError || signal.aborted;
    if (timedOut) {
      console.error(`[openai] timeout sent=${sent}`);
      return { ok: false, kind: "timeout", sent, usage: null, httpStatus };
    }
    if (e instanceof APIConnectionError) {
      console.error(`[openai] network sent=${sent}`);
      return { ok: false, kind: "network", sent, usage: null, httpStatus: null };
    }
    const malformed = httpStatus !== null && httpStatus >= 200 && httpStatus < 300;
    console.error(`[openai] ${malformed ? "malformed" : "unknown"} sent=${sent}`);
    return { ok: false, kind: malformed ? "malformed" : "unknown", sent, usage: null, httpStatus };
  }

  const usage = readUsage(response?.usage);
  const fail = (kind: string): StructuredResult => ({ ok: false, kind, sent: true, usage, httpStatus });
  if (response?.status === "incomplete") return fail("incomplete");
  if (response?.error || (response?.status && response.status !== "completed")) {
    return fail("failed");
  }
  const texts: string[] = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part?.type === "refusal") return fail("refusal");
      if (part?.type === "output_text" && typeof part.text === "string") texts.push(part.text);
    }
  }
  const text = texts.join("");
  if (!text.trim()) return fail("empty");
  try {
    return { ok: true, data: JSON.parse(text), usage };
  } catch {
    return fail("malformed");
  }
}
