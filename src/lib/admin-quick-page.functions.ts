import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import {
  GENERATION_DEFAULT_MODEL,
  GENERATION_MODEL_IDS,
  checkStoredPageContract,
  contractFailureMessage,
  countConsumedLast24h,
  dailyCapMessage,
  dailyCapRemaining,
  findPageByRequestId,
  generatePageContent,
  persistGeneratedPage,
  readPlatformSettings,
  resolveBillingMode,
  settleGeneration,
  type ExistingPage,
  type ItemBillingStatus,
  type PersistedPage,
} from "@/lib/generation.server";

/**
 * Workspace-scoped "quick page" creator. Generates markdown via OpenRouter
 * through the shared generation core (src/lib/generation.server.ts) and,
 * when asked, publishes to tenant_pages so /a/{slug} serves the page.
 *
 * Order of operations is deliberate: policy gates (pause, daily cap, who
 * pays) → generate → write the draft row → settle credits → (optionally)
 * contract check + entitlement gate. A failed generation is never charged,
 * BYOK keys and beta grants are never metered, and nothing goes live without
 * passing the published-page contract.
 *
 * Idempotency: the browser sends a generationRequestId it keeps across
 * retries until it gets a response. A replay (lost response + resubmit)
 * returns the page that request already made — no generation, no charge.
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
  /** Client-generated, kept across retries until success. Optional so the
   *  Opportunity Engine (which has its own status machine) can omit it; every
   *  page still gets one so the daily-cap ledger counts it. */
  generationRequestId: z.string().uuid().optional(),
});

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

const wordCount = (s: string | null | undefined) =>
  (s ?? "").trim() ? (s ?? "").trim().split(/\s+/).length : 0;

function replayResult(existing: ExistingPage): QuickPageResult {
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
    creditsCharged: 0,
    billing: "free",
    replayed: true,
    published: existing.status === "published",
    limitReached: false,
    limitMessage: null,
    draftReason: null,
    contractViolations: [],
  };
}

export const createQuickPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => QuickPageInputSchema.parse(data))
  .handler(async ({ data, context }): Promise<QuickPageResult> => {
    await assertWorkspaceMember(data.workspaceId, context.userId);

    // 0. Replay? The page this request already made comes back untouched.
    if (data.generationRequestId) {
      const existing = await findPageByRequestId(data.workspaceId, data.generationRequestId);
      if (existing) return replayResult(existing);
    }
    const generationRequestId = data.generationRequestId ?? crypto.randomUUID();

    // 1. The same platform gates the batch generator applies: the pause switch
    //    (fails closed on a read error) and the per-workspace daily cap, which
    //    counts batch items AND quick pages — see countConsumedLast24h.
    const settings = await readPlatformSettings();
    if (settings.paused) {
      throw new Error("Generation is paused platform-wide right now.");
    }
    const consumed = await countConsumedLast24h(data.workspaceId);
    if (dailyCapRemaining(settings.dailyCap, consumed) === 0) {
      throw new Error(dailyCapMessage(settings.dailyCap, 0));
    }

    // 2. Who pays — BYOK, a beta grant, or a platform key with the funds for
    //    a whole page. Refused here before anything is spent.
    const billing = await resolveBillingMode(data.workspaceId, data.model);

    // 3. Generate. Nothing is charged here; a provider error or thin output
    //    throws and the customer keeps their credits.
    const gen = await generatePageContent({
      workspaceId: data.workspaceId,
      title: data.title,
      description: data.description,
      topic: data.topic,
      city: data.city,
      state: data.state,
      categoryPlural: data.categoryPlural,
      model: data.model,
      billing,
    });

    // 4. Draft row, idempotent per request id. If a concurrent duplicate got
    //    there first this returns ITS page and we settle nothing — it does.
    const page = await persistGeneratedPage({
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
    if (page.replayed) {
      const existing = await findPageByRequestId(data.workspaceId, generationRequestId);
      if (existing) return replayResult(existing);
    }

    // 5. Settle AFTER the page exists. Platform key only; BYOK and grants are
    //    unmetered. A deduction that fails is reported as such, never as a
    //    charge — and the draft is kept, unpublished, so the customer sees why.
    const settled = await settleGeneration({
      workspaceId: data.workspaceId,
      userId: context.userId,
      keySource: gen.keySource,
      billingMode: gen.billingMode,
      model: gen.model,
      promptTokens: gen.promptTokens,
      completionTokens: gen.completionTokens,
      feature: "quick_page",
      refId: page.id,
    });

    // 6. Optional publish: contract first, then the atomic entitlement gate.
    //    Either failure KEEPS the draft (the AI work isn't wasted) and tells
    //    the caller why in plain language.
    let published = false;
    let limitReached = false;
    let limitMessage: string | null = null;
    let draftReason: string | null = null;
    let contractViolations: string[] = [];
    if (settled.billing === "unbilled") {
      draftReason =
        "Saved as a draft: the page could not be billed (out of AI credits). Top up in Billing, then publish it from All pages.";
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
  });
