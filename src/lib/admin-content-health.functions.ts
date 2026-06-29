import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import { fetchPublishedPages } from "@/lib/page-data.helpers.server";

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
  source: "tenant" | "content";
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
  workspaceId: workspaceIdSchema,
  minLength: z.number().int().min(0).max(10000).default(500),
  limit: z.number().int().min(1).max(5000).default(500),
  onlyInSitemap: z.boolean().default(false),
});

export const scanContentHealth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data, context }): Promise<ContentHealthReport> => {
    await assertWorkspaceMember(data.workspaceId, (context as any).userId);

    let pages = await fetchPublishedPages(data.workspaceId, { limit: 10000 });
    if (data.onlyInSitemap) pages = pages.filter((p) => p.in_sitemap);

    const affected: ContentHealthRow[] = [];
    let missing = 0,
      blank = 0,
      thin = 0;

    for (const r of pages) {
      const body = r.body_markdown ?? "";
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
        url_path: r.url_path,
        slug: r.slug,
        title: r.title,
        template_type: r.template_type,
        locale: "en",
        in_sitemap: r.in_sitemap,
        body_len: len,
        reason,
        updated_at: r.updated_at,
        source: r.source,
      });
    }

    affected.sort((a, b) => a.body_len - b.body_len || a.url_path.localeCompare(b.url_path));

    return {
      totalPublished: pages.length,
      totalAffected: affected.length,
      byReason: { missing, blank, thin },
      rows: affected.slice(0, data.limit),
      minLength: data.minLength,
      ranAt: new Date().toISOString(),
    };
  });
