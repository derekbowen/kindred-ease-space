/**
 * Server functions for the content health check admin page.
 * Scans content_pages for missing/blank body_markdown and returns affected
 * live URLs (status='published'). Admin-gated.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

async function assertAdmin(userId: string) {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("Forbidden");
}

export interface ContentHealthRow {
  id: string;
  url_path: string;
  slug: string | null;
  title: string | null;
  template_type: string | null;
  locale: string;
  in_sitemap: boolean;
  body_len: number;
  reason: "missing" | "blank" | "thin";
  updated_at: string;
}

export interface ContentHealthReport {
  totalPublished: number;
  totalAffected: number;
  byReason: { missing: number; blank: number; thin: number };
  rows: ContentHealthRow[];
  minLength: number;
  ranAt: string;
}

const Input = z.object({
  minLength: z.number().int().min(0).max(10000).default(500),
  limit: z.number().int().min(1).max(5000).default(1000),
  onlyInSitemap: z.boolean().default(false),
});

export const scanContentHealth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Input.parse(d ?? {}))
  .handler(async ({ data, context }): Promise<ContentHealthReport> => {
    await assertAdmin((context as { userId: string }).userId);
    const sb = supabaseAdmin as any;

    let q = sb
      .from("content_pages")
      .select(
        "id, url_path, slug, title, template_type, locale, in_sitemap, updated_at, body_markdown",
        { count: "exact" },
      )
      .eq("status", "published");
    if (data.onlyInSitemap) q = q.eq("in_sitemap", true);

    const { data: rows, count } = await q
      .order("url_path", { ascending: true })
      .limit(10000);

    const affected: ContentHealthRow[] = [];
    let missing = 0,
      blank = 0,
      thin = 0;
    for (const r of (rows || []) as Array<{
      id: string;
      url_path: string | null;
      slug: string | null;
      title: string | null;
      template_type: string | null;
      locale: string | null;
      in_sitemap: boolean | null;
      updated_at: string;
      body_markdown: string | null;
    }>) {
      const body = r.body_markdown || "";
      const len = body.trim().length;
      let reason: "missing" | "blank" | "thin" | null = null;
      if (r.body_markdown === null) reason = "missing";
      else if (len === 0) reason = "blank";
      else if (len < data.minLength) reason = "thin";
      if (!reason) continue;
      if (reason === "missing") missing++;
      else if (reason === "blank") blank++;
      else thin++;
      affected.push({
        id: r.id,
        url_path: r.url_path || "",
        slug: r.slug,
        title: r.title,
        template_type: r.template_type,
        locale: r.locale || "en",
        in_sitemap: !!r.in_sitemap,
        body_len: len,
        reason,
        updated_at: r.updated_at,
      });
    }

    affected.sort((a, b) => a.body_len - b.body_len || a.url_path.localeCompare(b.url_path));

    return {
      totalPublished: count || 0,
      totalAffected: affected.length,
      byReason: { missing, blank, thin },
      rows: affected.slice(0, data.limit),
      minLength: data.minLength,
      ranAt: new Date().toISOString(),
    };
  });
