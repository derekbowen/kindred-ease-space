import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const STOPWORDS = new Set([
  "a","an","and","are","as","at","be","but","by","for","from","has","have",
  "how","i","if","in","into","is","it","its","of","on","or","that","the",
  "their","this","to","was","were","what","when","where","which","who","why",
  "will","with","you","your","about","can","do","does","get","my","make",
  "more","new","not","now","one","our","out","over","so","than","then","they",
  "we","best","top","guide","guides","tips","tip","vs","via","like","most",
  "every","ever","just","also","too","much","many","need","needs","using",
  "use","uses","used","step","steps","way","ways","blog","post","posts",
  "pool","pools",
]);

function tokenize(s: string | null | undefined): Set<string> {
  if (!s) return new Set();
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/[\s-]+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

type BlogRow = {
  slug: string;
  title: string | null;
  excerpt: string | null;
  topic: string | null;
};

async function loadAllPublished(): Promise<BlogRow[]> {
  const { data } = await (supabaseAdmin as any)
    .from("blog_posts")
    .select("slug, title, excerpt, topic")
    .eq("is_published", true)
    .limit(2000);
  return (data ?? []) as BlogRow[];
}

function pickRelated(target: BlogRow, all: BlogRow[], limit = 6): string[] {
  const targetTokens = tokenize(`${target.title ?? ""} ${target.excerpt ?? ""}`);
  const scored = all
    .filter((p) => p.slug !== target.slug)
    .map((p) => {
      const t = tokenize(`${p.title ?? ""} ${p.excerpt ?? ""}`);
      let score = jaccard(targetTokens, t);
      if (p.topic && target.topic && p.topic === target.topic) score += 0.15;
      return { slug: p.slug, score };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map((s) => s.slug);
}

async function generateTldr(
  title: string,
  body: string,
): Promise<string[] | null> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) return null;
  const trimmed = body.slice(0, 12000);
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          {
            role: "system",
            content:
              "You write crisp 'Key takeaways' bullet lists for blog posts. Each bullet is one short, specific, useful sentence (max 18 words). No fluff, no marketing, no emoji. Sentence case.",
          },
          {
            role: "user",
            content: `Title: ${title}\n\nArticle:\n${trimmed}\n\nReturn 3-5 key takeaway bullets via the tool.`,
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "set_tldr",
              description: "Return the key takeaway bullets for the article.",
              parameters: {
                type: "object",
                properties: {
                  bullets: {
                    type: "array",
                    minItems: 3,
                    maxItems: 5,
                    items: { type: "string" },
                  },
                },
                required: ["bullets"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "set_tldr" } },
      }),
    });
    if (!res.ok) {
      console.error("[generateTldr] AI gateway", res.status, await res.text().catch(() => ""));
      return null;
    }
    const json = (await res.json()) as any;
    const call = json?.choices?.[0]?.message?.tool_calls?.[0];
    const args = call?.function?.arguments;
    if (!args) return null;
    const parsed = JSON.parse(args);
    const bullets: unknown = parsed?.bullets;
    if (!Array.isArray(bullets)) return null;
    return bullets
      .filter((b): b is string => typeof b === "string" && b.trim().length > 0)
      .map((b) => b.trim())
      .slice(0, 5);
  } catch (err) {
    console.error("[generateTldr] error", err);
    return null;
  }
}

export const enrichBlogPost = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ slug: z.string().min(1).max(200), force: z.boolean().optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { data: rows } = await (supabaseAdmin as any)
      .from("blog_posts")
      .select("slug, title, excerpt, content, topic, tldr_bullets, related_slugs")
      .eq("slug", data.slug)
      .eq("is_published", true)
      .limit(1);
    const post = (rows ?? [])[0] as
      | (BlogRow & {
          content: string | null;
          tldr_bullets: unknown;
          related_slugs: unknown;
        })
      | undefined;
    if (!post) return { ok: false, reason: "not_found" as const };

    const all = await loadAllPublished();
    const related = pickRelated(post, all, 6);

    const hadTldr =
      Array.isArray(post.tldr_bullets) && (post.tldr_bullets as unknown[]).length > 0;
    let tldr: string[] | null = hadTldr ? (post.tldr_bullets as string[]) : null;
    if (data.force || !hadTldr) {
      tldr = await generateTldr(post.title ?? post.slug, post.content ?? "");
    }

    const update: Record<string, unknown> = {
      related_slugs: related,
      enrichment_generated_at: new Date().toISOString(),
    };
    if (tldr && tldr.length > 0) update.tldr_bullets = tldr;

    const { error } = await (supabaseAdmin as any)
      .from("blog_posts")
      .update(update)
      .eq("slug", data.slug);
    if (error) {
      console.error("[enrichBlogPost] update", error);
      return { ok: false, reason: "update_error" as const };
    }
    return {
      ok: true,
      slug: data.slug,
      tldr_count: tldr?.length ?? 0,
      related_count: related.length,
    };
  });

export const enrichBlogBatch = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        limit: z.number().int().min(1).max(50).default(10),
        onlyMissing: z.boolean().default(true),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data }) => {
    let q = (supabaseAdmin as any)
      .from("blog_posts")
      .select("slug, title, excerpt, content, topic, tldr_bullets")
      .eq("is_published", true)
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(data.limit);
    if (data.onlyMissing) q = q.is("tldr_bullets", null);
    const { data: rows } = await q;
    const posts = (rows ?? []) as Array<
      BlogRow & { content: string | null; tldr_bullets: unknown }
    >;
    const all = await loadAllPublished();
    const results: Array<{ slug: string; ok: boolean; tldr: number; related: number }> = [];
    for (const post of posts) {
      const related = pickRelated(post, all, 6);
      let tldr: string[] | null = null;
      const hadTldr =
        Array.isArray(post.tldr_bullets) && (post.tldr_bullets as unknown[]).length > 0;
      if (!hadTldr) {
        tldr = await generateTldr(post.title ?? post.slug, post.content ?? "");
      }
      const update: Record<string, unknown> = {
        related_slugs: related,
        enrichment_generated_at: new Date().toISOString(),
      };
      if (tldr && tldr.length > 0) update.tldr_bullets = tldr;
      const { error } = await (supabaseAdmin as any)
        .from("blog_posts")
        .update(update)
        .eq("slug", post.slug);
      results.push({
        slug: post.slug,
        ok: !error,
        tldr: tldr?.length ?? 0,
        related: related.length,
      });
      // gentle throttle so we don't hit AI gateway rate limits
      await new Promise((r) => setTimeout(r, 250));
    }
    return { processed: results.length, results };
  });

export type RelatedPostMeta = {
  slug: string;
  title: string;
  topic: string | null;
  excerpt: string | null;
  cover_image_url: string | null;
};

export const getRelatedBlogMeta = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) =>
    z.object({ slugs: z.array(z.string().min(1).max(200)).max(12) }).parse(d),
  )
  .handler(async ({ data }): Promise<{ posts: RelatedPostMeta[] }> => {
    if (data.slugs.length === 0) return { posts: [] };
    const { data: rows } = await (supabaseAdmin as any)
      .from("blog_posts")
      .select("slug, title, topic, excerpt, cover_image_url")
      .in("slug", data.slugs)
      .eq("is_published", true);
    const list = (rows ?? []) as RelatedPostMeta[];
    // preserve input order
    const order = new Map(data.slugs.map((s, i) => [s, i]));
    list.sort((a, b) => (order.get(a.slug) ?? 0) - (order.get(b.slug) ?? 0));
    return { posts: list };
  });
