import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "./admin-helpers.functions";

const sb = () => supabaseAdmin as any;

export type BrokenLink = {
  from_url_path: string;
  to_url_path: string;
  anchor: string | null;
  reason: "missing" | "unpublished";
};

/**
 * Scan published content_pages bodies for internal markdown links and report
 * any whose target URL doesn't resolve to a published page in the same
 * workspace. Generic across tenants.
 */
export const scanInternalLinks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      workspaceId: workspaceIdSchema,
      sampleSize: z.number().int().min(20).max(2000).default(500),
    }).parse(d),
  )
  .handler(async ({ data, context }): Promise<{ totalPagesScanned: number; totalLinks: number; broken: BrokenLink[] }> => {
    await assertWorkspaceMember(data.workspaceId, context.userId);

    const { data: pages } = await sb()
      .from("content_pages")
      .select("url_path, body_markdown, status")
      .eq("workspace_id", data.workspaceId)
      .eq("status", "published")
      .order("updated_at", { ascending: false })
      .limit(data.sampleSize);

    const rows = (pages || []) as Array<{ url_path: string; body_markdown: string | null }>;

    // Collect every internal link target encountered.
    const linkRx = /\[([^\]]+)\]\((\/[^)\s#?]+)(?:[#?][^)]*)?\)/g;
    type Found = { from: string; to: string; anchor: string };
    const found: Found[] = [];
    for (const p of rows) {
      const body = p.body_markdown || "";
      let m: RegExpExecArray | null;
      while ((m = linkRx.exec(body)) !== null) {
        found.push({ from: p.url_path, to: m[2], anchor: m[1] });
      }
    }

    const targets = Array.from(new Set(found.map((f) => f.to)));
    if (!targets.length) return { totalPagesScanned: rows.length, totalLinks: 0, broken: [] };

    // Look up status for every distinct target in batches of 200.
    const statusByPath = new Map<string, string>();
    for (let i = 0; i < targets.length; i += 200) {
      const batch = targets.slice(i, i + 200);
      const { data: hits } = await sb()
        .from("content_pages")
        .select("url_path, status")
        .eq("workspace_id", data.workspaceId)
        .in("url_path", batch);
      for (const h of (hits || []) as Array<{ url_path: string; status: string }>) {
        statusByPath.set(h.url_path, h.status);
      }
    }

    const broken: BrokenLink[] = [];
    for (const f of found) {
      const status = statusByPath.get(f.to);
      if (!status) {
        broken.push({ from_url_path: f.from, to_url_path: f.to, anchor: f.anchor, reason: "missing" });
      } else if (status !== "published") {
        broken.push({ from_url_path: f.from, to_url_path: f.to, anchor: f.anchor, reason: "unpublished" });
      }
    }

    return { totalPagesScanned: rows.length, totalLinks: found.length, broken };
  });
