import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function assertAdmin(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: admin only");
}

/**
 * Records a 404 hit on a /p/{slug} URL. Upserts on `url_path` so repeat hits
 * just bump `hit_count` + `last_seen_at` instead of creating duplicate rows.
 *
 * Called from the `/p/$slug` route's `beforeLoad` when `lookupContentPage`
 * returns `not_found`. Runs server-side during SSR so we capture bot traffic
 * too.
 */
export const log404 = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        urlPath: z.string().min(1).max(2048),
        slug: z.string().nullable().optional(),
        referrer: z.string().max(2048).nullable().optional(),
        userAgent: z.string().max(1024).nullable().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    try {
      // Capture request headers server-side if not provided by caller.
      let referrer = data.referrer ?? null;
      let userAgent = data.userAgent ?? null;
      try {
        const { getRequestHeader } = await import("@tanstack/react-start/server");
        if (!referrer) referrer = getRequestHeader("referer") ?? null;
        if (!userAgent) userAgent = getRequestHeader("user-agent") ?? null;
      } catch {
        // headers unavailable; continue without
      }

      // Upsert: if row exists for this url_path, bump hit_count + last_seen_at.
      const { data: existing } = await (supabaseAdmin as any)
        .from("content_404_log")
        .select("id, hit_count")
        .eq("url_path", data.urlPath)
        .maybeSingle();

      if (existing) {
        await (supabaseAdmin as any)
          .from("content_404_log")
          .update({
            hit_count: (existing.hit_count ?? 0) + 1,
            last_seen_at: new Date().toISOString(),
            referrer: data.referrer ?? undefined,
            user_agent: data.userAgent ?? undefined,
            resolved_at: null,
          })
          .eq("id", existing.id);
      } else {
        await (supabaseAdmin as any).from("content_404_log").insert({
          url_path: data.urlPath,
          slug: data.slug ?? null,
          referrer: data.referrer ?? null,
          user_agent: data.userAgent ?? null,
        });
      }
    } catch (err) {
      // Never let logging failures break the 404 response.
      console.error("[404-log] failed to record", data.urlPath, err);
    }
    return { ok: true };
  });

export interface Content404Row {
  id: string;
  url_path: string;
  slug: string | null;
  referrer: string | null;
  user_agent: string | null;
  hit_count: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolution_notes: string | null;
}

/** Admin: list recent 404s, optionally filtered to unresolved only. */
export const list404s = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        unresolvedOnly: z.boolean().optional().default(true),
        limit: z.number().int().min(1).max(500).optional().default(100),
      })
      .parse(data ?? {}),
  )
  .handler(async ({ data, context }): Promise<{ rows: Content404Row[] }> => {
    const { userId } = context as { userId: string };
    await assertAdmin(userId);

    let q = (supabaseAdmin as any)
      .from("content_404_log")
      .select("*")
      .order("last_seen_at", { ascending: false })
      .limit(data.limit);
    if (data.unresolvedOnly) q = q.is("resolved_at", null);
    const { data: rows, error } = await q;
    if (error) {
      console.error("[404-log] list failed", error);
      return { rows: [] };
    }
    return { rows: (rows ?? []) as Content404Row[] };
  });

/** Admin: mark a 404 row as resolved (e.g., after redirecting or creating the page). */
export const resolve404 = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        notes: z.string().max(500).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context as { userId: string };
    await assertAdmin(userId);

    const { error } = await (supabaseAdmin as any)
      .from("content_404_log")
      .update({
        resolved_at: new Date().toISOString(),
        resolution_notes: data.notes ?? null,
      })
      .eq("id", data.id);
    if (error) {
      console.error("[404-log] resolve failed", error);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  });

/** Admin: turn a missing /p/* path into a redirect to a working page. */
export const redirect404 = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({
      id: z.string().uuid(),
      target: z.string().trim().min(1).max(2048),
    }).parse(data),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context as { userId: string };
    await assertAdmin(userId);

    const { data: row, error: rowErr } = await (supabaseAdmin as any)
      .from("content_404_log").select("url_path, slug").eq("id", data.id).maybeSingle();
    if (rowErr || !row) return { ok: false, error: rowErr?.message || "404 row not found" };

    const target = data.target.startsWith("/") || data.target.startsWith("http")
      ? data.target : `/${data.target}`;

    // Upsert a content_pages row at the missing path that redirects.
    const slug = (row.slug || row.url_path.replace(/^\/p\//, "")).slice(0, 200);
    const { data: existing } = await (supabaseAdmin as any)
      .from("content_pages").select("id").eq("url_path", row.url_path).maybeSingle();

    if (existing) {
      await (supabaseAdmin as any).from("content_pages")
        .update({ redirect_to: target, status: "redirect", updated_at: new Date().toISOString() })
        .eq("id", existing.id);
    } else {
      await (supabaseAdmin as any).from("content_pages").insert({
        url_path: row.url_path, slug, redirect_to: target, status: "redirect",
        title: `Redirect → ${target}`, in_sitemap: false, template_type: "redirect",
      });
    }

    await (supabaseAdmin as any).from("content_404_log")
      .update({ resolved_at: new Date().toISOString(), resolution_notes: `redirect → ${target}` })
      .eq("id", data.id);
    return { ok: true, target };
  });

/** Admin: AI-generate a real page at the missing path. */
export const createPageFor404 = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const { userId } = context as { userId: string };
    await assertAdmin(userId);

    const { data: row } = await (supabaseAdmin as any)
      .from("content_404_log").select("url_path, slug").eq("id", data.id).maybeSingle();
    if (!row) return { ok: false, error: "404 row not found" };

    const slug = (row.slug || row.url_path.replace(/^\/p\//, "")).replace(/\/+$/, "");
    if (!slug) return { ok: false, error: "Cannot derive slug from URL" };

    // Check it's not already there
    const { data: existing } = await (supabaseAdmin as any)
      .from("content_pages").select("id").eq("url_path", row.url_path).maybeSingle();
    if (existing) {
      await (supabaseAdmin as any).from("content_404_log")
        .update({ resolved_at: new Date().toISOString(), resolution_notes: "page already exists" })
        .eq("id", data.id);
      return { ok: true, alreadyExists: true };
    }

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) return { ok: false, error: "LOVABLE_API_KEY not configured" };

    // Derive a human title from the slug
    const title = slug.split("-").map((w: string) => w[0]?.toUpperCase() + w.slice(1)).join(" ");

    const SYSTEM = `You write SEO content for Pool Rental Near Me, a marketplace where homeowners rent private pools by the hour. 10% flat host fee, $2M liability insurance included. Voice: confident, friendly, host-first. Markdown only with ## and ### headings. Include 2-4 internal links from: /s, /p/hosting, /p/all-locations, /p/earnings-calculator, /p/how-it-works. End with a CTA paragraph linking to /l/draft/00000000-0000-0000-0000-000000000000/new/details. Return ONLY by calling write_page.`;
    const userPrompt = `Write a page for the URL ${row.url_path}. Inferred title: "${title}". Build the article around what someone landing on that URL would want. 600-1000 words. seo_title ≤60 chars, seo_description ≤155 chars.`;

    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-5-mini",
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: userPrompt }],
        tools: [{ type: "function", function: { name: "write_page", parameters: {
          type: "object", required: ["title", "seo_title", "seo_description", "body_markdown"],
          properties: {
            title: { type: "string" }, seo_title: { type: "string" },
            seo_description: { type: "string" }, body_markdown: { type: "string" },
          }, additionalProperties: false,
        }}}],
        tool_choice: { type: "function", function: { name: "write_page" } },
      }),
    });
    if (resp.status === 402) return { ok: false, error: "AI credits exhausted" };
    if (!resp.ok) return { ok: false, error: `AI gateway ${resp.status}` };
    const json = await resp.json();
    const tc = json?.choices?.[0]?.message?.tool_calls?.[0];
    if (!tc?.function?.arguments) return { ok: false, error: "AI response missing tool call" };
    const gen = JSON.parse(tc.function.arguments);

    const { error: insErr } = await (supabaseAdmin as any).from("content_pages").insert({
      url_path: row.url_path, slug, status: "published", in_sitemap: true,
      title: gen.title, seo_title: gen.seo_title, seo_description: gen.seo_description,
      body_markdown: gen.body_markdown, template_type: "resource",
    });
    if (insErr) return { ok: false, error: insErr.message };

    await (supabaseAdmin as any).from("content_404_log")
      .update({ resolved_at: new Date().toISOString(), resolution_notes: "page created via AI" })
      .eq("id", data.id);
    return { ok: true, slug, words: (gen.body_markdown || "").split(/\s+/).length };
  });
