import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Admin "quick page" creator. Brandon (or any admin) types a title, optional
 * short description, and a "what should this page be about" prompt. We send
 * that to the Lovable AI gateway, get back a fully-formed PRNM-branded
 * markdown page, and insert it into content_pages as a published /p/{slug}.
 */

const InputSchema = z.object({
  title: z.string().trim().min(3).max(140),
  description: z.string().trim().max(500).optional().default(""),
  topic: z.string().trim().min(10).max(2000),
  model: z.string().default("openai/gpt-5"),
  slug: z.string().trim().max(120).optional(),
});

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const SYSTEM = `
You write SEO + brand content for Pool Rental Near Me (PRNM), a marketplace where homeowners rent out private pools by the hour.
Differentiators (mention naturally where it fits): 10% flat host fee (vs Swimply's 15%+), $2M liability insurance included, AI-built features same day on request.
Voice: confident, friendly, host-first, never spammy. Short paragraphs. Real, useful copy — no filler, no "in this article we will".
Format: Markdown only. Use ## and ### headings. Include 3-5 internal links naturally where relevant from this set:
  /s, /p/hosting, /p/all-locations, /p/earnings-calculator, /p/how-it-works, /p/waivers, /p/hoa-pool-rental-defense-kit
List Your Pool CTA URL: /l/draft/00000000-0000-0000-0000-000000000000/new/details
Always end with a short CTA paragraph linking to the List Your Pool URL OR /s, whichever fits.
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

async function assertAdmin(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Admin role required");
}

export const createQuickPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => InputSchema.parse(data))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

    const baseSlug = slugify(data.slug || data.title);
    if (!baseSlug) throw new Error("Could not derive slug from title");

    // Find a unique slug
    let slug = baseSlug;
    let suffix = 1;
    while (true) {
      const { data: existing } = await supabaseAdmin
        .from("content_pages")
        .select("id")
        .eq("url_path", `/p/${slug}`)
        .maybeSingle();
      if (!existing) break;
      suffix += 1;
      slug = `${baseSlug}-${suffix}`;
      if (suffix > 50) throw new Error("Could not find a unique slug");
    }

    const userPrompt = `Write a brand page for PRNM.

Title (H1): "${data.title}"
${data.description ? `One-line summary the admin gave: "${data.description}"` : ""}

What this page should be about (interpret literally and build the article around this):
${data.topic}

Length: 600-1200 words.
Use ## for the main sections and ### for sub-points. Lead with a strong opening that gets right into the value — no fluff.
seo_title (≤60 chars) and seo_description (≤155 chars) optimized for the topic.`;

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
      throw new Error("AI credits exhausted. Add funds in Workspace → Usage.");
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
    const { data: inserted, error: insErr } = await (supabaseAdmin as any)
      .from("content_pages")
      .insert({
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
