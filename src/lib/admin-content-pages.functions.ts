import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import { fetchPublishedPages, tenantUrlPath } from "@/lib/page-data.helpers.server";

const sb = () => supabaseAdmin as any;

export type ContentPageRow = {
  id: string;
  source: "tenant" | "content";
  slug: string | null;
  url_path: string | null;
  title: string | null;
  status: string;
  template_type: string | null;
  category: string;
  in_sitemap: boolean;
  updated_at: string;
};

export const listContentPages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      workspaceId: workspaceIdSchema,
      search: z.string().max(200).optional(),
      status: z.string().max(40).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, (context as any).userId);

    const statusFilter = data.status || "published";
    let rows: ContentPageRow[] = [];

    if (statusFilter === "published") {
      const pages = await fetchPublishedPages(data.workspaceId, { limit: data.limit * 2 });
      rows = pages.map((p) => ({
        id: p.id,
        source: p.source,
        slug: p.slug,
        url_path: p.url_path,
        title: p.title,
        status: p.status,
        template_type: p.template_type,
        category: p.category,
        in_sitemap: p.in_sitemap,
        updated_at: p.updated_at,
      }));
    } else {
      const { data: legacy, error } = await sb()
        .from("content_pages")
        .select("id,slug,url_path,title,status,template_type,category,in_sitemap,updated_at")
        .eq("workspace_id", data.workspaceId)
        .eq("status", statusFilter)
        .order("updated_at", { ascending: false })
        .limit(data.limit);
      if (error) throw new Error(error.message);
      rows = (legacy ?? []).map((r: any) => ({ ...r, source: "content" as const }));
    }

    if (data.search) {
      const s = data.search.toLowerCase().replace(/[%_,()*]/g, "");
      if (s) {
        rows = rows.filter(
          (r) =>
            (r.slug ?? "").toLowerCase().includes(s) ||
            (r.title ?? "").toLowerCase().includes(s) ||
            (r.url_path ?? "").toLowerCase().includes(s),
        );
      }
    }

    return { rows: rows.slice(0, data.limit) };
  });

export const updateContentPageBasics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      workspaceId: workspaceIdSchema,
      id: z.string().uuid(),
      source: z.enum(["tenant", "content"]).default("content"),
      title: z.string().max(300).optional(),
      seo_title: z.string().max(300).optional(),
      seo_description: z.string().max(500).optional(),
      status: z.string().max(40).optional(),
      in_sitemap: z.boolean().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, (context as any).userId);
    const { workspaceId, id, source, ...patch } = data;

    if (source === "tenant") {
      const tenantPatch: Record<string, unknown> = {};
      if (patch.title !== undefined) tenantPatch.title = patch.title;
      if (patch.seo_description !== undefined) tenantPatch.meta_description = patch.seo_description;
      if (patch.status !== undefined) tenantPatch.status = patch.status;
      if (Object.keys(tenantPatch).length === 0) return { ok: true };
      const { error } = await sb()
        .from("tenant_pages")
        .update(tenantPatch)
        .eq("id", id)
        .eq("workspace_id", workspaceId);
      if (error) throw new Error(error.message);
      return { ok: true };
    }

    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (Object.keys(clean).length === 0) return { ok: true };
    const { error } = await sb()
      .from("content_pages")
      .update(clean)
      .eq("id", id)
      .eq("workspace_id", workspaceId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });