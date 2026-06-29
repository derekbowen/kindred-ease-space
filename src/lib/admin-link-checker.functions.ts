import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "./admin-helpers.functions";
import { fetchPublishedPages, resolveLinkTargetStatus } from "@/lib/page-data.helpers.server";

export type BrokenLink = {
  from_url_path: string;
  to_url_path: string;
  anchor: string | null;
  reason: "missing" | "unpublished";
};

export const scanInternalLinks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: workspaceIdSchema,
        sampleSize: z.number().int().min(20).max(2000).default(500),
      })
      .parse(d),
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<{ totalPagesScanned: number; totalLinks: number; broken: BrokenLink[] }> => {
      await assertWorkspaceMember(data.workspaceId, context.userId);

      const pages = await fetchPublishedPages(data.workspaceId, { limit: data.sampleSize });

      type Found = { from: string; to: string; anchor: string };
      const found: Found[] = [];
      const linkRx = new RegExp("\\[([^\\]]+)\\]\\((\\/[^)\\s#?]+)(?:[#?][^)]*)?\\)", "g");

      for (const p of pages) {
        const body = p.body_markdown || "";
        const matches = body.matchAll(linkRx);
        for (const m of matches) {
          found.push({ from: p.url_path, to: m[2], anchor: m[1] });
        }
      }

      const targets = Array.from(new Set(found.map((f) => f.to)));
      if (!targets.length) return { totalPagesScanned: pages.length, totalLinks: 0, broken: [] };

      const statusByPath = new Map<string, string | null>();
      for (const t of targets) {
        statusByPath.set(t, await resolveLinkTargetStatus(data.workspaceId, t));
      }

      const broken: BrokenLink[] = [];
      for (const f of found) {
        const status = statusByPath.get(f.to);
        if (!status) {
          broken.push({
            from_url_path: f.from,
            to_url_path: f.to,
            anchor: f.anchor,
            reason: "missing",
          });
        } else if (status !== "published") {
          broken.push({
            from_url_path: f.from,
            to_url_path: f.to,
            anchor: f.anchor,
            reason: "unpublished",
          });
        }
      }

      return { totalPagesScanned: pages.length, totalLinks: found.length, broken };
    },
  );
