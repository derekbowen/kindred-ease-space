import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import {
  GENERATION_DEFAULT_MODEL,
  checkStoredPageContract,
  contractFailureMessage,
  generatePageContent,
  persistGeneratedPage,
  settleGeneration,
} from "@/lib/generation.server";

/**
 * Workspace-scoped "quick page" creator. Generates markdown via OpenRouter
 * through the shared generation core (src/lib/generation.server.ts) and,
 * when asked, publishes to tenant_pages so /p/{slug} serves the page.
 *
 * Order of operations is deliberate: generate → write the draft row → settle
 * credits → (optionally) contract check + entitlement gate. A failed
 * generation is never charged, BYOK keys are never metered, and nothing goes
 * live without passing the published-page contract.
 */

const InputSchema = z.object({
  workspaceId: workspaceIdSchema,
  title: z.string().trim().min(3).max(140),
  description: z.string().trim().max(500).optional().default(""),
  topic: z.string().trim().min(10).max(2000),
  // Cheapest allowlisted model. Anything off the allowlist is mapped by
  // resolvePlatformModel to the platform default, so an unknown id can never
  // silently upgrade the customer to the Pro tier.
  model: z.string().default(GENERATION_DEFAULT_MODEL),
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
});

export const createQuickPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => InputSchema.parse(data))
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);

    // 1. Generate. Nothing is charged here; a provider error or thin output
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
    });

    // 2. Draft row.
    const page = await persistGeneratedPage({
      workspaceId: data.workspaceId,
      generated: gen,
      requestedTitle: data.title,
      requestedDescription: data.description,
      slug: data.slug,
      city: data.city,
      state: data.state,
      categoryPlural: data.categoryPlural,
    });

    // 3. Settle AFTER the page exists. Platform key only; BYOK is unmetered.
    const { creditsCharged } = await settleGeneration({
      workspaceId: data.workspaceId,
      userId: context.userId,
      keySource: gen.keySource,
      model: gen.model,
      promptTokens: gen.promptTokens,
      completionTokens: gen.completionTokens,
      feature: "quick_page",
      refId: page.id,
    });

    // 4. Optional publish: contract first, then the atomic entitlement gate.
    //    Either failure KEEPS the draft (the AI work isn't wasted) and tells
    //    the caller why in plain language.
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
      words: gen.body_markdown.split(/\s+/).length,
      creditsCharged,
      published,
      limitReached,
      limitMessage,
      draftReason,
      contractViolations,
    };
  });
