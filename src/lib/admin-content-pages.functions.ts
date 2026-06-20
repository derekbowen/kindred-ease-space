import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";

export type ContentPageRow = {
  id: string;
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
    let q = supabaseAdmin
      .from("content_pages")
      .select("id,slug,url_path,title,status,template_type,category,in_sitemap,updated_at")
      .eq("workspace_id", data.workspaceId)
      .order("updated_at", { ascending: false })
      .limit(data.limit);
    if (data.status) q = q.eq("status", data.status);
    if (data.search) {
      // Strip PostgREST metacharacters to prevent .or() filter injection.
      const s = data.search.replace(/[%_,()*]/g, "");
      if (s) q = q.or(`slug.ilike.%${s}%,title.ilike.%${s}%,url_path.ilike.%${s}%`);
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { rows: (rows ?? []) as ContentPageRow[] };
  });

export const updateContentPageBasics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      workspaceId: workspaceIdSchema,
      id: z.string().uuid(),
      title: z.string().max(300).optional(),
      seo_title: z.string().max(300).optional(),
      seo_description: z.string().max(500).optional(),
      status: z.string().max(40).optional(),
      in_sitemap: z.boolean().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, (context as any).userId);
    const { workspaceId, id, ...patch } = data;
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (Object.keys(clean).length === 0) return { ok: true };
    const { error } = await (supabaseAdmin as any)
      .from("content_pages")
      .update(clean)
      .eq("id", id)
      .eq("workspace_id", workspaceId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
