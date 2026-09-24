import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  OPENROUTER_BASE,
  PLATFORM_MODEL_ALLOWLIST,
  creditsForUsage,
  resolvePlatformModel,
} from "@/lib/ai-pricing";
import { getWorkspaceSecretWithSource } from "@/lib/workspace-secrets.server";
import {
  findUniqueTenantSlug,
  getActiveTemplateId,
  slugifyPage,
} from "@/lib/tenant-page-helpers.server";
import { checkPageBeforePublish, type ContractCheck } from "@/lib/seo/page-contract.server";

/**
 * Shared page-generation core. The Quick Page Builder, the Opportunity Engine
 * and the batch "Generate Content" job all run through here so there is ONE
 * prompt, ONE inventory-grounding rule, ONE metering path and ONE model policy.
 *
 * Ordering matters and is the whole point of this module:
 *   0. resolveBillingMode    — who pays, decided BEFORE anything is spent:
 *      BYOK (the customer's own provider bill), a beta grant (included), or
 *      the platform key — which must be able to pay for a whole page, not
 *      merely hold a positive balance.
 *   1. generatePageContent  — the AI call. Nothing is charged here. A failed
 *      generation costs the customer nothing and a retry does not pay twice.
 *   2. persistGeneratedPage — the draft row. Never auto-publishes.
 *   3. settleGeneration     — charges the platform quota/credits ONLY now,
 *      and reports honestly: a deduction that did not happen is recorded as
 *      'unbilled', never as a charge.
 *
 * The pure helpers at the top have no I/O so tests can import this file
 * without a database or network (supabaseAdmin is a lazy proxy).
 *
 * NEVER import from client code.
 */

// ---------------------------------------------------------------------------
// Pure helpers (no I/O)
// ---------------------------------------------------------------------------

/**
 * Cheapest allowlisted model. The old default ('google/gemini-2.5-flash') was
 * not on the allowlist, so resolvePlatformModel silently swapped it for the
 * Pro-tier default and customers paid ~4x for "flash".
 */
export const GENERATION_DEFAULT_MODEL = "google/gemini-3-flash-preview";

/** A typical city page: ~1.5K prompt tokens (brief + inventory) and ~1.5K out. */
export const TYPICAL_PAGE_TOKENS = { prompt: 1500, completion: 1500 };

/** Credits one page is likely to cost on a platform key, for the cost hint. */
export function estimatedCreditsPerPage(model: string): number {
  return creditsForUsage(model, TYPICAL_PAGE_TOKENS.prompt, TYPICAL_PAGE_TOKENS.completion);
}

/** Human labels + a one-line cost hint per allowlisted model, for pickers. */
export const GENERATION_MODEL_OPTIONS: Array<{ id: string; label: string; hint: string }> = [
  {
    id: "google/gemini-3.1-flash-lite-preview",
    label: "Gemini 3.1 Flash Lite",
    note: "lightest, shorter copy",
  },
  { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash", note: "fast and cheap" },
  { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash", note: "balanced" },
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", note: "best quality" },
]
  .filter((m) => PLATFORM_MODEL_ALLOWLIST.includes(m.id))
  .map((m) => ({
    id: m.id,
    label: m.label,
    hint: `${m.note} — about ${estimatedCreditsPerPage(m.id)} credit${estimatedCreditsPerPage(m.id) === 1 ? "" : "s"} per page on the platform key`,
  }));

/**
 * The model ids a customer may ask for, as a tuple for z.enum. Anything else
 * is rejected at the input boundary: an unknown id must never be "resolved"
 * to the most expensive model on the customer's behalf.
 */
export const GENERATION_MODEL_IDS = GENERATION_MODEL_OPTIONS.map((m) => m.id) as [
  string,
  ...string[],
];

/**
 * Stable identity for a batch target. Batch items are idempotent by THIS key,
 * never by slug — slugs get suffixed on collision (findUniqueTenantSlug) so
 * two runs for the same city would otherwise produce austin, austin-2, ...
 */
export function buildTargetKey(t: { city: string; state?: string | null }): string {
  const city = String(t.city ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  const state = String(t.state ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return `city:${city}|${state}`;
}

const normPlace = (s: unknown) =>
  String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

/**
 * Does an existing page cover this city? The single eligibility predicate the
 * Page Builder, the batch target list and the pre-generation duplicate check
 * all share. City must match; when BOTH sides carry a state the states must
 * match too (Portland, OR must not hide Portland, ME). A page with no state
 * recorded is taken to cover the city in any state — the conservative choice,
 * since the alternative is generating a second page for the same place.
 */
export function pageCoversCity(
  page: { city?: string | null; state?: string | null },
  target: { city: string; state?: string | null },
): boolean {
  const pc = normPlace(page.city);
  if (!pc || pc !== normPlace(target.city)) return false;
  const ps = normPlace(page.state);
  const ts = normPlace(target.state);
  if (ps && ts) return ps === ts;
  return true;
}

export type CityTargetInput = {
  city: string;
  state: string | null;
  listingCount: number;
  hasPage: boolean;
};

export type GenerationTarget = CityTargetInput & { targetKey: string };

/**
 * Which cities deserve a page: enough published listings to render a
 * non-thin page, and no page for that city yet. The order is by inventory
 * size so the highest-value gaps come first.
 */
export function selectTargets(
  context: { cities: CityTargetInput[] },
  minListings = 3,
): GenerationTarget[] {
  const seen = new Set<string>();
  const out: GenerationTarget[] = [];
  for (const c of context.cities ?? []) {
    if (!c.city || !String(c.city).trim()) continue;
    if (c.hasPage) continue;
    if ((c.listingCount ?? 0) < minListings) continue;
    const targetKey = buildTargetKey(c);
    if (seen.has(targetKey)) continue;
    seen.add(targetKey);
    out.push({ ...c, targetKey });
  }
  return out.sort((a, b) => b.listingCount - a.listingCount);
}

/** Pages a workspace may still generate today. Never negative. */
export function dailyCapRemaining(cap: number, consumedLast24h: number): number {
  const c = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0;
  const d = Number.isFinite(consumedLast24h) ? Math.max(0, Math.floor(consumedLast24h)) : 0;
  return Math.max(0, c - d);
}

export const DAILY_CAP_WINDOW_MS = 24 * 3600_000;

/**
 * The daily cap is a RESERVATION, not a tally of finished pages: an item that
 * is queued or being written has already been promised a slot, so it counts
 * the moment it exists. Otherwise two browser tabs could each start a job
 * that fits the cap and together overrun it. Failed and skipped items release
 * their slot; done items hold it for the rest of the window.
 *
 * The count itself lives in the database — generation_consumed_last_24h in
 * migration 20260924000600 — so the app and the reservation RPC can never
 * disagree; this list documents the statuses that SQL counts, and the test
 * suite holds the two together.
 */
export const DAILY_CAP_COUNTED_STATUSES = ["done", "running", "pending"] as const;

/**
 * An error whose message was written for the customer. Everything else that
 * escapes the pipeline — PostgREST text, constraint and column names, half a
 * stack trace — is replaced by a generic sentence at the boundary, see
 * customerMessage. Throw this for the refusals a customer is meant to read
 * (no key, out of funds, paused, daily cap, provider error, thin output).
 */
export class CustomerFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerFacingError";
  }
}

export const GENERATION_UNAVAILABLE_MESSAGE =
  "Generation is temporarily unavailable. Please try again in a few minutes.";

/**
 * The one place a thrown error becomes something a tenant may read: a
 * CustomerFacingError passes through, anything else is logged in full for
 * ops and replaced by `fallback`. Nothing stored in generation_items.error or
 * thrown to the browser may carry database or provider text.
 */
export function customerMessage(e: unknown, fallback: string): string {
  if (e instanceof CustomerFacingError) return e.message;
  console.error(
    "[generation] internal error withheld from the customer:",
    e instanceof Error ? (e.stack ?? e.message) : String(e),
  );
  return fallback;
}

/**
 * The usage a page is billed for. A provider that omits usage (0 tokens both
 * ways) is billed as a typical page, never as nothing: once the free quota is
 * gone, a zero-usage page must not become a free page. `assumed` tells the
 * caller to log that the numbers are an estimate.
 */
export function billableUsage(
  promptTokens: number,
  completionTokens: number,
): { promptTokens: number; completionTokens: number; assumed: boolean } {
  const p = Number.isFinite(promptTokens) ? Math.max(0, Math.floor(promptTokens)) : 0;
  const c = Number.isFinite(completionTokens) ? Math.max(0, Math.floor(completionTokens)) : 0;
  if (p + c > 0) return { promptTokens: p, completionTokens: c, assumed: false };
  return {
    promptTokens: TYPICAL_PAGE_TOKENS.prompt,
    completionTokens: TYPICAL_PAGE_TOKENS.completion,
    assumed: true,
  };
}

/**
 * A stable request id for a generation that has a natural identity but no
 * browser-kept id — the coach's "create a page for this insight". SHA-256 of
 * the seed, first 16 bytes, with the version-4 and variant bits set so it
 * passes the same z.string().uuid() gate as a browser-generated id. Same seed
 * → same id, so a double-click replays the page that exists instead of
 * drafting a second one.
 */
export async function deterministicRequestId(seed: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
  );
  const b = digest.slice(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Did a settlement write lose to a concurrent one for the same page? Either
 * the unique_violation code or the settlement index named in the message:
 * PostgREST relays both, and the index name survives a driver that drops the
 * code.
 */
export function isSettlementConflict(
  e: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!e) return false;
  if (e.code === "23505") return true;
  return /credit_ledger_generation_settlement_uidx/.test(String(e.message ?? ""));
}

/**
 * The pause switch as ops actually set it. The seed is a JSON boolean, but a
 * hand edit through the dashboard easily lands as the string "true" — that
 * must pause too. Anything else (false, "false", missing, garbage) is "not
 * paused"; a READ failure is handled by the caller and fails closed.
 */
export function isGenerationPaused(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return false;
}

/**
 * How many times one item may be attempted before it is failed for good. A
 * provider that keeps erroring on one city must not be retried forever; the
 * fourth attempt is refused with a clear message instead of a claim. Policy
 * refusals (paused, cap, no credits) do NOT consume an attempt — they cost
 * nothing and clear on their own.
 */
export const MAX_ITEM_ATTEMPTS = 3;

export function attemptsExhausted(attempts: number | null | undefined): boolean {
  return (Number(attempts) || 0) >= MAX_ITEM_ATTEMPTS;
}

export type ExistingItemLike = {
  target_key: string;
  status: string;
  page_id: string | null;
  updated_at?: string | null;
  attempts?: number | null;
};

export type JobPlan = {
  /** No item yet: insert one. */
  create: string[];
  /** Existing item the new job may (re)drive — the union of reattachBy. */
  reattach: string[];
  reattachBy: {
    /** pending / failed / skipped: idle, safe to move. */
    idle: string[];
    /** running but untouched for STALE_RUNNING_MS: the driver is gone. */
    staleRunning: string[];
    /** done, but the draft was deleted (page_id nulled by the FK): generate again. */
    pageDeleted: string[];
  };
  /** done with a live draft: reused as-is, never regenerated, never charged again. */
  alreadyDone: string[];
  /** running and fresh: another driver has it RIGHT NOW. Never reset — that is how two pages and two charges happen. */
  inProgress: string[];
  /** MAX_ITEM_ATTEMPTS reached without a page: refused until support resets it. */
  exhausted: string[];
};

/**
 * Decide what a new job does with each requested key, given the workspace's
 * existing items (UNIQUE on workspace_id + target_key):
 *   - done + page          → alreadyDone (reused; NOT regenerated, NOT charged again)
 *   - done + page deleted  → reattach (pageDeleted) — the target is generatable again
 *   - running, fresh       → inProgress — left alone
 *   - running, stale       → reattach (staleRunning)
 *   - pending/failed/skipped, attempts < MAX → reattach (idle)
 *   - attempts >= MAX      → exhausted
 *   - unknown              → create
 */
export function planJobItems(
  requestedKeys: string[],
  existing: ExistingItemLike[],
  now = Date.now(),
): JobPlan {
  const byKey = new Map(existing.map((e) => [e.target_key, e]));
  const plan: JobPlan = {
    create: [],
    reattach: [],
    reattachBy: { idle: [], staleRunning: [], pageDeleted: [] },
    alreadyDone: [],
    inProgress: [],
    exhausted: [],
  };
  const seen = new Set<string>();
  for (const key of requestedKeys) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const item = byKey.get(key);
    if (!item) {
      plan.create.push(key);
      continue;
    }
    if (item.status === "done") {
      if (item.page_id) plan.alreadyDone.push(key);
      else {
        plan.reattach.push(key);
        plan.reattachBy.pageDeleted.push(key);
      }
      continue;
    }
    if (item.status === "running" && !isStaleRunning(item.updated_at, now)) {
      plan.inProgress.push(key);
      continue;
    }
    if (attemptsExhausted(item.attempts)) {
      plan.exhausted.push(key);
      continue;
    }
    plan.reattach.push(key);
    if (item.status === "running") plan.reattachBy.staleRunning.push(key);
    else plan.reattachBy.idle.push(key);
  }
  return plan;
}

/** Running items older than this are treated as abandoned and retried. */
export const STALE_RUNNING_MS = 3 * 60_000;

/**
 * Hard ceiling on one provider call. It MUST be shorter than STALE_RUNNING_MS:
 * a driver that is still waiting on the provider must never look abandoned,
 * or a second driver reclaims the item and generates the page twice.
 */
export const OPENROUTER_TIMEOUT_MS = 120_000;

export function isStaleRunning(updatedAt: string | null | undefined, now = Date.now()): boolean {
  if (!updatedAt) return true;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return true;
  return now - t > STALE_RUNNING_MS;
}

/**
 * Can the platform key pay for ONE page? Free trial quota first; once that is
 * gone the purchased balance must cover a whole page at this model's price.
 * A balance of 1 credit against a 5-credit page used to pass ("> 0") and the
 * deduction then failed silently — generation for free, forever.
 * A missing quota row means the RPC will create one with the default free
 * allowance on first consume, so null counts as "free quota available".
 */
export function hasPlatformFunds(p: {
  freeQuotaRemaining: number | null;
  balance: number | null;
  model: string;
}): boolean {
  const freeLeft = p.freeQuotaRemaining === null ? true : p.freeQuotaRemaining > 0;
  if (freeLeft) return true;
  return (Number(p.balance) || 0) >= estimatedCreditsPerPage(p.model);
}

export type BillingMode = "byok" | "granted" | "platform";
export type SettleBilling = "byok" | "granted" | "free_quota" | "credits" | "unbilled";
/** generation_items.billing_status */
export type ItemBillingStatus = "pending" | "charged" | "free" | "unbilled";

/** What an item's billing_status must say once settlement has run. */
export function billingStatusFor(
  billing: SettleBilling,
  creditsCharged: number,
): ItemBillingStatus {
  if (billing === "unbilled") return "unbilled";
  if (billing === "credits") return creditsCharged > 0 ? "charged" : "free";
  return "free";
}

/**
 * billing_status the moment the draft row exists, before settlement. Only a
 * platform-metered generation has a charge outstanding; BYOK and beta grants
 * are settled by construction, so a crash after this point owes nothing.
 */
export function initialBillingStatus(mode: BillingMode): ItemBillingStatus {
  return mode === "platform" ? "pending" : "free";
}

/** Customer-facing wording. Provider bodies never reach these strings. */
export const PROVIDER_ERROR_MESSAGE =
  "The AI provider returned an error; try again or contact support.";
export const PROVIDER_TIMEOUT_MESSAGE =
  "The AI provider took too long to respond. Try again in a minute.";
export const GENERATION_PAUSED_MESSAGE =
  "Paused: page generation is paused platform-wide right now. Try again later.";
export const ATTEMPTS_EXHAUSTED_MESSAGE = `Gave up after ${MAX_ITEM_ATTEMPTS} attempts. Contact support if you need this city written.`;
export const UNBILLED_ITEM_MESSAGE =
  "The draft was written but could not be billed: this workspace is out of included AI generation. Contact support, then retry — the page will not be generated again.";

/**
 * Credit packs are not for sale (tests/credit-pack-withdrawn.test.ts), so
 * there is no purchase path to point at: the way to continue is support. The
 * model is accepted for call-site compatibility; a per-model price would only
 * describe something the customer cannot buy.
 */
export function outOfCreditsMessage(_model: string): string {
  return "This workspace has used up its included AI generation. Contact support to continue generating pages.";
}

export function dailyCapMessage(cap: number, remaining: number): string {
  return remaining === 0
    ? `You've hit today's limit of ${cap} generated pages. Try again in 24 hours.`
    : `You can generate ${remaining} more page${remaining === 1 ? "" : "s"} in the next 24 hours (limit ${cap} per day). Pick ${remaining} or fewer cities.`;
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The brief a batch item generates from. Mirrors the "City Hub" preset. */
export function buildCityBrief(t: {
  city: string;
  state?: string | null;
  categoryPlural?: string | null;
}): { title: string; topic: string; description: string } {
  const place = `${t.city}${t.state ? `, ${t.state}` : ""}`;
  const cat = (t.categoryPlural ?? "").trim() || "listings";
  return {
    title: `${cap(cat)} in ${place}`,
    description: `Browse ${cat} in ${place} and find the right option for you.`,
    topic: `City hub page for ${place}. Cover: who uses ${cat} here, popular local use cases, what to look for when booking, and a strong CTA to browse the live listings shown on the page. Use only real facts — do not invent pricing or availability.`,
  };
}

export type InventoryRow = {
  title: string | null;
  price_amount: number | null;
  price_currency: string | null;
};

/**
 * The grounding block. "The ONLY numbers you may use" is what separates a
 * factual per-city page from the templated filler Google's scaled-content
 * policy demotes — keep that wording.
 */
export function formatInventoryFacts(city: string, rows: InventoryRow[]): string {
  const prices = rows
    .map((r) => r.price_amount)
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b);
  const currency = rows.find((r) => r.price_currency)?.price_currency ?? "USD";
  const sample = rows
    .slice(0, 5)
    .map((r) => `- ${r.title}`)
    .join("\n");
  return `

Live inventory facts for ${city} — the ONLY numbers you may use; never invent pricing, counts, or listings:
- ${rows.length} published listings
- ${
    prices.length
      ? `Price range ${(prices[0]! / 100).toFixed(0)}–${(prices[prices.length - 1]! / 100).toFixed(0)} ${currency}`
      : "No price data — do not state or estimate prices"
  }
${sample ? `- Example listings:\n${sample}` : "- No example listings yet."}`;
}

export const GENERATION_SYSTEM_PROMPT = `
You write SEO-optimised brand content for a marketplace business.
Voice: confident, friendly, customer-first, never spammy. Short paragraphs.
Real, useful copy — no filler, no "in this article we will".
Format: Markdown only. Use ## and ### headings.
Always end with a short CTA paragraph.
Return your answer ONLY by calling the write_page tool.
`.trim();

export const WRITE_PAGE_TOOL = {
  type: "function" as const,
  function: {
    name: "write_page",
    description: "Return the generated page content.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        seo_title: { type: "string", description: "≤60 chars" },
        seo_description: { type: "string", description: "≤155 chars" },
        body_markdown: {
          type: "string",
          description: "Full markdown body, 600-1200 words, no frontmatter",
        },
      },
      required: ["title", "seo_title", "seo_description", "body_markdown"],
      additionalProperties: false,
    },
  },
};

export function buildUserPrompt(p: {
  title: string;
  description?: string | null;
  topic: string;
  inventoryFacts?: string;
}): string {
  return `Write a brand page.

Title (H1): "${p.title}"
${p.description ? `One-line summary: "${p.description}"` : ""}

What this page should be about (interpret literally and build the article around this):
${p.topic}
${p.inventoryFacts ?? ""}

Length: 600-1200 words.
Use ## for the main sections and ### for sub-points. Lead with a strong opening — no fluff.
seo_title (≤60 chars) and seo_description (≤155 chars) optimised for the topic.`;
}

export type WritePageOutput = {
  title: string;
  seo_title: string;
  seo_description: string;
  body_markdown: string;
};

export type OpenRouterResult = WritePageOutput & {
  promptTokens: number;
  completionTokens: number;
};

/** Anything shorter than this is a refusal or a truncated stream, not a page. */
export const MIN_BODY_CHARS = 300;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * One forced tool call to OpenRouter. `fetchImpl` is injectable so the
 * parsing rules (tool-call shape, short-body rejection, non-2xx handling,
 * the timeout) are testable offline.
 *
 * Provider error bodies go to the server log ONLY. What is thrown — and so
 * what lands in generation_items.error and in front of the customer — is a
 * generic sentence. A raw upstream body can carry request ids, quota
 * details or half a stack trace; none of that belongs in a tenant's UI.
 */
export async function callOpenRouterWritePage(opts: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  log?: (message: string) => void;
}): Promise<OpenRouterResult> {
  const doFetch: FetchLike = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  const log = opts.log ?? ((m: string) => console.error(m));
  const signal = AbortSignal.timeout(opts.timeoutMs ?? OPENROUTER_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await doFetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: opts.systemPrompt },
          { role: "user", content: opts.userPrompt },
        ],
        tools: [WRITE_PAGE_TOOL],
        tool_choice: { type: "function", function: { name: "write_page" } },
      }),
      signal,
    });
  } catch (e) {
    const name = (e as { name?: unknown } | null)?.name;
    const timedOut = signal.aborted || name === "TimeoutError" || name === "AbortError";
    const reason = e instanceof Error ? e.message : String(e);
    log(
      `[openrouter] ${timedOut ? "timeout" : "network error"} model=${opts.model}: ${reason.slice(0, 300)}`,
    );
    throw new CustomerFacingError(timedOut ? PROVIDER_TIMEOUT_MESSAGE : PROVIDER_ERROR_MESSAGE);
  }

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    log(`[openrouter] HTTP ${resp.status} model=${opts.model}: ${t.slice(0, 500)}`);
    throw new CustomerFacingError(PROVIDER_ERROR_MESSAGE);
  }
  // The body is still the provider's: the timeout can fire while it streams
  // in, and a truncated or non-JSON body is a provider failure too. Neither
  // may surface as the raw abort or parse message.
  let json: any;
  try {
    json = await resp.json();
  } catch (e) {
    const name = (e as { name?: unknown } | null)?.name;
    const timedOut = signal.aborted || name === "TimeoutError" || name === "AbortError";
    const reason = e instanceof Error ? e.message : String(e);
    log(
      `[openrouter] ${timedOut ? "timeout" : "unreadable body"} model=${opts.model}: ${reason.slice(0, 300)}`,
    );
    throw new CustomerFacingError(timedOut ? PROVIDER_TIMEOUT_MESSAGE : PROVIDER_ERROR_MESSAGE);
  }
  const promptTokens = Number(json?.usage?.prompt_tokens ?? 0) || 0;
  const completionTokens = Number(json?.usage?.completion_tokens ?? 0) || 0;
  const tc = json?.choices?.[0]?.message?.tool_calls?.[0];
  if (!tc?.function?.arguments) throw new CustomerFacingError("AI response missing tool call");
  let gen: Partial<WritePageOutput>;
  try {
    gen =
      typeof tc.function.arguments === "string"
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments;
  } catch {
    throw new CustomerFacingError("AI response was not valid JSON");
  }
  if (!gen.body_markdown || gen.body_markdown.length < MIN_BODY_CHARS) {
    throw new CustomerFacingError(
      `Generated body too short (${gen.body_markdown?.length ?? 0} chars)`,
    );
  }
  return {
    title: String(gen.title ?? ""),
    seo_title: String(gen.seo_title ?? ""),
    seo_description: String(gen.seo_description ?? ""),
    body_markdown: gen.body_markdown,
    promptTokens,
    completionTokens,
  };
}

// ---------------------------------------------------------------------------
// Database-backed steps
// ---------------------------------------------------------------------------

const sb = () => supabaseAdmin as any;

export type KeySource = "byok" | "platform";

/** BYOK first, platform env-var fallback — and REMEMBER which one it was. */
export async function resolveGenerationKey(
  workspaceId: string,
): Promise<{ key: string; source: KeySource }> {
  const found = await getWorkspaceSecretWithSource(
    workspaceId,
    "OPENROUTER_API_KEY",
    "OPENROUTER_API_KEY",
  );
  if (!found) {
    throw new CustomerFacingError(
      "Page generation is not available right now: no AI key is configured for this workspace. Contact support.",
    );
  }
  return found;
}

/**
 * Cheap read-only check that the workspace can pay for ONE platform call at
 * this model's price (see hasPlatformFunds). Nothing is reserved —
 * consumption happens in settleGeneration after the page row exists.
 */
export async function assertPlatformAiAvailable(workspaceId: string, model: string): Promise<void> {
  const [{ data: quota }, { data: bal }] = await Promise.all([
    supabaseAdmin
      .from("workspace_ai_quota")
      .select("platform_credits_remaining")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    supabaseAdmin
      .from("credit_balances")
      .select("balance")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
  ]);
  const ok = hasPlatformFunds({
    freeQuotaRemaining: quota ? (quota.platform_credits_remaining ?? 0) : null,
    balance: bal?.balance ?? 0,
    model,
  });
  if (!ok) throw new CustomerFacingError(outOfCreditsMessage(model));
}

/**
 * Is AI generation included for this workspace? True for a beta tenant whose
 * capacity comes from an admin grant (billingState 'granted'): that is the
 * product decision — generation is part of the grant, bounded by the daily
 * cap and the pause switch rather than by credits. A read failure meters
 * normally (fails closed for cost); it never hands out free generation.
 */
export async function isGenerationGranted(workspaceId: string): Promise<boolean> {
  try {
    const { readEntitlement } = await import("@/lib/entitlements.functions");
    const ent = await readEntitlement(workspaceId);
    return ent.billingState === "granted";
  } catch (e) {
    console.error(
      "[generation] entitlement read failed; metering normally",
      workspaceId,
      e instanceof Error ? e.message : String(e),
    );
    return false;
  }
}

/** For a platform-keyed generation: included by grant, or metered (with funds). */
export async function resolvePlatformSettlementMode(
  workspaceId: string,
  model: string,
): Promise<"granted" | "platform"> {
  if (await isGenerationGranted(workspaceId)) return "granted";
  await assertPlatformAiAvailable(workspaceId, model);
  return "platform";
}

export type ResolvedBilling = { key: string; source: KeySource; mode: BillingMode };

/**
 * Step 0: who pays. Throws with a customer-readable message when nobody can
 * (no key, or a platform key without the funds for a whole page). Callers run
 * this BEFORE claiming an item so a refusal here never counts as an attempt.
 */
export async function resolveBillingMode(
  workspaceId: string,
  model: string,
): Promise<ResolvedBilling> {
  const { key, source } = await resolveGenerationKey(workspaceId);
  if (source === "byok") return { key, source, mode: "byok" };
  const mode = await resolvePlatformSettlementMode(workspaceId, model);
  return { key, source, mode };
}

export type GenerateInput = {
  workspaceId: string;
  title: string;
  description?: string | null;
  topic: string;
  city?: string | null;
  state?: string | null;
  categoryPlural?: string | null;
  /** Category used to narrow the inventory grounding query, if known. */
  category?: string | null;
  model?: string | null;
  /** Pre-resolved by the caller (resolveBillingMode); resolved here otherwise. */
  billing?: ResolvedBilling;
  fetchImpl?: FetchLike;
};

export type GeneratedContent = WritePageOutput & {
  promptTokens: number;
  completionTokens: number;
  model: string;
  keySource: KeySource;
  billingMode: BillingMode;
};

/**
 * Step 1: produce content. Charges nothing. Throws with a customer-readable
 * message on any failure (no key, no credits, provider error, thin output).
 */
export async function generatePageContent(input: GenerateInput): Promise<GeneratedContent> {
  const model = resolvePlatformModel(input.model ?? GENERATION_DEFAULT_MODEL);
  const billing = input.billing ?? (await resolveBillingMode(input.workspaceId, model));

  // Ground generation in the tenant's real inventory when a city is targeted.
  let inventoryFacts = "";
  const city = input.city?.trim();
  if (city) {
    let q = supabaseAdmin
      .from("tenant_listings")
      .select("title, price_amount, price_currency")
      .eq("workspace_id", input.workspaceId)
      .ilike("city", city)
      .eq("state_published", true);
    if (input.category) q = q.eq("category", input.category);
    const { data: cityListings } = await q.limit(100);
    inventoryFacts = formatInventoryFacts(city, (cityListings ?? []) as InventoryRow[]);
  }

  const gen = await callOpenRouterWritePage({
    apiKey: billing.key,
    model,
    systemPrompt: GENERATION_SYSTEM_PROMPT,
    userPrompt: buildUserPrompt({
      title: input.title,
      description: input.description,
      topic: input.topic,
      inventoryFacts,
    }),
    fetchImpl: input.fetchImpl,
  });
  return { ...gen, model, keySource: billing.source, billingMode: billing.mode };
}

export type PersistedPage = {
  id: string;
  slug: string;
  title: string;
  url_path: string;
  /** True when the row already existed for this generation request (replay). */
  replayed?: boolean;
};

export type ExistingPage = {
  id: string;
  slug: string;
  title: string | null;
  status: string | null;
  body_markdown: string | null;
  /** Who paid for the generation (tenant_pages.generation_billing_mode); null
   *  for hand-written pages and pages generated before that column existed.
   *  'platform' is the only value that can still owe a charge. */
  generation_billing_mode: BillingMode | null;
};

/** The page a Quick Page request already produced, if it did. */
export async function findPageByRequestId(
  workspaceId: string,
  generationRequestId: string,
): Promise<ExistingPage | null> {
  const { data, error } = await sb()
    .from("tenant_pages")
    .select("id, slug, title, status, body_markdown, generation_billing_mode")
    .eq("workspace_id", workspaceId)
    .eq("generation_request_id", generationRequestId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ExistingPage | null) ?? null;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/**
 * A page that already covers this city, by the same predicate the Page
 * Builder uses to decide eligibility (pageCoversCity). Batch items call this
 * right before generating: a draft that a crashed run left behind, or one the
 * customer wrote by hand meanwhile, is linked instead of duplicated.
 */
export async function findExistingCityPage(
  workspaceId: string,
  city: string,
  state: string | null | undefined,
): Promise<{ id: string; slug: string } | null> {
  const wanted = city.trim();
  if (!wanted) return null;
  const { data, error } = await sb()
    .from("tenant_pages")
    .select("id, slug, variables, created_at")
    .eq("workspace_id", workspaceId)
    .ilike("variables->>city", escapeLike(wanted))
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{
    id: string;
    slug: string;
    variables: Record<string, unknown> | null;
  }>;
  const hit = rows.find((p) =>
    pageCoversCity(
      {
        city: p.variables?.city as string | undefined,
        state: p.variables?.state as string | undefined,
      },
      { city: wanted, state },
    ),
  );
  return hit ? { id: hit.id, slug: hit.slug } : null;
}

/**
 * Step 2: the draft row. Always status 'draft' — publishing is a separate,
 * gated step (page contract + entitlement) that callers run explicitly.
 *
 * With a generationRequestId the insert is idempotent per workspace (partial
 * unique index): a concurrent duplicate request loses the race, reads the
 * winner's row and returns it flagged `replayed`, so the caller knows NOT to
 * settle — the winner does. Batch items never pass one; they are keyed by
 * generation_items instead, which is what keeps the daily-cap ledger honest.
 *
 * The row records who paid (generation_billing_mode) so a later replay can
 * tell a platform page that may still owe its charge from one that never did.
 */
export async function persistGeneratedPage(input: {
  workspaceId: string;
  generated: WritePageOutput & { billingMode?: BillingMode };
  requestedTitle: string;
  requestedDescription?: string | null;
  slug?: string | null;
  city?: string | null;
  state?: string | null;
  categoryPlural?: string | null;
  generationRequestId?: string | null;
}): Promise<PersistedPage> {
  const baseSlug = slugifyPage(input.slug || input.requestedTitle);
  if (!baseSlug) throw new CustomerFacingError("Could not derive slug from title");
  let slug = await findUniqueTenantSlug(input.workspaceId, baseSlug);
  const templateId = await getActiveTemplateId("city_hub");

  const pageTitle = input.generated.title || input.requestedTitle;
  const city = input.city?.trim() || "";
  const state = input.state?.trim() || "";
  const categoryPlural = input.categoryPlural?.trim() || "listings";
  const variables: Record<string, string> = {};
  if (city) variables.city = city;
  if (state) variables.state = state;
  if (categoryPlural) variables.category_plural = categoryPlural;
  const listingFilter: Record<string, unknown> = { limit: 24, sort: "newest" };
  if (city) listingFilter.city = city;
  if (state) listingFilter.state = state;

  const row = {
    workspace_id: input.workspaceId,
    template_id: templateId,
    title: pageTitle,
    meta_description: (input.generated.seo_description || input.requestedDescription || "").slice(
      0,
      320,
    ),
    h1: pageTitle,
    body_markdown: input.generated.body_markdown,
    variables,
    listing_filter: listingFilter,
    status: "draft",
    generation_request_id: input.generationRequestId ?? null,
    generation_billing_mode: input.generated.billingMode ?? null,
  };

  // At most two inserts: the first, and one retry with a re-derived slug.
  for (let attempt = 0; ; attempt++) {
    const { data: inserted, error: insErr } = await sb()
      .from("tenant_pages")
      .insert({ ...row, slug })
      .select("id, slug, title")
      .single();
    if (!insErr) return { ...inserted, url_path: `/a/${inserted.slug}` };

    if (insErr.code === "23505") {
      // ANY unique violation is checked against the request id first: a
      // concurrent duplicate of this request may have lost on the slug index
      // before the request-id index was ever consulted, and it must still
      // come back as the winner's page, not as an error.
      if (input.generationRequestId) {
        const existing = await findPageByRequestId(input.workspaceId, input.generationRequestId);
        if (existing) {
          return {
            id: existing.id,
            slug: existing.slug,
            title: existing.title ?? pageTitle,
            url_path: `/a/${existing.slug}`,
            replayed: true,
          };
        }
      }
      // Another page took the slug between the uniqueness read and the
      // insert: re-derive once (the helper adds a numeric suffix) and retry
      // once. A second collision is not a race any more.
      if (attempt === 0 && /slug/.test(String(insErr.message ?? ""))) {
        slug = await findUniqueTenantSlug(input.workspaceId, baseSlug);
        continue;
      }
    }
    throw new Error(insErr.message);
  }
}

export type LedgerSettlement = { billing: "free_quota" | "credits"; amount: number };

/** The ref_type values a generated page's settlement row may carry. */
export const GENERATION_LEDGER_REF_TYPES = ["batch_generation", "quick_page"] as const;

/**
 * The settlement already on the ledger for this page, or null. The ledger row
 * is the settlement record: one per page, whichever currency paid — a
 * deduct_credits row (delta < 0) when purchased credits paid, a delta-0 row
 * from settle_generation_free_quota when the free quota did. The partial
 * unique index credit_ledger_generation_settlement_uidx makes a second row
 * for the same page impossible, so this read — not the item, not memory —
 * is the whole idempotency check: a settlement that died between the write
 * and the item update is recognised on the retry instead of paid again.
 * Throws on a read error: not knowing must never turn into a fresh charge.
 */
export async function findLedgerCharge(
  workspaceId: string,
  refId: string,
): Promise<LedgerSettlement | null> {
  const { data, error } = await sb()
    .from("credit_ledger")
    .select("delta")
    .eq("workspace_id", workspaceId)
    .eq("ref_id", refId)
    .eq("reason", "ai_usage")
    .in("ref_type", [...GENERATION_LEDGER_REF_TYPES])
    .lte("delta", 0)
    .limit(1);
  if (error) throw new Error(`credit ledger read failed: ${error.message}`);
  const row = (data ?? [])[0] as { delta: number } | undefined;
  if (!row) return null;
  const delta = Number(row.delta) || 0;
  return { billing: delta < 0 ? "credits" : "free_quota", amount: Math.abs(delta) };
}

const quotaExhausted = (e: { message?: string | null } | null | undefined): boolean =>
  typeof e?.message === "string" && e.message.includes("platform_ai_quota_exhausted");

type PlatformSettlement =
  | { ok: true; billing: "free_quota" | "credits"; creditsCharged: number }
  | { ok: false; failure: string };

/**
 * The platform-key branch of settleGeneration. The ledger row is the
 * settlement record: one per page, whichever currency paid.
 *   1. already on the ledger for this page → that is the charge; nothing moves.
 *   2. settle_generation_free_quota → writes the row, then spends one free
 *      credit. Lost the unique index? a concurrent settlement won: adopt its
 *      row. Quota exhausted? fall through to credits.
 *   3. deduct_credits → writes its own row (delta < 0) with the same ref.
 *      Lost the index the same way? adopt the winner's row.
 * Without a refId (not the batch or quick page — both always pass the page
 * id) the old, unkeyed consume-then-deduct path is kept so nothing regresses.
 */
async function settleOnPlatform(p: {
  workspaceId: string;
  model: string;
  feature: string;
  refId: string | null;
  usage: { promptTokens: number; completionTokens: number };
}): Promise<PlatformSettlement> {
  const adopt = async (cause: string): Promise<PlatformSettlement> => {
    const won = p.refId ? await findLedgerCharge(p.workspaceId, p.refId) : null;
    if (won) return { ok: true, billing: won.billing, creditsCharged: won.amount };
    return { ok: false, failure: `${cause}: settlement conflict but no ledger row for this page` };
  };

  const deduct = async (): Promise<PlatformSettlement> => {
    const owed = creditsForUsage(p.model, p.usage.promptTokens, p.usage.completionTokens);
    if (owed <= 0) return { ok: true, billing: "credits", creditsCharged: 0 };
    const { error } = await supabaseAdmin.rpc("deduct_credits", {
      _workspace_id: p.workspaceId,
      _amount: owed,
      _reason: "ai_usage",
      _ai_model: p.model,
      _ref_type: p.feature,
      _ref_id: p.refId ?? undefined,
      _metadata: { provider: "platform", feature: p.feature },
    });
    if (!error) return { ok: true, billing: "credits", creditsCharged: owed };
    if (p.refId && isSettlementConflict(error)) return adopt("deduct_credits");
    return { ok: false, failure: `deduct_credits failed (${owed} credits): ${error.message}` };
  };

  if (p.refId) {
    // Checked before touching the free quota, so a retry after a crash
    // cannot pay twice in either currency.
    const prior = await findLedgerCharge(p.workspaceId, p.refId);
    if (prior) return { ok: true, billing: prior.billing, creditsCharged: prior.amount };
    const { error: qErr } = await sb().rpc("settle_generation_free_quota", {
      _workspace_id: p.workspaceId,
      _ref_type: p.feature,
      _ref_id: p.refId,
      _ai_model: p.model,
    });
    if (!qErr) return { ok: true, billing: "free_quota", creditsCharged: 0 };
    if (isSettlementConflict(qErr)) return adopt("settle_generation_free_quota");
    if (quotaExhausted(qErr)) return deduct();
    return { ok: false, failure: `settle_generation_free_quota failed: ${qErr.message}` };
  }

  const { error: qErr } = await supabaseAdmin.rpc("consume_platform_ai_credit", {
    _workspace_id: p.workspaceId,
  });
  if (!qErr) return { ok: true, billing: "free_quota", creditsCharged: 0 };
  if (quotaExhausted(qErr)) return deduct();
  return { ok: false, failure: `consume_platform_ai_credit failed: ${qErr.message}` };
}

/**
 * Step 3: settle. Runs ONLY after a page row exists.
 *   BYOK      → nothing to charge; logged for the usage history only.
 *   granted   → included in the beta grant; logged, not charged.
 *   platform  → the ledger row is the settlement record: one per page,
 *               whichever currency paid. Already there? then the page is
 *               paid and nothing moves. Otherwise the free quota first
 *               (settle_generation_free_quota, which writes the row before
 *               it spends), then purchased credits (deduct_credits, which
 *               writes its own row). A write that loses to a concurrent
 *               settlement re-reads the ledger and adopts the winner's.
 * A provider that omitted usage is billed as a typical page (billableUsage),
 * never as a free one. A deduction that fails is reported as `unbilled` with
 * creditsCharged 0 — never as a charge that did not happen — and logged
 * loudly for ops. The caller decides what that means for its record (a batch
 * item fails so its retry can settle without regenerating).
 */
export async function settleGeneration(opts: {
  workspaceId: string;
  userId?: string | null;
  keySource: KeySource;
  billingMode?: BillingMode;
  model: string;
  promptTokens: number;
  completionTokens: number;
  feature: string;
  refId?: string | null;
}): Promise<{ creditsCharged: number; billing: SettleBilling; billingStatus: ItemBillingStatus }> {
  const mode: BillingMode = opts.billingMode ?? (opts.keySource === "byok" ? "byok" : "platform");
  let creditsCharged = 0;
  let billing: SettleBilling =
    mode === "byok" ? "byok" : mode === "granted" ? "granted" : "unbilled";
  let failure: string | null = null;

  const usage = billableUsage(opts.promptTokens, opts.completionTokens);
  if (usage.assumed) {
    console.warn(
      `[settleGeneration] provider omitted usage; billing a typical page feature=${opts.feature} refId=${opts.refId ?? "none"} model=${opts.model}`,
    );
  }

  if (mode === "platform") {
    const outcome = await settleOnPlatform({
      workspaceId: opts.workspaceId,
      model: opts.model,
      feature: opts.feature,
      refId: opts.refId ?? null,
      usage,
    });
    if (outcome.ok) {
      billing = outcome.billing;
      creditsCharged = outcome.creditsCharged;
    } else {
      failure = outcome.failure;
      // The page already exists and the provider has been paid. This line is
      // the only record that WE were not — keep it loud and greppable.
      console.error(
        "[settleGeneration] UNBILLED generation",
        JSON.stringify({
          workspaceId: opts.workspaceId,
          feature: opts.feature,
          refId: opts.refId ?? null,
          model: opts.model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          usageAssumed: usage.assumed,
          failure,
        }),
      );
      billing = "unbilled";
      creditsCharged = 0;
    }
  }

  await supabaseAdmin.from("ai_usage_log").insert({
    workspace_id: opts.workspaceId,
    user_id: opts.userId ?? undefined,
    provider: opts.keySource === "byok" ? "openrouter" : "platform",
    model: opts.model,
    feature: opts.feature,
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.promptTokens + usage.completionTokens,
    used_byok: opts.keySource === "byok",
    status: billing === "unbilled" ? "unbilled" : "ok",
    error: failure ? failure.slice(0, 300) : undefined,
  });
  return { creditsCharged, billing, billingStatus: billingStatusFor(billing, creditsCharged) };
}

// ---------------------------------------------------------------------------
// Platform-wide knobs and the daily-cap ledger (shared by batch + quick page)
// ---------------------------------------------------------------------------

export const DEFAULT_DAILY_CAP = 50;

/**
 * platform_settings is service-role only. Fail CLOSED on any read error: if
 * the pause switch cannot be read it is treated as thrown, and the cap as 0 —
 * a broken settings read must never turn into an uncapped spend.
 */
export async function readPlatformSettings(): Promise<{ paused: boolean; dailyCap: number }> {
  const { data, error } = await sb()
    .from("platform_settings")
    .select("key, value")
    .in("key", ["generation_paused", "generation_daily_cap"]);
  if (error) {
    console.error("[generation] platform_settings read failed", error.message);
    return { paused: true, dailyCap: 0 };
  }
  const map = new Map<string, unknown>((data ?? []).map((r: any) => [r.key, r.value]));
  const paused = isGenerationPaused(map.get("generation_paused"));
  const capRaw = Number(map.get("generation_daily_cap") ?? DEFAULT_DAILY_CAP);
  return { paused, dailyCap: Number.isFinite(capRaw) ? capRaw : DEFAULT_DAILY_CAP };
}

/**
 * Pages this workspace has consumed from its daily cap in the last 24 hours,
 * across BOTH generators, so neither can be used to get around the other.
 * ONE definition, in the database (generation_consumed_last_24h, migration
 * 20260924000600), shared with reserve_generation_slot so the app and the
 * reservation RPC can never disagree:
 *   batch  = generation_items done/running/pending in the window (a reservation
 *            — see DAILY_CAP_COUNTED_STATUSES); `excludeItemId` leaves out the
 *            item asking, which already holds its own slot;
 *   quick  = tenant_pages created in the window that carry a
 *            generation_request_id (every Quick Page / Opportunity Engine /
 *            coach page does; batch pages never do, so nothing is counted twice);
 *   held   = generation_reservations in the window whose request produced no
 *            page yet (a materialised reservation counts once, as its page).
 * Throws on an RPC error; callers treat that as "cannot generate".
 */
export async function countConsumedLast24h(
  workspaceId: string,
  opts: { excludeItemId?: string } = {},
): Promise<number> {
  const { data, error } = await sb().rpc("generation_consumed_last_24h", {
    _workspace_id: workspaceId,
    _exclude_item_id: opts.excludeItemId ?? null,
  });
  if (error) throw new Error(error.message);
  return Number(data) || 0;
}

/**
 * Take one of today's generation slots for this request, atomically. The RPC
 * serialises per workspace (an advisory lock), counts what the last 24 hours
 * consumed with the same definition as countConsumedLast24h, and inserts the
 * reservation only when a slot is free — so N concurrent requests at
 * remaining = 1 admit exactly one. A replay of a request that already holds
 * a slot keeps it. The batch generator does not call this: its reservation
 * is its pending item row, claimed before generation. Throws on an RPC
 * error; the caller treats that as "cannot generate" (never uncapped).
 */
export async function reserveGenerationSlot(
  workspaceId: string,
  requestId: string,
  cap: number,
): Promise<boolean> {
  const { data, error } = await sb().rpc("reserve_generation_slot", {
    _workspace_id: workspaceId,
    _request_id: requestId,
    _cap: Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0,
  });
  if (error) throw new Error(`reserve_generation_slot failed: ${error.message}`);
  return data === true;
}

/**
 * Give a slot back when no page came of it. Best effort: a reservation that
 * survives here still ages out of the cap after 24 hours, and one whose page
 * does exist is neutralised by the page row, so a failure is logged, never
 * thrown over the error that caused the release.
 */
export async function releaseGenerationSlot(workspaceId: string, requestId: string): Promise<void> {
  const { error } = await sb()
    .from("generation_reservations")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("request_id", requestId);
  if (error) {
    console.error(
      "[generation] could not release the daily-cap reservation",
      JSON.stringify({ workspaceId, requestId, error: error.message }),
    );
  }
}

/** Run the published-page contract against a stored draft. */
export async function checkStoredPageContract(
  workspaceId: string,
  pageId: string,
): Promise<ContractCheck & { status: string | null; slug: string; title: string | null }> {
  const { data: page, error } = await sb()
    .from("tenant_pages")
    .select(
      "id, slug, title, meta_description, h1, body_markdown, listing_filter, variables, status",
    )
    .eq("workspace_id", workspaceId)
    .eq("id", pageId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!page) throw new Error("Page not found");
  const check = await checkPageBeforePublish(workspaceId, {
    id: page.id,
    slug: page.slug,
    title: page.title,
    metaDescription: page.meta_description,
    h1: page.h1,
    bodyMarkdown: page.body_markdown,
    listingFilter: page.listing_filter,
    variables: page.variables,
  });
  return { ...check, status: page.status ?? null, slug: page.slug, title: page.title ?? null };
}

/** Plain-language reason a draft could not go live. */
export function contractFailureMessage(check: ContractCheck): string {
  const msgs = check.blocking.map((v) => v.message);
  return msgs.length
    ? `Kept as a draft: ${msgs.join(" ")}`
    : "Kept as a draft: the page did not pass the pre-publish checks.";
}
