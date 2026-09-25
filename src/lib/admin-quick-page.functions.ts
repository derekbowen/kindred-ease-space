import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import {
  CustomerFacingError,
  GENERATION_ALREADY_USED_MESSAGE,
  GENERATION_DEFAULT_MODEL,
  GENERATION_IN_PROGRESS_MESSAGE,
  GENERATION_MODEL_IDS,
  GENERATION_UNAVAILABLE_MESSAGE,
  TYPICAL_PAGE_TOKENS,
  checkStoredPageContract,
  contractFailureMessage,
  customerMessage,
  dailyCapMessage,
  findPageByRequestId,
  generatePageContent,
  markGenerationProviderCalled,
  persistGeneratedPage,
  providerUsageOf,
  readPlatformSettings,
  recordFailedGeneration,
  releaseGenerationSlot,
  reserveGenerationSlot,
  resolveBillingMode,
  settleGeneration,
  validatePageRequest,
  type ExistingPage,
  type GeneratedContent,
  type ItemBillingStatus,
  type PersistedPage,
  type ResolvedBilling,
} from "@/lib/generation.server";

/**
 * Workspace-scoped "quick page" creator. Generates markdown via OpenRouter
 * through the shared generation core (src/lib/generation.server.ts) and,
 * when asked, publishes to tenant_pages so /a/{slug} serves the page.
 *
 * Order of operations is deliberate: every check that needs neither the
 * database nor the provider (title, slug) → policy gates (pause, a daily-cap
 * RESERVATION, who pays) → generate (the reservation is marked spent right
 * before the provider request) → write the draft row → settle credits →
 * (optionally) contract check + entitlement gate. A failed generation is never
 * charged, BYOK keys and beta grants are never metered, and nothing goes live
 * without passing the published-page contract. A failure after the provider
 * call keeps its slot counted for 24 hours and logs the spend as 'failed':
 * the platform key is never looped for free.
 *
 * Idempotency: the browser sends a generationRequestId it keeps across
 * retries until it gets a response. A replay (lost response + resubmit)
 * returns the page that request already made — no generation, and the charge
 * it reports is the one on the ledger (or the one still owed, settled then).
 * An id buys at most ONE provider call: a second request with it is told the
 * first is still running, or — once that call is spent and its page gone —
 * that the id is finished.
 *
 * runQuickPage is the pipeline; createQuickPage is its server-function
 * boundary. Server code that generates a page (the coach's create_city_page,
 * the Opportunity Engine) calls runQuickPage directly — never the server fn.
 */

export const QuickPageInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  title: z.string().trim().min(3).max(140),
  description: z.string().trim().max(500).optional().default(""),
  topic: z.string().trim().min(10).max(2000),
  // Only ids the picker offers. An unknown id is a validation error, never a
  // silent swap for the platform default (the Pro tier) at the customer's cost.
  model: z.enum(GENERATION_MODEL_IDS).default(GENERATION_DEFAULT_MODEL),
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
   *  the daily-cap ledger counts it. */
  generationRequestId: z.string().uuid().optional(),
});

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

const UNBILLED_DRAFT_REASON =
  "Saved as a draft: the page could not be billed — this workspace is out of included AI generation. Contact support, then publish it from All pages.";

const wordCount = (s: string | null | undefined) =>
  (s ?? "").trim() ? (s ?? "").trim().split(/\s+/).length : 0;

/**
 * The page this request already made, returned as-is — with an honest
 * charge. A page generated on the platform key may still owe its settlement
 * (the original run can die between the draft row and the charge), so it is
 * settled here: idempotent through the ledger, that either reports the charge
 * already recorded or performs the one owed. BYOK and granted pages, and
 * pages from before the billing mode was recorded, owe nothing.
 */
async function replayResult(
  existing: ExistingPage,
  ctx: { workspaceId: string; userId: string; model: string },
): Promise<QuickPageResult> {
  let creditsCharged = 0;
  let billing: ItemBillingStatus = "free";
  let draftReason: string | null = null;
  if (existing.generation_billing_mode === "platform") {
    // Token counts are not stored on the page; a typical page is the
    // estimate. It only matters when the charge is still owed.
    const settled = await settleGeneration({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      keySource: "platform",
      billingMode: "platform",
      model: ctx.model,
      promptTokens: TYPICAL_PAGE_TOKENS.prompt,
      completionTokens: TYPICAL_PAGE_TOKENS.completion,
      feature: "quick_page",
      refId: existing.id,
    });
    creditsCharged = settled.creditsCharged;
    billing = settled.billingStatus;
    if (settled.billing === "unbilled") draftReason = UNBILLED_DRAFT_REASON;
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
    draftReason,
    contractViolations: [],
  };
}

/**
 * The quick-page pipeline. The caller has already authorised `userId` for
 * `data.workspaceId` (the server fn asserts membership; the coach action and
 * the Opportunity Engine assert it before they get here). Throws
 * CustomerFacingError for the refusals a customer should read; anything else
 * is an internal error the boundary replaces (customerMessage).
 */
export async function runQuickPage(data: QuickPageInput, userId: string): Promise<QuickPageResult> {
  // 0. Replay? The page this request already made comes back untouched.
  if (data.generationRequestId) {
    const existing = await findPageByRequestId(data.workspaceId, data.generationRequestId);
    if (existing) {
      return replayResult(existing, { workspaceId: data.workspaceId, userId, model: data.model });
    }
  }
  const generationRequestId = data.generationRequestId ?? crypto.randomUUID();

  // 1. Everything decidable without the database or the provider, BEFORE a
  //    slot is reserved or a token is spent. An underivable slug ("---") used
  //    to fail in persistGeneratedPage — after the paid call — and give its
  //    slot back, so a loop of such requests was unlimited free generation.
  validatePageRequest({ title: data.title, slug: data.slug });

  // 2. The same platform gates the batch generator applies: the pause switch
  //    (fails closed on a read error) and the per-workspace daily cap. The cap
  //    is a RESERVATION taken atomically for this request id
  //    (reserve_generation_slot counts every provider call of the last 24
  //    hours under a per-workspace lock), so N requests at remaining = 1 admit
  //    exactly one, and N requests with the same id admit exactly one.
  const settings = await readPlatformSettings();
  if (settings.paused) {
    throw new CustomerFacingError("Generation is paused platform-wide right now.");
  }
  const slot = await reserveGenerationSlot(
    data.workspaceId,
    generationRequestId,
    settings.dailyCap,
  );
  if (slot === "cap_reached") {
    throw new CustomerFacingError(dailyCapMessage(settings.dailyCap, 0));
  }
  if (slot === "in_progress") throw new CustomerFacingError(GENERATION_IN_PROGRESS_MESSAGE);
  if (slot === "consumed") {
    // This id already spent its provider call. Its page, if it still exists,
    // is the answer; a deleted draft is NOT regenerated for free.
    const existing = await findPageByRequestId(data.workspaceId, generationRequestId);
    if (existing) {
      return replayResult(existing, { workspaceId: data.workspaceId, userId, model: data.model });
    }
    throw new CustomerFacingError(GENERATION_ALREADY_USED_MESSAGE);
  }

  // From here this request holds the slot ('reserved'). It is given back only
  // if the provider is never called; once the call is marked it stays counted.
  let providerCalled = false;
  let billing: ResolvedBilling | null = null;
  let gen: GeneratedContent | null = null;
  let page: PersistedPage;
  try {
    // 3. Who pays — BYOK, a beta grant, or a platform key with the funds for
    //    a whole page. Refused here before anything is spent.
    billing = await resolveBillingMode(data.workspaceId, data.model);

    // 4. Generate. Nothing is charged here; a provider error or thin output
    //    throws and the customer keeps their credits. The reservation is
    //    marked spent immediately before the provider request.
    gen = await generatePageContent({
      workspaceId: data.workspaceId,
      title: data.title,
      description: data.description,
      topic: data.topic,
      city: data.city,
      state: data.state,
      categoryPlural: data.categoryPlural,
      model: data.model,
      billing,
      beforeProviderCall: async () => {
        await markGenerationProviderCalled(data.workspaceId, generationRequestId);
        providerCalled = true;
      },
    });

    // 5. Draft row, idempotent per request id. If a concurrent duplicate got
    //    there first this returns ITS page and we settle nothing — it does.
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
    if (!providerCalled) {
      // Refused or failed before the provider was called: nothing was spent,
      // so the slot goes back (the RPC frees an unmarked row only).
      await releaseGenerationSlot(data.workspaceId, generationRequestId);
    } else {
      // The provider was paid and no page came of it. The slot stays counted
      // for 24 hours; the customer is charged nothing; ops see the spend.
      await recordFailedGeneration({
        workspaceId: data.workspaceId,
        userId,
        keySource: billing?.source ?? "platform",
        model: gen?.model ?? data.model,
        feature: "quick_page",
        usage: gen
          ? { promptTokens: gen.promptTokens, completionTokens: gen.completionTokens }
          : providerUsageOf(e),
        error: e,
      });
    }
    throw e;
  }
  if (page.replayed) {
    const existing = await findPageByRequestId(data.workspaceId, generationRequestId);
    if (existing) {
      return replayResult(existing, { workspaceId: data.workspaceId, userId, model: data.model });
    }
  }

  // 6. Settle AFTER the page exists. Platform key only; BYOK and grants are
  //    unmetered. A deduction that fails is reported as such, never as a
  //    charge — and the draft is kept, unpublished, so the customer sees why.
  const settled = await settleGeneration({
    workspaceId: data.workspaceId,
    userId,
    keySource: gen.keySource,
    billingMode: gen.billingMode,
    model: gen.model,
    promptTokens: gen.promptTokens,
    completionTokens: gen.completionTokens,
    feature: "quick_page",
    refId: page.id,
  });

  // 7. Optional publish: contract first, then the atomic entitlement gate.
  //    Either failure KEEPS the draft (the AI work isn't wasted) and tells
  //    the caller why in plain language.
  let published = false;
  let limitReached = false;
  let limitMessage: string | null = null;
  let draftReason: string | null = null;
  let contractViolations: string[] = [];
  if (settled.billing === "unbilled") {
    draftReason = UNBILLED_DRAFT_REASON;
  } else if (data.autoPublish) {
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
    creditsCharged: settled.creditsCharged,
    billing: settled.billingStatus,
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
    await assertWorkspaceMember(data.workspaceId, context.userId);
    try {
      return await runQuickPage(data, context.userId);
    } catch (e) {
      // The browser sees customer-written refusals verbatim and nothing else:
      // a PostgREST message or a constraint name is logged and replaced.
      throw new Error(customerMessage(e, GENERATION_UNAVAILABLE_MESSAGE));
    }
  });
