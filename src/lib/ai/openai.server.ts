import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import type {
  Response as OpenAiResponse,
  ResponseCreateParamsNonStreaming,
} from "openai/resources/responses/responses";
import { AI_DEFAULT_MODEL, AI_REASONING_EFFORT, isAllowedModel, type AiModelId } from "@/lib/ai/models";

/**
 * THE OpenAI provider module. The only file in the Worker that constructs an
 * OpenAI client (tests/ai-source-guards.test.ts enforces it), and it is called
 * from exactly two places: runMeteredAiCall (src/lib/ai/spend.server.ts),
 * which never calls it without a successful spend reservation, and the
 * zero-token key check (verifyOpenAiKey, a models.retrieve).
 *
 * What every request carries, verified against openai@7.23.0's type
 * definitions (resources/responses/responses.d.ts, client.d.ts):
 *   - an allowlisted model (models.ts) — anything else throws before a client
 *     exists;
 *   - max_output_tokens from the route table (limits.ts), which includes
 *     reasoning tokens;
 *   - store: false, reasoning.effort "minimal", and NO temperature / top_p
 *     (reasoning models reject sampling parameters);
 *   - text.format = { type: "json_schema", name, strict: true, schema } when
 *     the route expects structured data; the parsed value is then validated
 *     by the caller's own schema (zod) before anyone sees it.
 *
 * The client is pinned: baseURL, organization, project, admin key and webhook
 * secret are passed explicitly so no environment variable (OPENAI_BASE_URL,
 * OPENAI_ORG_ID, …) can redirect the key; maxRetries 0 (retries belong to the
 * spend flow, where each one is a new reservation); logLevel "off" (the SDK
 * logger would otherwise decide what to print).
 *
 * The SDK's `timeout` covers only the wait for response HEADERS — its timer
 * is cleared once fetch resolves (client.js fetchWithTimeout). A body that
 * stalls after the headers would hang, so every call also passes its own
 * AbortSignal.timeout, which the SDK keeps attached while the body is read.
 *
 * Errors: an APIError's message embeds the provider's text, and for a 401
 * OpenAI echoes a masked fragment of the key. Nothing here logs an error
 * message for auth failures — only status, kind and request id — and every
 * other logged message is redacted and truncated. Nothing here throws
 * provider text: the result is a typed value the caller maps to a fixed
 * customer sentence.
 */

export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Test seam: where requests go. Production code never passes one. */
export type OpenAiTransport = { fetch?: FetchLike; baseURL?: string };

export type AiMessage = { role: "user" | "assistant"; content: string };
export type AiInput = string | AiMessage[];

/** A strict JSON Schema for Structured Outputs plus the validator for what comes back. */
export type StructuredFormat<T> = {
  /** a-z, A-Z, 0-9, underscores and dashes, at most 64 characters. */
  name: string;
  schema: Record<string, unknown>;
  /** Validate the parsed JSON (the route's own zod schema). null = mismatch. */
  parse: (value: unknown) => T | null;
};

export type AiUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  /** Includes reasoningTokens. */
  outputTokens: number;
  reasoningTokens: number;
};

export type OpenAiFailureKind =
  | "incomplete"
  | "refusal"
  | "malformed"
  | "schema_mismatch"
  | "empty"
  | "failed"
  | "auth"
  | "bad_request"
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "network"
  | "unknown";

export type OpenAiCall<T> = {
  apiKey: string;
  model: AiModelId;
  instructions: string;
  input: AiInput;
  maxOutputTokens: number;
  timeoutMs: number;
  format?: StructuredFormat<T>;
  transport?: OpenAiTransport;
  log?: (line: string) => void;
};

export type OpenAiSuccess<T> = {
  ok: true;
  text: string;
  /** The validated structured value when a format was requested; null otherwise. */
  data: T | null;
  /** null when the API did not report usage (the caller then settles at the full hold). */
  usage: AiUsage | null;
  requestId: string | null;
  responseId: string | null;
};

export type OpenAiFailure = {
  ok: false;
  kind: OpenAiFailureKind;
  /** e.g. the incomplete reason ("max_output_tokens", "content_filter"). Never provider prose. */
  detail: string | null;
  /** Whether a request left this process at all (fetch was invoked). */
  sent: boolean;
  /** Reported usage when the API answered with a response object. */
  usage: AiUsage | null;
  httpStatus: number | null;
  requestId: string | null;
};

export type OpenAiResult<T> = OpenAiSuccess<T> | OpenAiFailure;

const FORMAT_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Strip a key (and anything shaped like one) from text bound for a log line. */
export function redactSecrets(text: string, apiKey?: string | null): string {
  let out = String(text ?? "");
  if (apiKey && apiKey.length >= 6) out = out.split(apiKey).join("[redacted-key]");
  return out.replace(/sk-[A-Za-z0-9_*\-]{3,}/g, "sk-[redacted]");
}

function makeClient(apiKey: string, timeoutMs: number, transport: OpenAiTransport | undefined, onFetch?: {
  sent: () => void;
  response: (status: number) => void;
}): OpenAI {
  const base: FetchLike = transport?.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const tracked: FetchLike = async (input, init) => {
    onFetch?.sent();
    const res = await base(input, init);
    onFetch?.response(res.status);
    return res;
  };
  return new OpenAI({
    apiKey,
    baseURL: transport?.baseURL ?? OPENAI_API_BASE_URL,
    organization: null,
    project: null,
    adminAPIKey: null,
    webhookSecret: null,
    timeout: timeoutMs,
    maxRetries: 0,
    logLevel: "off",
    fetch: tracked,
  });
}

function readUsage(u: OpenAiResponse["usage"] | undefined): AiUsage | null {
  if (!u || typeof u !== "object") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : NaN);
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

function isAbortLike(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * One Responses API call. Never throws for a provider outcome: every result,
 * success or failure, comes back typed, with `sent` (did a request leave) and
 * the usage the API reported whenever it reported any. Throws only for a
 * programming error caught before anything is sent (a model outside the
 * allowlist, an invalid format name, a missing key).
 */
export async function callOpenAI<T = unknown>(call: OpenAiCall<T>): Promise<OpenAiResult<T>> {
  if (!isAllowedModel(call.model)) throw new Error(`model not on the allowlist: ${String(call.model)}`);
  if (!call.apiKey) throw new Error("callOpenAI: no API key");
  if (!(call.maxOutputTokens > 0) || !(call.timeoutMs > 0)) {
    throw new Error("callOpenAI: maxOutputTokens and timeoutMs are required");
  }
  if (call.format && !FORMAT_NAME.test(call.format.name)) {
    throw new Error(`callOpenAI: invalid structured format name ${call.format.name}`);
  }
  const log = call.log ?? ((line: string) => console.error(line));
  const tag = `[openai] model=${call.model}`;

  let sent = false;
  let httpStatus: number | null = null;
  const client = makeClient(call.apiKey, call.timeoutMs, call.transport, {
    sent: () => {
      sent = true;
    },
    response: (status) => {
      httpStatus = status;
    },
  });

  const body: ResponseCreateParamsNonStreaming = {
    model: call.model,
    instructions: call.instructions,
    input:
      typeof call.input === "string"
        ? call.input
        : call.input.map((m) => ({ role: m.role, content: m.content })),
    max_output_tokens: call.maxOutputTokens,
    store: false,
    reasoning: { effort: AI_REASONING_EFFORT },
    ...(call.format
      ? {
          text: {
            format: {
              type: "json_schema" as const,
              name: call.format.name,
              schema: call.format.schema,
              strict: true,
            },
          },
        }
      : {}),
  };

  const signal = AbortSignal.timeout(call.timeoutMs);
  let response: OpenAiResponse;
  let requestId: string | null = null;
  try {
    const { data, request_id } = await client.responses.create(body, { signal }).withResponse();
    response = data;
    requestId = request_id ?? null;
  } catch (e) {
    return classifyError(e, { sent, httpStatus, signal, log, tag, apiKey: call.apiKey });
  }

  const usage = readUsage(response?.usage);
  const responseId = typeof response?.id === "string" ? response.id : null;
  const fail = (kind: OpenAiFailureKind, detail: string | null = null): OpenAiFailure => {
    log(`${tag} ${kind}${detail ? ` (${detail})` : ""} request_id=${requestId ?? "-"}`);
    return { ok: false, kind, detail, sent: true, usage, httpStatus, requestId };
  };

  if (!response || typeof response !== "object") return fail("malformed", "no response object");
  if (response.status === "incomplete") {
    return fail("incomplete", response.incomplete_details?.reason ?? "unknown");
  }
  if (response.error || (response.status && response.status !== "completed")) {
    return fail("failed", response.error?.code ?? String(response.status));
  }

  const texts: string[] = [];
  let refused = false;
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (item?.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part?.type === "output_text" && typeof part.text === "string") texts.push(part.text);
      else if (part?.type === "refusal") refused = true;
    }
  }
  if (refused) return fail("refusal");
  const text = texts.join("");
  if (!text.trim()) return fail("empty");

  if (!call.format) {
    return { ok: true, text, data: null, usage, requestId, responseId };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail("malformed", "output is not JSON");
  }
  const data = call.format.parse(json);
  if (data === null || data === undefined) return fail("schema_mismatch");
  return { ok: true, text, data, usage, requestId, responseId };
}

function classifyError(
  e: unknown,
  ctx: {
    sent: boolean;
    httpStatus: number | null;
    signal: AbortSignal;
    log: (line: string) => void;
    tag: string;
    apiKey: string;
  },
): OpenAiFailure {
  const base = { detail: null, usage: null, sent: ctx.sent };
  if (e instanceof APIError && typeof e.status === "number") {
    const status = e.status;
    const requestId = e.requestID ?? null;
    const kind: OpenAiFailureKind =
      status === 401 || status === 403
        ? "auth"
        : status === 429
          ? "rate_limited"
          : status >= 500
            ? "server_error"
            : "bad_request";
    if (kind === "auth") {
      // OpenAI's 401 body echoes a masked fragment of the key: status, kind
      // and request id only.
      ctx.log(`${ctx.tag} auth status=${status} request_id=${requestId ?? "-"}`);
    } else {
      const msg = redactSecrets(e.message, ctx.apiKey).slice(0, 300);
      ctx.log(
        `${ctx.tag} ${kind} status=${status} type=${e.type ?? "-"} code=${e.code ?? "-"} request_id=${requestId ?? "-"}: ${msg}`,
      );
    }
    return { ...base, ok: false, kind, httpStatus: status, requestId };
  }
  if (e instanceof APIConnectionTimeoutError || ctx.signal.aborted || (e instanceof APIUserAbortError)) {
    ctx.log(`${ctx.tag} timeout sent=${ctx.sent}`);
    return { ...base, ok: false, kind: "timeout", httpStatus: ctx.httpStatus, requestId: null };
  }
  if (isAbortLike(e)) {
    ctx.log(`${ctx.tag} timeout (abort) sent=${ctx.sent}`);
    return { ...base, ok: false, kind: "timeout", httpStatus: ctx.httpStatus, requestId: null };
  }
  if (e instanceof APIConnectionError) {
    const cause = redactSecrets(String((e as { cause?: unknown }).cause ?? e.message), ctx.apiKey).slice(0, 200);
    ctx.log(`${ctx.tag} network sent=${ctx.sent}: ${cause}`);
    return { ...base, ok: false, kind: "network", httpStatus: null, requestId: null };
  }
  // A 2xx whose body was not a readable JSON response object (a proxy page, a
  // truncated stream): the provider may have done the work.
  if (ctx.httpStatus !== null && ctx.httpStatus >= 200 && ctx.httpStatus < 300) {
    ctx.log(`${ctx.tag} malformed body status=${ctx.httpStatus}`);
    return { ...base, ok: false, kind: "malformed", httpStatus: ctx.httpStatus, requestId: null };
  }
  const msg = redactSecrets(e instanceof Error ? e.message : String(e), ctx.apiKey).slice(0, 200);
  ctx.log(`${ctx.tag} unknown sent=${ctx.sent}: ${msg}`);
  return { ...base, ok: false, kind: ctx.sent ? "unknown" : "network", httpStatus: ctx.httpStatus, requestId: null };
}

export type KeyCheck = { ok: true } | { ok: false; reason: "invalid_key" | "no_access" | "unavailable" };

/**
 * Is this key usable for the default model? One models.retrieve call: no
 * tokens are generated, so nothing is spent and nothing is reserved. Used by
 * the (hidden) AI Providers page's "Test key" button for a workspace's own
 * key only.
 */
export async function verifyOpenAiKey(apiKey: string, transport?: OpenAiTransport): Promise<KeyCheck> {
  if (!apiKey) return { ok: false, reason: "invalid_key" };
  const client = makeClient(apiKey, 15_000, transport);
  try {
    await client.models.retrieve(AI_DEFAULT_MODEL, { signal: AbortSignal.timeout(15_000) });
    return { ok: true };
  } catch (e) {
    const status = e instanceof APIError ? e.status : undefined;
    const requestId = e instanceof APIError ? (e.requestID ?? "-") : "-";
    console.error(`[openai] key check failed status=${status ?? "-"} request_id=${requestId}`);
    if (status === 401) return { ok: false, reason: "invalid_key" };
    if (status === 403 || status === 404) return { ok: false, reason: "no_access" };
    return { ok: false, reason: "unavailable" };
  }
}
