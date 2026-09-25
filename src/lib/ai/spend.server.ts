import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { AI_MAX_INPUT_TOKENS, AI_ROUTE_LIMITS, routeModel, type AiRoute } from "@/lib/ai/limits";
import { AI_DEFAULT_TIER, type AiModelId, type AiQualityTier } from "@/lib/ai/models";
import { costMicrosForUsage, creditsForCostMicros, maxCostMicros } from "@/lib/ai-pricing";
import {
  OpenAiPreSendError,
  callOpenAI,
  type AiInput,
  type AiUsage,
  type OpenAiFailureKind,
  type OpenAiResult,
  type OpenAiSuccess,
  type OpenAiTransport,
  type StructuredFormat,
} from "@/lib/ai/openai.server";
import { AI_MESSAGES, CustomerFacingError } from "@/lib/ai/customer-error";
import { getWorkspaceSecretWithSource } from "@/lib/workspace-secrets.server";

/**
 * THE AI spend flow. Every AI call the Worker makes goes through
 * runMeteredAiCall; nothing else calls the provider module
 * (tests/ai-source-guards.test.ts enforces both). The nine steps:
 *
 *   1. authenticate   — the server fn's requireSupabaseAuth (a user id is
 *                       required here for every customer call);
 *   2. authorize      — the caller's assertWorkspaceMember/Owner, re-checked
 *                       by ai_reserve (the user must be a member of the
 *                       workspace the spend is charged to);
 *   3. model + limits — routeModel(route, tier) and AI_ROUTE_LIMITS; nothing
 *                       from the request body can change either;
 *   4. reserve        — ai_reserve holds the MAXIMUM cost (every input token
 *                       uncached, every allowed output token) atomically:
 *                       rate limit, kill switch, the workspace's daily cost
 *                       cap, tenant funds, global ceiling. Refused → a fixed
 *                       customer sentence, nothing called;
 *   5. mark           — ai_mark_called, then the caller's beforeCall (page
 *                       generation marks its daily-cap slot there), then the
 *                       request: the provider is called only on a definite
 *                       true from both. The hold is marked FIRST so a refused
 *                       mark (kill switch, pause, expiry) never spends a
 *                       daily-cap slot (round-4 L7); a beforeCall that fails
 *                       after the hold was marked settles it at zero
 *                       (not_sent: nothing left, the customer refunded);
 *   6. call           — callOpenAI (openai.server.ts), typed result;
 *   7. deliver        — the route writes its result (page, audit, edit);
 *                       cost from the usage OpenAI reported;
 *   8. settle         — ai_settle, on two separate books (settleInputFor):
 *                       the CUSTOMER pays only for a delivered result (the
 *                       actual cost capped at the hold; the whole hold when
 *                       the usage is unknown) and is refunded in full for
 *                       every failure; the PLATFORM BUDGET records what
 *                       OpenAI may have been paid;
 *   9. release        — any failure BEFORE the call releases the hold in full
 *                       (ai_release). After the call nothing is ever
 *                       released: failures settle (refunding the customer).
 *
 * The platform budget errs in the safe direction: a timeout or a network
 * error after the request left, a 5xx, another 4xx, or a success without
 * usage keep the full hold (OpenAI may have done — and billed — the work). A
 * request that provably never left (fetch not invoked) or that OpenAI
 * rejected before generation (400, 401, 403, 404, 409, 422, 429) records
 * zero; reported usage records its cost. If a settle RPC itself fails the
 * row stays 'called' and the reaper settles it (full hold on the budget, the
 * customer refunded) within 35 minutes; if a release fails the reaper
 * releases it within 15. Refunds never touch the anti-abuse counters: every
 * reservation counts toward the workspace's per-minute rate limit, and page
 * generation's daily-cap slot stays spent once marked.
 *
 * NEVER import from client code.
 */

export type AiRpcResult = { data: unknown; error: { message: string; code?: string } | null };
/** The one database capability the flow needs: supabase-js .rpc(name, args). */
export type AiDb = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<AiRpcResult> };

const serviceDb = (): AiDb => supabaseAdmin as unknown as AiDb;

export type AiKey = { apiKey: string; source: "byok" | "platform" };
/**
 * What the caller asks for. 'internal' is never asked for: ai_reserve itself
 * reserves a 'tenant' or 'granted' call of a workspace holding the founder /
 * internal unlimited entitlement as billing 'internal' (000800, reading the
 * 000700 predicate under its lock) — no caller can claim it.
 */
export type AiBillingClass = "tenant" | "granted" | "byok" | "system";
export type SpendBilling = "free_quota" | "credits" | "granted" | "internal" | "byok" | "system";

export const RESERVE_STATUSES = [
  "reserved",
  "in_progress",
  "done",
  "conflict",
  "rate_limited",
  "platform_paused",
  "generation_paused",
  "workspace_budget_exhausted",
  "budget_exhausted",
  "insufficient",
] as const;
export type ReserveStatus = (typeof RESERVE_STATUSES)[number];
export type ReserveRefusal = Exclude<ReserveStatus, "reserved">;

/** Refusals that leave the request id unspent (see spend-refusals.ts, round-4 M1). */
export { SPEND_REFUSAL_CODES } from "@/lib/ai/spend-refusals";

const SPEND_BILLINGS: readonly SpendBilling[] = ["free_quota", "credits", "granted", "internal", "byok", "system"];

export type ReserveResult = {
  status: ReserveStatus;
  billing: SpendBilling | null;
  holdSeq: number | null;
  creditsCharged: number | null;
};

export type AiSettlement = {
  /** false when the settle RPC failed: the row stays 'called' and the reaper settles it (full hold on the budget, the customer refunded). */
  settled: boolean;
  billing: SpendBilling;
  creditsCharged: number;
  costMicros: number | null;
  fullHold: boolean;
};

// ---------------------------------------------------------------------------
// Keys and billing class
// ---------------------------------------------------------------------------

/**
 * The OpenAI key a workspace's AI calls run on: its own (BYOK — the ONE
 * store, the workspace secret OPENAI_API_KEY) or the platform's Worker secret
 * OPENAI_API_KEY. A vault read error fails closed (throws) instead of quietly
 * switching a BYOK workspace onto the platform key. No key at all is a
 * customer-facing refusal, before anything is reserved.
 */
export async function resolveAiKey(workspaceId: string, db?: AiDb): Promise<AiKey> {
  const found = await getWorkspaceSecretWithSource(workspaceId, "OPENAI_API_KEY", "OPENAI_API_KEY", db);
  if (!found) throw new CustomerFacingError(AI_MESSAGES.notConfigured, "no_key");
  return { apiKey: found.key, source: found.source };
}

/**
 * Who pays for a call: the workspace's own key (byok); the beta grant, which
 * includes PAGE GENERATION only (granted); otherwise the tenant's free quota
 * or credits (tenant). ai_reserve re-enforces the same policy.
 */
export function billingClassFor(key: AiKey, opts: { route: AiRoute; granted?: boolean }): AiBillingClass {
  if (key.source === "byok") return "byok";
  if (opts.route === "page_generation" && opts.granted) return "granted";
  return "tenant";
}

// ---------------------------------------------------------------------------
// The four RPCs
// ---------------------------------------------------------------------------

/** Strictly parse ai_reserve's answer. Anything unexpected is an error — never 'reserved'. */
export function parseReserveResult(data: unknown): ReserveResult {
  const d = data as Record<string, unknown> | null;
  const status = d && typeof d === "object" ? d.status : undefined;
  if (typeof status !== "string" || !(RESERVE_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`ai_reserve returned an unexpected value: ${JSON.stringify(data)}`);
  }
  const billing = typeof d!.billing === "string" && (SPEND_BILLINGS as readonly string[]).includes(d!.billing)
    ? (d!.billing as SpendBilling)
    : null;
  if (status === "reserved" && !billing) {
    throw new Error(`ai_reserve reserved without a billing mode: ${JSON.stringify(data)}`);
  }
  return {
    status: status as ReserveStatus,
    billing,
    holdSeq: typeof d!.hold_seq === "number" ? d!.hold_seq : null,
    creditsCharged: typeof d!.credits_charged === "number" ? d!.credits_charged : null,
  };
}

export async function aiReserve(
  db: AiDb,
  a: {
    workspaceId: string;
    requestId: string;
    userId: string | null;
    route: AiRoute;
    source: string;
    model: AiModelId;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxCostMicros: number;
    maxCredits: number;
    billingClass: AiBillingClass;
  },
): Promise<ReserveResult> {
  const { data, error } = await db.rpc("ai_reserve", {
    _workspace_id: a.workspaceId,
    _request_id: a.requestId,
    _user_id: a.userId,
    _feature: a.route,
    _source: a.source,
    _model: a.model,
    _max_input_tokens: a.maxInputTokens,
    _max_output_tokens: a.maxOutputTokens,
    _max_cost_micros: a.maxCostMicros,
    _max_credits: a.maxCredits,
    _billing_class: a.billingClass,
  });
  if (error) throw new Error(`ai_reserve failed: ${error.message}`);
  return parseReserveResult(data);
}

/** True only for the held → called transition. Throws on an RPC error (the caller must not call the provider). */
export async function aiMarkCalled(db: AiDb, workspaceId: string, requestId: string): Promise<boolean> {
  const { data, error } = await db.rpc("ai_mark_called", {
    _workspace_id: workspaceId,
    _request_id: requestId,
  });
  if (error) throw new Error(`ai_mark_called failed: ${error.message}`);
  return data === true;
}

/**
 * Give a hold back (only while it is still held — the database refuses
 * anything else). Best effort: a failure is logged, never thrown over the
 * error that caused the release; the reaper releases the hold within 15
 * minutes either way.
 */
export async function aiRelease(db: AiDb, workspaceId: string, requestId: string): Promise<boolean> {
  try {
    const { data, error } = await db.rpc("ai_release", {
      _workspace_id: workspaceId,
      _request_id: requestId,
    });
    if (error) throw new Error(error.message);
    return data === true;
  } catch (e) {
    console.error(
      "[ai-spend] could not release a hold (the reaper will)",
      JSON.stringify({ workspaceId, requestId, error: e instanceof Error ? e.message : String(e) }),
    );
    return false;
  }
}

export type SettleInput = {
  usage: AiUsage | null;
  /** The platform cost. null = unknown: the full hold is kept on the platform budget. */
  costMicros: number | null;
  /** What a DELIVERED result costs the customer (0 on failure; null with costMicros null). */
  credits: number | null;
  outcome: "ok" | "failed";
  /** A short failure code (a-z and _ only); never provider text. */
  error: string | null;
};

export async function aiSettle(
  db: AiDb,
  workspaceId: string,
  requestId: string,
  s: SettleInput,
): Promise<{ status: string; billing: SpendBilling | null; creditsCharged: number; costMicros: number | null; fullHold: boolean }> {
  const { data, error } = await db.rpc("ai_settle", {
    _workspace_id: workspaceId,
    _request_id: requestId,
    _input_tokens: s.usage?.inputTokens ?? null,
    _cached_input_tokens: s.usage?.cachedInputTokens ?? null,
    _output_tokens: s.usage?.outputTokens ?? null,
    _reasoning_tokens: s.usage?.reasoningTokens ?? null,
    _cost_micros: s.costMicros,
    _credits: s.costMicros === null ? null : s.credits,
    _outcome: s.outcome,
    _error: s.error,
  });
  if (error) throw new Error(`ai_settle failed: ${error.message}`);
  const d = (data ?? {}) as Record<string, unknown>;
  const billing =
    typeof d.billing === "string" && (SPEND_BILLINGS as readonly string[]).includes(d.billing)
      ? (d.billing as SpendBilling)
      : null;
  return {
    status: typeof d.status === "string" ? d.status : "unknown",
    billing,
    creditsCharged: typeof d.credits_charged === "number" ? d.credits_charged : 0,
    costMicros: typeof d.cost_micros === "number" ? d.cost_micros : null,
    fullHold: d.full_hold === true,
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type RefusalMessages = Partial<Record<ReserveRefusal | "mark_refused", string>>;

export function refusalMessage(status: ReserveRefusal | "mark_refused", overrides?: RefusalMessages): string {
  const custom = overrides?.[status];
  if (custom) return custom;
  switch (status) {
    case "in_progress":
      return AI_MESSAGES.inProgress;
    case "done":
    case "conflict":
      return AI_MESSAGES.alreadyDone;
    case "rate_limited":
      return AI_MESSAGES.rateLimited;
    case "platform_paused":
      return AI_MESSAGES.platformPaused;
    case "generation_paused":
      return AI_MESSAGES.generationPaused;
    case "workspace_budget_exhausted":
      return AI_MESSAGES.workspaceBudgetExhausted;
    case "budget_exhausted":
      return AI_MESSAGES.budgetExhausted;
    case "insufficient":
      return AI_MESSAGES.outOfFunds;
    case "mark_refused":
      return AI_MESSAGES.unavailable;
  }
}

export function failureMessage(kind: OpenAiFailureKind): string {
  switch (kind) {
    case "incomplete":
      return AI_MESSAGES.incomplete;
    case "refusal":
      return AI_MESSAGES.refusal;
    case "malformed":
    case "schema_mismatch":
    case "empty":
    case "failed":
      return AI_MESSAGES.malformed;
    case "auth":
    case "bad_request":
      return AI_MESSAGES.notConfigured;
    case "rate_limited":
      return AI_MESSAGES.providerBusy;
    case "timeout":
      return AI_MESSAGES.timeout;
    case "server_error":
    case "network":
    case "unknown":
      return AI_MESSAGES.providerError;
  }
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

const utf8Bytes = (s: string) => new TextEncoder().encode(String(s ?? "")).length;

/**
 * An upper bound on the input tokens a request can be billed for. OpenAI's
 * tokenizers are byte-level BPE: every token covers at least one byte, so a
 * text never has more tokens than UTF-8 bytes. Added on top: a per-message
 * allowance for the role framing, the JSON Schema a Structured Outputs call
 * injects, and 1024 tokens for anything the platform adds around a request.
 * Deliberately generous — the hold is refunded down to the actual cost.
 */
export function estimateMaxInputTokens(
  instructions: string,
  input: AiInput,
  schema?: Record<string, unknown>,
): number {
  let total = utf8Bytes(instructions);
  if (typeof input === "string") total += utf8Bytes(input) + 16;
  else for (const m of input) total += utf8Bytes(m.content) + 16;
  if (schema) total += utf8Bytes(JSON.stringify(schema)) + 64;
  return total + 1024;
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

export type OutputCheck<T> = (output: OpenAiSuccess<T>) => { code: string; message: string } | null;

export type MeteredAiCall<T> = {
  workspaceId: string;
  /** The authenticated user; null only for the platform's own daily briefing. */
  userId: string | null;
  /** A uuid. Client-kept where the flow already has one, deterministic where it is, fresh otherwise. */
  requestId: string;
  route: AiRoute;
  /** Label for the usage log (quick_page, batch_generation, add_meta, …). */
  source: string;
  tier?: AiQualityTier;
  key: AiKey;
  billingClass: AiBillingClass;
  instructions: string;
  input: AiInput;
  format?: StructuredFormat<T>;
  /**
   * Rules the answer must meet beyond its schema (a page body long enough, a
   * link actually added). A failed check is still a paid call: it settles
   * with the reported usage, then throws the check's own sentence.
   */
  check?: OutputCheck<T>;
  /**
   * Hands the result to the customer — writes the page, the audit, the edit —
   * BEFORE the settlement, because the customer is charged only for a
   * delivered result. A throw here settles the call as 'failed'
   * (not_delivered: the customer is refunded, the platform budget keeps what
   * OpenAI reported) and is rethrown. Routes whose answer goes straight back
   * to the browser (the SEO coach) have nothing to deliver here.
   */
  deliver?: (output: OpenAiSuccess<T>, ctx: { billing: SpendBilling; model: AiModelId }) => Promise<void>;
  /**
   * Awaited after the hold is granted AND marked, immediately before the
   * provider call (page generation marks its daily-cap slot here, so a
   * refused hold mark never spends a slot). A throw aborts without calling
   * the provider: the marked hold is settled at zero (not_sent — nothing
   * left, the customer refunded in full) and the error is rethrown.
   */
  beforeCall?: () => Promise<void>;
  refusalMessages?: RefusalMessages;
  deps?: { db?: AiDb; transport?: OpenAiTransport };
};

export type MeteredAiResult<T> = {
  output: OpenAiSuccess<T>;
  model: AiModelId;
  billing: SpendBilling;
  settlement: AiSettlement;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * HTTP answers that reject a request before any generation happens, so the
 * provider billed nothing: bad request, bad key, forbidden, not found,
 * conflict, unprocessable, rate limited. Any other failure without reported
 * usage (a 5xx, another 4xx, a timeout or a network error after the request
 * left) is unknown and is kept at the full hold on the platform budget.
 */
export const REJECTED_BEFORE_GENERATION: ReadonlySet<number> = new Set([400, 401, 403, 404, 409, 422, 429]);

/**
 * What ai_settle is told, on its two books (see migration 000800):
 *   - the customer is charged only when a result is delivered (outcome
 *     'ok'); every failure — provider 4xx/5xx, timeout, network error,
 *     refusal, incomplete, malformed or schema-invalid output, a result the
 *     route rejects (check), a result that could not be saved (deliver) — is
 *     outcome 'failed' and refunds the customer in full;
 *   - the platform budget records what the provider may have been paid:
 *     the reported usage's cost when known, 0 for a request that never left
 *     or was rejected before generation, the full hold (cost null) when
 *     unknown.
 */
export function settleInputFor<T>(model: AiModelId, r: OpenAiResult<T>, checkCode: string | null): SettleInput {
  const cost = (u: AiUsage) => costMicrosForUsage(model, u);
  if (r.ok && !checkCode) {
    // Delivered: the customer pays the actual cost (the full hold when the
    // usage is unknown).
    if (!r.usage) return { usage: null, costMicros: null, credits: null, outcome: "ok", error: "usage_missing" };
    const c = cost(r.usage);
    return { usage: r.usage, costMicros: c, credits: creditsForCostMicros(c), outcome: "ok", error: null };
  }
  // Not delivered: the customer is refunded; only the platform budget moves.
  const error = checkCode ?? (r.ok ? "failed" : r.sent ? r.kind : "not_sent");
  const usage = r.usage;
  if (usage) return { usage, costMicros: cost(usage), credits: 0, outcome: "failed", error };
  if (!r.ok && (!r.sent || (r.httpStatus !== null && REJECTED_BEFORE_GENERATION.has(r.httpStatus)))) {
    return { usage: null, costMicros: 0, credits: 0, outcome: "failed", error };
  }
  return { usage: null, costMicros: null, credits: null, outcome: "failed", error };
}

export async function runMeteredAiCall<T = unknown>(call: MeteredAiCall<T>): Promise<MeteredAiResult<T>> {
  const db = call.deps?.db ?? serviceDb();
  const ctx = { workspaceId: call.workspaceId, requestId: call.requestId, route: call.route };

  // 1–3. Identity, and everything that is decided without a reservation.
  if (!UUID.test(call.requestId)) throw new Error("runMeteredAiCall: requestId must be a uuid");
  if (call.billingClass !== "system" && !call.userId) {
    throw new Error("runMeteredAiCall: a customer call needs the authenticated user");
  }
  if (!call.key?.apiKey) throw new CustomerFacingError(AI_MESSAGES.notConfigured, "no_key");
  const model = routeModel(call.route, call.tier ?? AI_DEFAULT_TIER);
  const limits = AI_ROUTE_LIMITS[call.route];
  const maxInputTokens = estimateMaxInputTokens(call.instructions, call.input, call.format?.schema);
  if (maxInputTokens > AI_MAX_INPUT_TOKENS) {
    throw new CustomerFacingError(AI_MESSAGES.tooLong, "input_too_long");
  }
  const holdMicros = maxCostMicros(model, maxInputTokens, limits.maxOutputTokens);

  // 4. The hold.
  const reserved = await aiReserve(db, {
    workspaceId: call.workspaceId,
    requestId: call.requestId,
    userId: call.userId,
    route: call.route,
    source: call.source,
    model,
    maxInputTokens,
    maxOutputTokens: limits.maxOutputTokens,
    maxCostMicros: holdMicros,
    maxCredits: call.billingClass === "tenant" ? Math.max(1, creditsForCostMicros(holdMicros)) : 0,
    billingClass: call.billingClass,
  });
  if (reserved.status !== "reserved") {
    console.warn("[ai-spend] reservation refused", JSON.stringify({ ...ctx, status: reserved.status }));
    throw new CustomerFacingError(refusalMessage(reserved.status, call.refusalMessages), reserved.status);
  }
  const billing = reserved.billing!;

  // 5. The mark, then the caller's last step, then the call. The hold is
  //    marked FIRST: a refused mark (the kill switch, the pause, an expired
  //    hold) releases the hold before beforeCall runs, so page generation's
  //    daily-cap slot — marked in beforeCall — is never spent without a call.
  let marked: boolean;
  try {
    marked = await aiMarkCalled(db, call.workspaceId, call.requestId);
  } catch (e) {
    // Unknown whether the mark landed: release (a no-op on a called row). A
    // mark that did land is settled by the reaper (the customer refunded).
    await aiRelease(db, call.workspaceId, call.requestId);
    throw e;
  }
  if (!marked) {
    await aiRelease(db, call.workspaceId, call.requestId);
    console.warn("[ai-spend] mark refused; provider not called", JSON.stringify(ctx));
    throw new CustomerFacingError(refusalMessage("mark_refused", call.refusalMessages), "mark_refused");
  }
  try {
    if (call.beforeCall) await call.beforeCall();
  } catch (e) {
    // The hold is marked, so it is settled, never released: at zero — the
    // request provably never left — refunding the customer in full.
    const notSent: OpenAiResult<T> = {
      ok: false,
      kind: "unknown",
      detail: null,
      sent: false,
      usage: null,
      httpStatus: null,
      requestId: null,
    };
    await settleSafely(db, call, model, billing, settleInputFor(model, notSent, null));
    throw e;
  }

  // 6. The call. From here on the request is settled, never released.
  let result: OpenAiResult<T>;
  try {
    result = await callOpenAI<T>({
      apiKey: call.key.apiKey,
      model,
      instructions: call.instructions,
      input: call.input,
      maxOutputTokens: limits.maxOutputTokens,
      timeoutMs: limits.timeoutMs,
      format: call.format,
      transport: call.deps?.transport,
    });
  } catch (e) {
    // callOpenAI throws on purpose only for its pre-send checks
    // (OpenAiPreSendError): nothing left, so the platform budget records
    // zero. Anything else escaped at an unknown point, possibly after the
    // request left: the platform budget keeps the full hold (round-4 L6).
    // The customer is refunded either way.
    const preSend = e instanceof OpenAiPreSendError;
    result = { ok: false, kind: "unknown", detail: null, sent: !preSend, usage: null, httpStatus: null, requestId: null };
    await settleSafely(db, call, model, billing, settleInputFor(model, result, null));
    throw e;
  }

  const checked = result.ok && call.check ? call.check(result) : null;

  // 7. Deliver before settling: the customer pays only for a result that
  //    reached them. A failed delivery settles as not_delivered (refunded).
  let undelivered: { error: unknown } | null = null;
  if (result.ok && !checked && call.deliver) {
    try {
      await call.deliver(result, { billing, model });
    } catch (e) {
      undelivered = { error: e };
    }
  }

  // 8. Record what it cost and settle.
  const failCode = checked?.code ?? (undelivered ? "not_delivered" : null);
  const settlement = await settleSafely(db, call, model, billing, settleInputFor(model, result, failCode));

  if (!result.ok) {
    throw new CustomerFacingError(failureMessage(result.kind), result.kind);
  }
  if (checked) throw new CustomerFacingError(checked.message, checked.code);
  if (undelivered) throw undelivered.error;
  return { output: result, model, billing, settlement };
}

async function settleSafely<T>(
  db: AiDb,
  call: MeteredAiCall<T>,
  model: AiModelId,
  billing: SpendBilling,
  input: SettleInput,
): Promise<AiSettlement> {
  try {
    const s = await aiSettle(db, call.workspaceId, call.requestId, input);
    if (s.status !== "settled" && s.status !== "already_settled") {
      throw new Error(`ai_settle answered ${s.status}`);
    }
    return {
      settled: true,
      billing: s.billing ?? billing,
      creditsCharged: s.creditsCharged,
      costMicros: s.costMicros,
      fullHold: s.fullHold,
    };
  } catch (e) {
    // The provider has been paid and the hold covers it: the reaper settles
    // this row (full hold on the platform budget). Loud and greppable.
    console.error(
      "[ai-spend] UNSETTLED call (the reaper settles it within 35 minutes)",
      JSON.stringify({
        workspaceId: call.workspaceId,
        requestId: call.requestId,
        route: call.route,
        model,
        costMicros: input.costMicros,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return { settled: false, billing, creditsCharged: 0, costMicros: input.costMicros, fullHold: false };
  }
}
