import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import { OPENROUTER_BASE, resolvePlatformModel, creditsForUsage } from "@/lib/ai-pricing";
import {
  findUniqueTenantSlug,
  getActiveTemplateId,
  slugifyPage,
} from "@/lib/tenant-page-helpers.server";

/**
 * Workspace-scoped "quick page" creator. Generates markdown via OpenRouter
 * and publishes directly to tenant_pages so /p/{slug} serves the page.
 */

const InputSchema = z.object({
  workspaceId: workspaceIdSchema,
  title: z.string().trim().min(3).max(140),
  description: z.string().trim().max(500).optional().default(""),
  topic: z.string().trim().min(10).max(2000),
  model: z.string().default("google/gemini-2.5-flash"),
  slug: z.string().trim().max(120).optional(),
});

const SYSTEM = `
You write SEO-optimised brand content for a marketplace business.
Voice: confident, friendly, customer-first, never spammy. Short paragraphs.
Real, useful copy — no filler, no "in this article we will".
Format: Markdown only. Use ## and ### headings.
Always end with a short CTA paragraph.
Return your answer ONLY by calling the write_page tool.
`.trim();

const TOOL_SCHEMA = {
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
        body_markdown: { type: "string", description: "Full markdown body, 600-1200 words, no frontmatter" },
      },
      required: ["title", "seo_title", "seo_description", "body_markdown"],
      additionalProperties: false,
    },
  },
};

export const createQuickPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => InputSchema.parse(data))
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);

    // BYOK first, platform env-var fallback.
    const { getWorkspaceSecret } = await import("@/lib/workspace-secrets.server");
    const apiKey = await getWorkspaceSecret(data.workspaceId, "OPENROUTER_API_KEY", "OPENROUTER_API_KEY");
    if (!apiKey) throw new Error("No AI key configured. Add a BYOK OpenRouter key under Settings → API Keys.");
    const model = resolvePlatformModel(data.model);

    // Bill the platform credit system (same model as ai-proxy): free trial
    // quota first, then purchased credits. No hard cap — out of credits => top up.
    let billing: "free_quota" | "credits" = "credits";
    const { error: qErr } = await supabaseAdmin.rpc("consume_platform_ai_credit", {
      _workspace_id: data.workspaceId,
    });
    if (!qErr) {
      billing = "free_quota";
    } else if (typeof qErr.message === "string" && qErr.message.includes("platform_ai_quota_exhausted")) {
      const { data: bal } = await supabaseAdmin
        .from("credit_balances").select("balance").eq("workspace_id", data.workspaceId).maybeSingle();
      if (!bal || bal.balance <= 0) {
        throw new Error("Out of AI credits. Top up in Billing to keep generating.");
      }
    } else {
      throw new Error(qErr.message);
    }

    const baseSlug = slugifyPage(data.slug || data.title);
    if (!baseSlug) throw new Error("Could not derive slug from title");
    const slug = await findUniqueTenantSlug(data.workspaceId, baseSlug);
    const templateId = await getActiveTemplateId("city_hub");

    const userPrompt = `Write a brand page.

Title (H1): "${data.title}"
${data.description ? `One-line summary: "${data.description}"` : ""}

What this page should be about (interpret literally and build the article around this):
${data.topic}

Length: 600-1200 words.
Use ## for the main sections and ### for sub-points. Lead with a strong opening — no fluff.
seo_title (≤60 chars) and seo_description (≤155 chars) optimised for the topic.`;

    const resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userPrompt },
        ],
        tools: [TOOL_SCHEMA],
        tool_choice: { type: "function", function: { name: "write_page" } },
      }),
    });

    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`AI provider ${resp.status}: ${t.slice(0, 300)}`);
    }
    const json = await resp.json();
    const promptTokens = json?.usage?.prompt_tokens ?? 0;
    const completionTokens = json?.usage?.completion_tokens ?? 0;
    const tc = json?.choices?.[0]?.message?.tool_calls?.[0];
    if (!tc?.function?.arguments) throw new Error("AI response missing tool call");
    const gen = JSON.parse(tc.function.arguments) as {
      title: string;
      seo_title: string;
      seo_description: string;
      body_markdown: string;
    };
    if (!gen.body_markdown || gen.body_markdown.length < 300) {
      throw new Error(`Generated body too short (${gen.body_markdown?.length ?? 0} chars)`);
    }

    const url_path = `/p/${slug}`;
    const pageTitle = gen.title || data.title;
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("tenant_pages")
      .insert({
        workspace_id: data.workspaceId,
        template_id: templateId,
        slug,
        title: pageTitle,
        meta_description: (gen.seo_description || data.description || "").slice(0, 320),
        h1: pageTitle,
        body_markdown: gen.body_markdown,
        variables: {},
        listing_filter: { limit: 24, sort: "newest" },
        status: "published",
        published_at: new Date().toISOString(),
      })
      .select("id, slug, title")
      .single();
    if (insErr) throw new Error(insErr.message);

    // Settle credits AFTER success (no charge on failure) + log usage.
    let creditsCharged = 0;
    if (billing === "credits") {
      creditsCharged = creditsForUsage(model, promptTokens, completionTokens);
      await supabaseAdmin.rpc("deduct_credits", {
        _workspace_id: data.workspaceId,
        _amount: creditsCharged,
        _reason: "ai_usage",
        _ai_model: model,
        _ref_type: "quick_page",
        _ref_id: inserted.id,
        _metadata: { provider: "platform", feature: "quick_page" },
      });
    }
    await supabaseAdmin.from("ai_usage_log").insert({
      workspace_id: data.workspaceId,
      user_id: context.userId,
      provider: "platform",
      model,
      feature: "quick_page",
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      used_byok: false,
      status: "ok",
    });

    return {
      ok: true,
      page: { ...inserted, url_path },
      words: gen.body_markdown.split(/\s+/).length,
      creditsCharged,
    };
  });
