import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { creditsForUsage } from "@/lib/ai-pricing";
import { AI_ROUTE_LIMITS } from "@/lib/ai/limits";
import {
  AI_DEFAULT_TIER,
  AI_QUALITY_TIERS,
  AI_TIER_OPTIONS,
  modelForTier,
  type AiModelId,
  type AiQualityTier,
} from "@/lib/ai/models";
import { AI_MESSAGES, CustomerFacingError } from "@/lib/ai/customer-error";
import type { AiUsage, OpenAiTransport, StructuredFormat } from "@/lib/ai/openai.server";
// Types only: the spend flow (and through it the OpenAI SDK) is imported
// dynamically where it is used, so no client bundle that reaches this module
// through a *.functions.ts file can pull the SDK in (bun run build + a grep of
// .output/public checks it; tests/ai-source-guards.test.ts guards the graph).
import type {
  AiBillingClass,
  AiDb,
  AiKey,
  AiSettlement,
  SpendBilling,
} from "@/lib/ai/spend.server";
import {
  findUniqueTenantSlug,
  getActiveTemplateId,
  slugifyPage,
} from "@/lib/tenant-page-helpers.server";
import { checkPageBeforePublish, type ContractCheck } from "@/lib/seo/page-contract.server";
import { isInternalUnlimitedOrFalse } from "@/lib/entitlement-grants.server";
import { z } from "zod";

export { CustomerFacingError, customerMessage } from "@/lib/ai/customer-error";

/**
 * Shared page-generation core. The Quick Page Builder, the coach's city page,
 * the Opportunity Engine and the batch "Generate Content" job all run through
 * here so there is ONE prompt, ONE inventory-grounding rule, ONE spend path
 * and ONE model policy.
 *
 * Ordering matters and is the whole point of this module (and of its
 * callers, runQuickPage and the batch runItem):
 *   validate → pause (fail fast) → key and billing class (resolveBillingMode)
 *   → the daily-cap slot (reserveGenerationSlot, one per provider call; no
 *     cap for a workspace with the internal unlimited entitlement — the slot
 *     is still taken, for idempotency and the ledger)
 *   → the spend hold (runMeteredAiCall → ai_reserve; a refusal releases the
 *     slot) → mark both (ai_mark_called, then the slot in beforeProviderCall:
 *     a refused hold mark never spends a slot)
 *   → the OpenAI call → the draft row (persistGeneratedPage, never
 *     auto-published) → settle (ai_settle: the customer is charged only for
 *     a saved page, the actual cost capped at the hold).
 * The slot and the hold share ONE request id. Only a failure BEFORE the marks
 * releases anything; after them the slot stays counted for 24 hours (and the
 * reservation counts toward the per-minute rate limit), so a failing request
 * can never loop the platform key without bound. The call is settled on two
 * books: the customer pays only for a delivered page and is refunded in full
 * for any failure; the platform budget keeps what OpenAI may have been paid.
 * There is exactly one settlement per request, and it happens in the
 * database right after the page is written (or failed to be).
 *
 * The pure helpers at the top have no I/O so tests can import this file
 * without a database or network (supabaseAdmin is a lazy proxy).
 *
 * NEVER import from client code.
 */

// ---------------------------------------------------------------------------
// Pure helpers (no I/O)
// ---------------------------------------------------------------------------

/** A typical city page: ~1.5K prompt tokens (brief + inventory) and ~1.5K out. */
export const TYPICAL_PAGE_TOKENS = { prompt: 1500, completion: 1500 };

/** Credits one page is likely to cost on the platform key at a quality tier, for the cost hint. */
export function estimatedCreditsPerPage(tier: AiQualityTier): number {
  return creditsForUsage(modelForTier(tier), TYPICAL_PAGE_TOKENS.prompt, TYPICAL_PAGE_TOKENS.completion);
}

/**
 * The quality tiers a page request may ask for, as a tuple for z.enum. A tier
 * is the ONLY say a customer has in the model (models.ts maps it on the
 * server); a model name in a request body is a validation error.
 */
export const GENERATION_TIERS = AI_QUALITY_TIERS;
export const GENERATION_DEFAULT_TIER: AiQualityTier = AI_DEFAULT_TIER;

/** Labels + a one-line cost hint per tier, for the pickers. No model names. */
export const GENERATION_TIER_OPTIONS: Array<{ tier: AiQualityTier; label: string; hint: string }> =
  AI_TIER_OPTIONS.map((o) => {
    const credits = estimatedCreditsPerPage(o.tier);
    return {
      tier: o.tier,
      label: o.label,
      hint: `${o.hint} About ${credits} credit${credits === 1 ? "" : "s"} per page on the platform key.`,
    };
  });

/** The source label a generation is logged under (ai_usage_log.feature). */
export type GenerationSource = "quick_page" | "batch_generation" | "coach_city_page" | "opportunity";

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

export const GENERATION_UNAVAILABLE_MESSAGE =
  "Generation is temporarily unavailable. Please try again in a few minutes.";

/** reserve_generation_slot said 'in_progress': another request holds this id right now. */
export const GENERATION_IN_PROGRESS_MESSAGE =
  "This page is still being generated. Refresh in a minute.";

/** reserve_generation_slot said 'consumed' and no page carries the id (deleted, or the call failed). */
export const GENERATION_ALREADY_USED_MESSAGE =
  "This request already generated a page. Start a new one from the Page Builder.";

export const PAGE_TITLE_INVALID_MESSAGE = "A page title needs 3 to 140 characters.";

export const PAGE_SLUG_UNDERIVABLE_MESSAGE =
  "Could not derive a page address from that slug or title: use letters or numbers (for example boat-rentals-austin).";

/**
 * The base slug a generated page is stored under: the requested slug, else
 * the title, through slugifyPage. THE one derivation — persistGeneratedPage
 * stores under it and runQuickPage refuses an empty one before anything is
 * reserved or spent, so the two can never disagree. "" when nothing usable is
 * left (e.g. a slug of "---").
 */
export function generatedPageBaseSlug(
  slug: string | null | undefined,
  title: string | null | undefined,
): string {
  return slugifyPage(String(slug || title || ""));
}

/**
 * Every check on a page request that needs neither the database nor the
 * provider. runQuickPage runs it BEFORE the pause read, the reservation and
 * the provider call: a request that can only fail after generating (an
 * underivable slug used to fail in persistGeneratedPage, after the paid call,
 * and release its slot) must fail here, for free and without a slot. Returns
 * the base slug; throws CustomerFacingError otherwise.
 */
export function validatePageRequest(input: {
  title: string | null | undefined;
  slug?: string | null;
}): { baseSlug: string } {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title.length < 3 || title.length > 140) {
    throw new CustomerFacingError(PAGE_TITLE_INVALID_MESSAGE);
  }
  const baseSlug = generatedPageBaseSlug(input.slug, title);
  if (!baseSlug) throw new CustomerFacingError(PAGE_SLUG_UNDERIVABLE_MESSAGE);
  return { baseSlug };
}

/**
 * The deterministic reservation id of ONE batch item attempt. Seeded by the
 * item, its job and the attempt number the claim will write (attempts + 1):
 * two drivers racing for the same attempt compute the same id, so only one
 * of them is granted the slot; every later attempt, and every new life of
 * the item (a deleted-draft re-attach resets attempts to 0 but always moves
 * the item to a new job), gets an id of its own — so it takes a new slot
 * instead of colliding with a spent one.
 */
export function batchAttemptRequestId(item: {
  id: string;
  job_id: string;
  attempts: number;
}): Promise<string> {
  return deterministicRequestId(
    `item:${item.id}:${item.job_id}:${(Number(item.attempts) || 0) + 1}`,
  );
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
 * Hard ceiling on one provider call — the page-generation row of the route
 * table (src/lib/ai/limits.ts). It MUST be shorter than STALE_RUNNING_MS: a
 * driver that is still waiting on the provider must never look abandoned, or
 * a second driver reclaims the item and generates the page twice.
 */
export const PAGE_GENERATION_TIMEOUT_MS = AI_ROUTE_LIMITS.page_generation.timeoutMs;

export function isStaleRunning(updatedAt: string | null | undefined, now = Date.now()): boolean {
  if (!updatedAt) return true;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return true;
  return now - t > STALE_RUNNING_MS;
}


/** Customer-facing wording. Provider bodies never reach these strings. */
export const PROVIDER_ERROR_MESSAGE = AI_MESSAGES.providerError;
export const PROVIDER_TIMEOUT_MESSAGE = AI_MESSAGES.timeout;
export const GENERATION_PAUSED_MESSAGE = AI_MESSAGES.generationPaused;
export const ATTEMPTS_EXHAUSTED_MESSAGE = `Gave up after ${MAX_ITEM_ATTEMPTS} attempts. Contact support if you need this city written.`;

/**
 * Credit packs are not for sale (tests/credit-pack-withdrawn.test.ts), so
 * there is no purchase path to point at: the way to continue is support.
 */
export function outOfCreditsMessage(): string {
  return "This workspace has used up its included AI generation. Contact support to continue generating pages.";
}

export function dailyCapMessage(cap: number, remaining: number): string {
  return remaining === 0
    ? `You've hit today's limit of ${cap} generated pages. Try again in 24 hours.`
    : `You can generate ${remaining} more page${remaining === 1 ? "" : "s"} in the next 24 hours (limit ${cap} per day). Pick ${remaining} or fewer cities.`;
}

export type KeySource = "byok" | "platform";
/** Who paid for a generated page, as tenant_pages.generation_billing_mode records it. */
export type BillingMode = "byok" | "granted" | "platform";
/** generation_items.billing_status */
export type ItemBillingStatus = "pending" | "charged" | "free" | "unbilled";

/**
 * The page's billing mode for a spend hold's billing. 'internal' (the founder
 * / internal unlimited entitlement) is recorded as 'granted': the page was
 * included by an admin grant and cost the tenant nothing.
 */
export function billingModeFor(billing: SpendBilling): BillingMode {
  if (billing === "byok") return "byok";
  if (billing === "granted" || billing === "internal") return "granted";
  return "platform";
}

/**
 * What an item's (or a page's) billing status says once the call is settled.
 * Funds are held BEFORE the call, so a settled platform page can no longer
 * end up unbilled; a settle that could not be recorded stays 'pending' (the
 * hold covers it and the reaper settles it within 35 minutes).
 */
export function billingStatusFor(s: Pick<AiSettlement, "settled" | "billing" | "creditsCharged">): ItemBillingStatus {
  if (!s.settled) return "pending";
  if (s.billing === "credits" && s.creditsCharged > 0) return "charged";
  return "free";
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
Return the page as the write_page object: title, seo_title, seo_description, body_markdown.
`.trim();

/**
 * The page's output format — the same four fields, descriptions and
 * strictness the forced write_page tool had, now as a Structured Outputs JSON
 * Schema (text.format json_schema, strict) and validated again on arrival.
 */
export const WRITE_PAGE_SCHEMA = {
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
} as const;

export type WritePageOutput = {
  title: string;
  seo_title: string;
  seo_description: string;
  body_markdown: string;
};

const WritePageOutputSchema = z
  .object({
    title: z.string(),
    seo_title: z.string(),
    seo_description: z.string(),
    body_markdown: z.string(),
  })
  .strict();

export const WRITE_PAGE_FORMAT: StructuredFormat<WritePageOutput> = {
  name: "write_page",
  schema: WRITE_PAGE_SCHEMA as unknown as Record<string, unknown>,
  parse: (value) => {
    const r = WritePageOutputSchema.safeParse(value);
    return r.success ? r.data : null;
  },
};

/** Anything shorter than this is a refusal or a truncated stream, not a page. */
export const MIN_BODY_CHARS = 300;

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

// ---------------------------------------------------------------------------
// Database-backed steps
// ---------------------------------------------------------------------------

const sb = () => supabaseAdmin as any;

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

/** For a platform-keyed generation: included by the beta grant, or metered. */
export type ResolvedBilling = {
  key: AiKey;
  keySource: KeySource;
  billingClass: AiBillingClass;
  mode: BillingMode;
};

/**
 * Who pays, decided BEFORE anything is reserved: the workspace's own OpenAI
 * key (byok), a beta grant (page generation is included in it), or the
 * platform key metered against the free quota and credits. Whether the funds
 * cover the call is not read here — ai_reserve takes the hold atomically. No
 * key at all is a customer-facing refusal.
 */
export async function resolveBillingMode(workspaceId: string, db?: AiDb): Promise<ResolvedBilling> {
  const { resolveAiKey, billingClassFor } = await import("@/lib/ai/spend.server");
  const key = await resolveAiKey(workspaceId, db);
  const granted = key.source === "platform" ? await isGenerationGranted(workspaceId) : false;
  const billingClass = billingClassFor(key, { route: "page_generation", granted });
  const mode: BillingMode = billingClass === "byok" ? "byok" : billingClass === "granted" ? "granted" : "platform";
  return { key, keySource: key.source, billingClass, mode };
}

export type GenerateInput = {
  workspaceId: string;
  /** The authenticated user the call is attributed to. */
  userId: string;
  /** The ONE request id: the daily-cap slot and the spend hold share it. */
  requestId: string;
  source: GenerationSource;
  tier: AiQualityTier;
  title: string;
  description?: string | null;
  topic: string;
  city?: string | null;
  state?: string | null;
  categoryPlural?: string | null;
  /** Category used to narrow the inventory grounding query, if known. */
  category?: string | null;
  billing: ResolvedBilling;
  /**
   * Awaited after the spend hold is granted AND marked, IMMEDIATELY before
   * the provider call. Callers holding a daily-cap slot mark it here
   * (markGenerationProviderCalled): from then on the slot is spent and must
   * never be released. A throw here aborts without a provider call: the
   * marked hold is settled at zero (the customer refunded in full).
   */
  beforeProviderCall?: () => Promise<void>;
  /**
   * Saves the page (persistGeneratedPage) BEFORE the call is settled: the
   * customer is charged only for a page that was delivered. A throw here
   * settles the call as not_delivered (refunded) and is rethrown.
   */
  deliver?: (draft: PageDraft) => Promise<void>;
  deps?: { db?: AiDb; transport?: OpenAiTransport };
};

/** What the model wrote, with who paid for it: what persistGeneratedPage stores. */
export type PageDraft = WritePageOutput & { billingMode: BillingMode };

export type GeneratedContent = WritePageOutput & {
  usage: AiUsage | null;
  model: AiModelId;
  keySource: KeySource;
  billingMode: BillingMode;
  settlement: AiSettlement;
};

/**
 * Produce a page's content through the one spend flow. The inventory facts
 * are read first, so the hold covers the real prompt; then runMeteredAiCall
 * reserves, calls beforeProviderCall, marks, calls OpenAI with the write_page
 * format, delivers (the caller's `deliver` saves the page) and settles —
 * charging the customer only when the page was saved. Throws
 * CustomerFacingError with a customer sentence on every refusal and failure;
 * a failure after the call has already been settled (the customer refunded).
 */
export async function generatePageContent(input: GenerateInput): Promise<GeneratedContent> {
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

  const { runMeteredAiCall } = await import("@/lib/ai/spend.server");
  const result = await runMeteredAiCall<WritePageOutput>({
    workspaceId: input.workspaceId,
    userId: input.userId,
    requestId: input.requestId,
    route: "page_generation",
    source: input.source,
    tier: input.tier,
    key: input.billing.key,
    billingClass: input.billing.billingClass,
    instructions: GENERATION_SYSTEM_PROMPT,
    input: buildUserPrompt({
      title: input.title,
      description: input.description,
      topic: input.topic,
      inventoryFacts,
    }),
    format: WRITE_PAGE_FORMAT,
    check: (out) => {
      const n = out.data?.body_markdown?.length ?? 0;
      return n < MIN_BODY_CHARS
        ? { code: "thin_output", message: `Generated body too short (${n} chars)` }
        : null;
    },
    beforeCall: input.beforeProviderCall,
    deliver: input.deliver
      ? async (out, ctx) => {
          const page = out.data!;
          await input.deliver!({
            title: String(page.title ?? ""),
            seo_title: String(page.seo_title ?? ""),
            seo_description: String(page.seo_description ?? ""),
            body_markdown: page.body_markdown,
            billingMode: billingModeFor(ctx.billing),
          });
        }
      : undefined,
    refusalMessages: {
      in_progress: GENERATION_IN_PROGRESS_MESSAGE,
      done: GENERATION_ALREADY_USED_MESSAGE,
      conflict: GENERATION_ALREADY_USED_MESSAGE,
      generation_paused: GENERATION_PAUSED_MESSAGE,
      insufficient: outOfCreditsMessage(),
      mark_refused: GENERATION_UNAVAILABLE_MESSAGE,
    },
    deps: input.deps,
  });
  const page = result.output.data!;
  return {
    title: String(page.title ?? ""),
    seo_title: String(page.seo_title ?? ""),
    seo_description: String(page.seo_description ?? ""),
    body_markdown: page.body_markdown,
    usage: result.output.usage,
    model: result.model,
    keySource: input.billing.keySource,
    billingMode: billingModeFor(result.billing),
    settlement: result.settlement,
  };
}

/**
 * The settlement recorded for a request id, for a replay that returns a page
 * the request already made: nothing is charged again, the charge it reports
 * is the one the database holds. null when the request has no spend row (a
 * hand-written page, or one generated before 000800).
 */
export async function readSpendSettlement(
  workspaceId: string,
  requestId: string,
): Promise<{ status: string; billing: SpendBilling; creditsCharged: number } | null> {
  const { data, error } = await sb()
    .from("ai_spend_reservations")
    .select("status, billing, credits_charged")
    .eq("workspace_id", workspaceId)
    .eq("request_id", requestId)
    .maybeSingle();
  if (error) throw new Error(`ai_spend_reservations read failed: ${error.message}`);
  if (!data) return null;
  return {
    status: String(data.status),
    billing: data.billing as SpendBilling,
    creditsCharged: Number(data.credits_charged) || 0,
  };
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
 * unique index): should a duplicate of the request ever get this far it
 * loses the race, reads the winner's row and returns it flagged `replayed`.
 * (The request id's slot and spend hold make that a second line of defence:
 * one id buys one provider call.) Batch items never pass one; they are keyed
 * by generation_items instead. (The daily cap does not read pages at all: it
 * counts generation_reservations, one per provider call.)
 *
 * The slug comes from generatedPageBaseSlug, the same derivation
 * validatePageRequest checks before a quick page reserves anything.
 *
 * The row records who paid (generation_billing_mode: byok / granted /
 * platform) for reporting. The charge itself was settled in the database
 * before this row was written (ai_spend_reservations).
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
  const baseSlug = generatedPageBaseSlug(input.slug, input.requestedTitle);
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

export const DEFAULT_DAILY_CAP = 50;

/**
 * reserve_generation_slot's cap for a workspace holding the founder /
 * internal unlimited entitlement: none (int4 max). The reservation itself is
 * still taken — one per provider call, same request id as the spend hold —
 * so idempotency, the 24-hour ledger and the "used today" count are
 * unchanged; only the refusal at the cap goes away.
 */
export const UNLIMITED_GENERATION_CAP = 2_147_483_647;

/** The cap a generation passes to reserve_generation_slot. */
export function effectiveDailyCap(dailyCap: number, internalUnlimited: boolean): number {
  return internalUnlimited ? UNLIMITED_GENERATION_CAP : dailyCap;
}

/**
 * Does this workspace hold the founder / internal unlimited entitlement?
 * Read fresh (no cache) through THE predicate (workspace_is_internal_unlimited,
 * migration 20260924000700). For a LIMIT check a failed read is "no": the
 * normal limits apply (fail closed), and it is logged.
 */
export function isInternalWorkspace(workspaceId: string, db?: AiDb): Promise<boolean> {
  return isInternalUnlimitedOrFalse(workspaceId, db);
}

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
 * Provider calls this workspace has made against its daily cap in the last
 * 24 hours — generation_reservations created in the window, one row per
 * provider call, from EVERY generator (quick page, coach city page,
 * Opportunity Engine, each batch item attempt). ONE definition, in the
 * database (generation_consumed_last_24h, migration 20260924000600), shared
 * with reserve_generation_slot so the app and the reservation RPC can never
 * disagree. Pages and batch items are deliberately not read: deleting a
 * draft, editing a page or re-arming an item frees nothing. Used for the
 * "N left today" figure and to size a batch job; the cap itself is enforced
 * by reserveGenerationSlot before every provider call. Throws on an RPC
 * error; callers treat that as "cannot generate".
 */
export async function countConsumedLast24h(workspaceId: string): Promise<number> {
  const { data, error } = await sb().rpc("generation_consumed_last_24h", {
    _workspace_id: workspaceId,
  });
  if (error) throw new Error(error.message);
  return Number(data) || 0;
}

/**
 * What reserve_generation_slot answered for a request id:
 *   reserved     — a slot is now held for this id (new row, or a stale row
 *                  whose provider was never called, retaken): go ahead.
 *   cap_reached  — today's cap is used up: refuse.
 *   in_progress  — this id holds a row younger than 15 minutes and no page
 *                  yet: another request has it RIGHT NOW. Never a second
 *                  provider call for it.
 *   consumed     — this id already spent its provider call (older than 15
 *                  minutes), or a page carries it. The page, if it still
 *                  exists, is the answer; otherwise the id is finished.
 */
export type GenerationSlot = "reserved" | "cap_reached" | "in_progress" | "consumed";

const GENERATION_SLOTS: readonly GenerationSlot[] = [
  "reserved",
  "cap_reached",
  "in_progress",
  "consumed",
];

/** Parse the RPC's answer. Anything unexpected is an error — never "reserved". */
export function parseGenerationSlot(data: unknown): GenerationSlot {
  if (typeof data === "string" && (GENERATION_SLOTS as readonly string[]).includes(data)) {
    return data as GenerationSlot;
  }
  throw new Error(`reserve_generation_slot returned an unexpected value: ${JSON.stringify(data)}`);
}

/**
 * Ask for one of today's generation slots for this request id, atomically.
 * The RPC serialises per workspace (an advisory lock), counts what the last
 * 24 hours consumed with the same definition as countConsumedLast24h, and
 * inserts the reservation only when a slot is free — so N concurrent
 * requests at remaining = 1 admit exactly one, and N concurrent requests
 * with the SAME id admit exactly one ('in_progress' for the rest). Every
 * generator calls this before its provider call; a batch item uses one id
 * per attempt (batchAttemptRequestId). Throws on an RPC error or an
 * unexpected answer; the caller treats that as "cannot generate" (never
 * uncapped).
 */
export async function reserveGenerationSlot(
  workspaceId: string,
  requestId: string,
  cap: number,
): Promise<GenerationSlot> {
  const { data, error } = await sb().rpc("reserve_generation_slot", {
    _workspace_id: workspaceId,
    _request_id: requestId,
    _cap: Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0,
  });
  if (error) throw new Error(`reserve_generation_slot failed: ${error.message}`);
  return parseGenerationSlot(data);
}

/**
 * Record, IMMEDIATELY before the provider request, that this reservation's
 * provider call is happening. From then on the slot is spent for good:
 * release_generation_slot refuses a marked row, and the id can never buy a
 * second call. The RPC answers false when the row is gone or already marked
 * — another request got there — and the caller must then NOT call the
 * provider: this throws the in-progress refusal. A failed RPC throws too
 * (the provider is not called either way).
 */
export async function markGenerationProviderCalled(
  workspaceId: string,
  requestId: string,
): Promise<void> {
  const { data, error } = await sb().rpc("mark_generation_provider_called", {
    _workspace_id: workspaceId,
    _request_id: requestId,
  });
  if (error) throw new Error(`mark_generation_provider_called failed: ${error.message}`);
  if (data !== true) throw new CustomerFacingError(GENERATION_IN_PROGRESS_MESSAGE);
}

/**
 * Give a slot back when the provider was never called. ONLY the request that
 * was granted the reservation ('reserved') calls this, and only on a path
 * that ended before its provider call; the RPC itself deletes the row only
 * while provider_called_at is NULL, so a spent slot can never be freed, even
 * by mistake. Best effort: a reservation that survives here ages out of the
 * cap after 24 hours, so a failure is logged, never thrown over the error
 * that caused the release.
 */
export async function releaseGenerationSlot(workspaceId: string, requestId: string): Promise<void> {
  const { error } = await sb().rpc("release_generation_slot", {
    _workspace_id: workspaceId,
    _request_id: requestId,
  });
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
