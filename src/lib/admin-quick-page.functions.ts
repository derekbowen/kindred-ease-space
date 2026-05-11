import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";

/**
 * Workspace-scoped "quick page" creator. The caller picks a workspace they
 * belong to, types a title + topic, and we generate a markdown page via the
 * Lovable AI gateway and insert it into content_pages with workspace_id set
 * so the existing RLS keeps it scoped to their workspace.
 *
 * Ported from the PRNM admin engine (single-tenant) and retrofitted for
 * the founders.click multi-tenant model.
 */

const InputSchema = z.object({
  workspaceId: workspaceIdSchema,
  title: z.string().trim().min(3).max(140),
  description: z.string().trim().max(500).optional().default(""),
  topic: z.string().trim().min(10).max(2000),
  model: z.string().default("google/gemini-2.5-flash"),
  slug: z.string().trim().max(120).optional(),
});

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

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

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

    const baseSlug = slugify(data.slug || data.title);
    if (!baseSlug) throw new Error("Could not derive slug from title");

    // Find a unique slug WITHIN this workspace (different workspaces can share slugs)
    let slug = baseSlug;
    let suffix = 1;
    while (true) {
      const { data: existing } = await supabaseAdmin
        .from("content_pages")
        .select("id")
        .eq("workspace_id", data.workspaceId)
        .eq("url_path", `/p/${slug}`)
        .maybeSingle();
      if (!existing) break;
      suffix += 1;
      slug = `${baseSlug}-${suffix}`;
      if (suffix > 50) throw new Error("Could not find a unique slug");
    }

    const userPrompt = `Write a brand page.

Title (H1): "${data.title}"
${data.description ? `One-line summary: "${data.description}"` : ""}

What this page should be about (interpret literally and build the article around this):
${data.topic}

Length: 600-1200 words.
Use ## for the main sections and ### for sub-points. Lead with a strong opening — no fluff.
seo_title (≤60 chars) and seo_description (≤155 chars) optimised for the topic.`;

    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: data.model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userPrompt },
        ],
        tools: [TOOL_SCHEMA],
        tool_choice: { type: "function", function: { name: "write_page" } },
      }),
    });

    if (resp.status === 402) {
      throw new Error("AI credits exhausted. Add funds in Workspace → Billing.");
    }
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`AI gateway ${resp.status}: ${t.slice(0, 300)}`);
    }
    const json = await resp.json();
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
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("content_pages")
      .insert({
        workspace_id: data.workspaceId,
        slug,
        url_path,
        title: gen.title || data.title,
        seo_title: (gen.seo_title || data.title).slice(0, 70),
        seo_description: (gen.seo_description || data.description || "").slice(0, 160),
        body_markdown: gen.body_markdown,
        category: "Resource/Article Page",
        template_type: "resource",
        status: "published",
        in_sitemap: true,
        locale: "en",
        priority: 0,
      })
      .select("id, url_path, title, slug")
      .single();
    if (insErr) throw new Error(insErr.message);

    return {
      ok: true,
      page: inserted,
      words: gen.body_markdown.split(/\s+/).length,
    };
  });
