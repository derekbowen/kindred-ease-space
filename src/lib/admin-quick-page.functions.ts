import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import {
  CustomerFacingError,
  GENERATION_ALREADY_USED_MESSAGE,
  GENERATION_DEFAULT_TIER,
  GENERATION_IN_PROGRESS_MESSAGE,
  GENERATION_PAUSED_MESSAGE,
  GENERATION_TIERS,
  GENERATION_UNAVAILABLE_MESSAGE,
  billingStatusFor,
  checkStoredPageContract,
  contractFailureMessage,
  customerMessage,
  dailyCapMessage,
  findPageByRequestId,
  generatePageContent,
  markGenerationProviderCalled,
  persistGeneratedPage,
  readPlatformSettings,
  readSpendSettlement,
  releaseGenerationSlot,
  reserveGenerationSlot,
  resolveBillingMode,
  validatePageRequest,
  type ExistingPage,
  type GeneratedContent,
  type GenerationSource,
  type ItemBillingStatus,
  type PersistedPage,
  type ResolvedBilling,
} from "@/lib/generation.server";
import type { AiDb } from "@/lib/ai/spend.server";
import type { OpenAiTransport } from "@/lib/ai/openai.server";

/**
 * Workspace-scoped "quick page" creator. Generates markdown through the
 * shared generation core (src/lib/generation.server.ts → runMeteredAiCall →
 * OpenAI) and, when asked, publishes to tenant_pages so /a/{slug} serves it.
 *
 * Order of operations is deliberate: every check that needs neither the
 * database nor the provider (title, slug) → the pause switch (fail fast; the
 * spend hold re-checks it atomically) → who pays (the workspace's own key, a
 * beta grant, or the platform key) → the daily-cap slot → the spend hold
 * (refused → the slot goes back) → mark both → the OpenAI call → settle (the
 * actual cost, capped at the hold, refunded down from it) → the draft row →
 * (optionally) contract check + entitlement gate. Nothing goes live without
 * passing the published-page contract. A failure after the provider call
 * keeps its slot counted for 24 hours and is settled with the usage OpenAI
 * reported: the platform key is never looped for free.
 *
 * Idempotency: the browser sends a generationRequestId it keeps across
 * retries until it gets a response. A replay (lost response + resubmit)
 * returns the page that request already made — no generation, and the charge
 * it reports is the one the database settled. An id buys at most ONE provider
 * call: a second request with it is told the first is still running, or —
 * once that call is spent and its page gone — that the id is finished.
 *
 * runQuickPage is the pipeline; createQuickPage is its server-function
 * boundary. Server code that generates a page (the coach's create_city_page,
 * the Opportunity Engine) calls runQuickPage directly — never the server fn.
 */

export const QuickPageInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    title: z.string().trim().min(3).max(140),
    description: z.string().trim().max(500).optional().default(""),
    topic: z.string().trim().min(10).max(2000),
    // A quality TIER, never a model: the server maps it (src/lib/ai/models.ts).
    // Standard unless the customer picks premium; nothing escalates on its own.
    quality: z.enum(GENERATION_TIERS).default(GENERATION_DEFAULT_TIER),
    slug: z.string().trim().max(120).optional(),
    city: z.string().trim().max(120).optional(),
    state: z.string().trim().max(80).optional(),
    categoryPlural: z.string().trim().max(80).optional(),
    /** Default true preserves the Quick Page Builder's existing behaviour
     *  (generate then immediately attempt publish). The Opportunity Engine
     *  passes false: an approved opportunity produces a DRAFT for customer
     *  review, and publishing stays a separate deliberate step through the
     *  unchanged entitlement gate. */
    autoPublish: z.boolean().default(true),
    /** Client-generated, kept across retries until success. Optional so a
     *  caller with its own identity can omit it; every page still gets one so
     *  the daily-cap ledger and the spend record count it. */
    generationRequestId: z.string().uuid().optional(),
  })
  // Unknown keys are refused: a body carrying `model`, `max_output_tokens`,
  // `temperature` or any other provider parameter fails validation.
  .strict();

export type QuickPageInput = z.infer<typeof QuickPageInputSchema>;

export type QuickPageResult = {
  ok: true;
  page: PersistedPage;
  words: number;
  creditsCharged: number;
  billing: ItemBillingStatus;
  /** True when this request had already produced a page and it was returned as-is. */
  replayed: boolean;
  published: boolean;
  limitReached: boolean;
  limitMessage: string | null;
  draftReason: string | null;
  contractViolations: string[];
};

/** Test seam for the database and the provider transport. Production passes nothing. */
export type QuickPageDeps = { db?: AiDb; transport?: OpenAiTransport; source?: GenerationSource };

const wordCount = (s: string | null | undefined) =>
  (s ?? "").trim() ? (s ?? "").trim().split(/\s+/).length : 0;

/**
 * The page this request already made, returned as-is with the charge the
 * database recorded for its request id. Nothing is settled here: the call
 * was settled when it ran (or is held and will be, by the reaper at the
 * latest). Pages without a spend record owe nothing.
 */
async function replayResult(existing: ExistingPage, ctx: { workspaceId: string; requestId: string }): Promise<QuickPageResult> {
  let creditsCharged = 0;
  let billing: ItemBillingStatus = "free";
  const spend = await readSpendSettlement(ctx.workspaceId, ctx.requestId);
  if (spend) {
    if (spend.status === "settled") {
      creditsCharged = spend.creditsCharged;
      billing = billingStatusFor({ settled: true, billing: spend.billing, creditsCharged });
    } else if (spend.status === "held" || spend.status === "called") {
      billing = "pending";
    }
  }
  return {
    ok: true,
    page: {
      id: existing.id,
      slug: existing.slug,
      title: existing.title ?? "",
      url_path: `/a/${existing.slug}`,
      replayed: true,
    },
    words: wordCount(existing.body_markdown),
    creditsCharged,
    billing,
    replayed: true,
    published: existing.status === "published",
    limitReached: false,
    limitMessage: null,
    draftReason: null,
    contractViolations: [],
  };
}

/**
 * The quick-page pipeline. The caller has already authorised `userId` for
 * `data.workspaceId` (the server fn asserts membership; the coach action and
 * the Opportunity Engine assert it before they get here; ai_reserve checks
 * it again). Throws CustomerFacingError for the refusals a customer should
 * read; anything else is an internal error the boundary replaces
 * (customerMessage).
 */
export async function runQuickPage(
  data: QuickPageInput,
  userId: string,
  deps: QuickPageDeps = {},
): Promise<QuickPageResult> {
  // 0. Replay? The page this request already made comes back untouched.
  if (data.generationRequestId) {
    const existing = await findPageByRequestId(data.workspaceId, data.generationRequestId);
    if (existing) {
      return replayResult(existing, { workspaceId: data.workspaceId, requestId: data.generationRequestId });
    }
  }
  const generationRequestId = data.generationRequestId ?? crypto.randomUUID();

  // 1. Everything decidable without the database or the provider, BEFORE a
  //    slot is reserved or a token is spent. An underivable slug ("---") used
  //    to fail in persistGeneratedPage — after the paid call — and give its
  //    slot back, so a loop of such requests was unlimited free generation.
  validatePageRequest({ title: data.title, slug: data.slug });

  // 2. The pause switch (fails closed on a read error). ai_reserve enforces it
  //    atomically as well; this read only refuses early, before a slot.
  const settings = await readPlatformSettings();
  if (settings.paused) {
    throw new CustomerFacingError(GENERATION_PAUSED_MESSAGE);
  }

  // 3. Who pays — the workspace's own key, a beta grant, or the platform key.
  //    No key is a refusal here, before anything is reserved.
  const billing: ResolvedBilling = await resolveBillingMode(data.workspaceId, deps.db);

  // 4. The daily cap: a RESERVATION taken atomically for this request id
  //    (reserve_generation_slot counts every provider call of the last 24
  //    hours under a per-workspace lock), so N requests at remaining = 1 admit
  //    exactly one, and N requests with the same id admit exactly one.
  const slot = await reserveGenerationSlot(data.workspaceId, generationRequestId, settings.dailyCap);
  if (slot === "cap_reached") {
    throw new CustomerFacingError(dailyCapMessage(settings.dailyCap, 0));
  }
  if (slot === "in_progress") throw new CustomerFacingError(GENERATION_IN_PROGRESS_MESSAGE);
  if (slot === "consumed") {
    // This id already spent its provider call. Its page, if it still exists,
    // is the answer; a deleted draft is NOT regenerated for free.
    const existing = await findPageByRequestId(data.workspaceId, generationRequestId);
    if (existing) {
      return replayResult(existing, { workspaceId: data.workspaceId, requestId: generationRequestId });
    }
    throw new CustomerFacingError(GENERATION_ALREADY_USED_MESSAGE);
  }

  // From here this request holds the slot ('reserved'). It is given back only
  // if the slot is never marked; once marked (immediately before the provider
  // call) it stays counted.
  let slotMarked = false;
  let gen: GeneratedContent;
  let page: PersistedPage;
  try {
    // 5–9. The spend hold, the marks, the call and the settlement. A refused
    //      hold throws before beforeProviderCall runs.
    gen = await generatePageContent({
      workspaceId: data.workspaceId,
      userId,
      requestId: generationRequestId,
      source: deps.source ?? "quick_page",
      tier: data.quality,
      title: data.title,
      description: data.description,
      topic: data.topic,
      city: data.city,
      state: data.state,
      categoryPlural: data.categoryPlural,
      billing,
      beforeProviderCall: async () => {
        await markGenerationProviderCalled(data.workspaceId, generationRequestId);
        slotMarked = true;
      },
      deps: { db: deps.db, transport: deps.transport },
    });

    // 10. Draft row, idempotent per request id.
    page = await persistGeneratedPage({
      workspaceId: data.workspaceId,
      generated: gen,
      requestedTitle: data.title,
      requestedDescription: data.description,
      slug: data.slug,
      city: data.city,
      state: data.state,
      categoryPlural: data.categoryPlural,
      generationRequestId,
    });
  } catch (e) {
    if (!slotMarked) {
      // Refused or failed before the provider could be called: the slot goes
      // back (the RPC frees an unmarked row only). The spend hold, if one was
      // taken, was released by runMeteredAiCall.
      await releaseGenerationSlot(data.workspaceId, generationRequestId);
    }
    throw e;
  }
  if (page.replayed) {
    const existing = await findPageByRequestId(data.workspaceId, generationRequestId);
    if (existing) {
      return replayResult(existing, { workspaceId: data.workspaceId, requestId: generationRequestId });
    }
  }

  // 11. Optional publish: contract first, then the atomic entitlement gate.
  //     Either failure KEEPS the draft (the AI work isn't wasted) and tells
  //     the caller why in plain language.
  let published = false;
  let limitReached = false;
  let limitMessage: string | null = null;
  let draftReason: string | null = null;
  let contractViolations: string[] = [];
  if (data.autoPublish) {
    const check = await checkStoredPageContract(data.workspaceId, page.id);
    if (!check.ok) {
      contractViolations = check.blocking.map((v) => `${v.message} ${v.fix}`.trim());
      draftReason = contractFailureMessage(check);
    } else {
      const { publishPagesAtomically, pageLimitMessage } =
        await import("@/lib/entitlements.functions");
      const gate = await publishPagesAtomically(data.workspaceId, [page.id]);
      published = gate.published > 0;
      limitReached = !published;
      if (limitReached) {
        limitMessage = `${pageLimitMessage(gate.limit)} The generated page was saved as a draft.`;
        draftReason = limitMessage;
      }
    }
  }

  return {
    ok: true,
    page,
    words: wordCount(gen.body_markdown),
    creditsCharged: gen.settlement.creditsCharged,
    billing: billingStatusFor(gen.settlement),
    replayed: false,
    published,
    limitReached,
    limitMessage,
    draftReason,
    contractViolations,
  };
}

export const createQuickPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => QuickPageInputSchema.parse(data))
  .handler(async ({ data, context }): Promise<QuickPageResult> => {
    try {
      await assertWorkspaceMember(data.workspaceId, context.userId);
      return await runQuickPage(data, context.userId);
    } catch (e) {
      // The browser sees customer-written refusals verbatim and nothing else:
      // a PostgREST message or a constraint name is logged and replaced.
      throw new Error(customerMessage(e, GENERATION_UNAVAILABLE_MESSAGE));
    }
  });
