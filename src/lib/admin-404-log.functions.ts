import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";
import { recordPage404, tenantUrlPath } from "@/lib/page-data.helpers.server";

const sb = () => supabaseAdmin as any;

export interface Content404Row {
  id: string;
  url_path: string;
  slug: string | null;
  referrer: string | null;
  hit_count: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolution_notes: string | null;
}

export const list404s = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: workspaceIdSchema,
        unresolvedOnly: z.boolean().default(true),
        limit: z.number().int().min(1).max(500).default(100),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<{ rows: Content404Row[] }> => {
    await assertWorkspaceMember(data.workspaceId, (context as any).userId);
    let q = sb()
      .from("content_404_log")
      .select(
        "id,url_path,slug,referrer,hit_count,first_seen_at,last_seen_at,resolved_at,resolution_notes",
      )
      .eq("workspace_id", data.workspaceId)
      .order("last_seen_at", { ascending: false })
      .limit(data.limit);
    if (data.unresolvedOnly) q = q.is("resolved_at", null);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { rows: (rows ?? []) as Content404Row[] };
  });

export const resolve404 = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: workspaceIdSchema,
        id: z.string().uuid(),
        notes: z.string().max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, (context as any).userId);
    const { error } = await sb()
      .from("content_404_log")
      .update({
        resolved_at: new Date().toISOString(),
        resolution_notes: data.notes ?? "marked resolved",
      })
      .eq("id", data.id)
      .eq("workspace_id", data.workspaceId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

export const redirect404 = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: workspaceIdSchema,
        id: z.string().uuid(),
        target: z.string().trim().min(1).max(2048),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, (context as any).userId);

    const { data: row, error: rowErr } = await sb()
      .from("content_404_log")
      .select("url_path, slug")
      .eq("id", data.id)
      .eq("workspace_id", data.workspaceId)
      .maybeSingle();
    if (rowErr || !row) return { ok: false, error: rowErr?.message || "404 row not found" };

    const target =
      data.target.startsWith("/") || data.target.startsWith("http")
        ? data.target
        : `/${data.target}`;

    const slug = (row.slug || row.url_path.replace(/^\/p\//, "")).slice(0, 200);
    const url_path = row.url_path || tenantUrlPath(slug);

    const { data: existing } = await sb()
      .from("content_pages")
      .select("id")
      .eq("url_path", url_path)
      .eq("workspace_id", data.workspaceId)
      .maybeSingle();

    if (existing) {
      const { error: upErr } = await sb()
        .from("content_pages")
        .update({ redirect_to: target, status: "redirect", in_sitemap: false })
        .eq("id", existing.id)
        .eq("workspace_id", data.workspaceId);
      if (upErr) return { ok: false, error: upErr.message };
    } else {
      const { error: insErr } = await sb()
        .from("content_pages")
        .insert({
          workspace_id: data.workspaceId,
          url_path,
          slug,
          redirect_to: target,
          status: "redirect",
          title: `Redirect → ${target}`,
          in_sitemap: false,
          template_type: "redirect",
          category: "redirect",
        });
      if (insErr) return { ok: false, error: insErr.message };
    }

    const { error: logErr } = await sb()
      .from("content_404_log")
      .update({
        resolved_at: new Date().toISOString(),
        resolution_notes: `redirect → ${target}`,
      })
      .eq("id", data.id)
      .eq("workspace_id", data.workspaceId);
    if (logErr) return { ok: false, error: logErr.message };

    return { ok: true, target };
  });

/** Called from public page loader when a /p/{slug} request 404s on a known host. */
export const logPublic404 = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: workspaceIdSchema,
        slug: z.string().min(1).max(200),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await recordPage404(data.workspaceId, data.slug);
    return { ok: true as const };
  });
