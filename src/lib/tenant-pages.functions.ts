import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const sb = () => supabaseAdmin as any;

async function assertMember(workspaceId: string, userId: string) {
  const { data, error } = await sb().rpc("is_workspace_member", {
    _workspace_id: workspaceId,
    _user_id: userId,
  });
  if (error || !data) throw new Error("forbidden");
}

const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9-/]*$/i, "Use letters, numbers, dashes, slashes");

export const listPageTemplates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { data } = await sb()
      .from("page_templates")
      .select("id, slug, name, description, config_schema, preview_image_url, is_active")
      .order("name", { ascending: true });
    return { templates: data ?? [] };
  });

export const listTenantPages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertMember(data.workspaceId, context.userId);
    const { data: rows } = await sb()
      .from("tenant_pages")
      .select(
        "id, slug, title, status, published_at, updated_at, template_id, page_templates:template_id(name, slug)",
      )
      .eq("workspace_id", data.workspaceId)
      .order("updated_at", { ascending: false });
    return { pages: rows ?? [] };
  });

export const getTenantPage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ workspaceId: z.string().uuid(), id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertMember(data.workspaceId, context.userId);
    const { data: row } = await sb()
      .from("tenant_pages")
      .select("*, page_templates:template_id(slug, name, config_schema)")
      .eq("workspace_id", data.workspaceId)
      .eq("id", data.id)
      .maybeSingle();
    return { page: row ?? null };
  });

const upsertSchema = z.object({
  workspaceId: z.string().uuid(),
  id: z.string().uuid().optional(),
  templateId: z.string().uuid(),
  slug: slugSchema,
  title: z.string().min(2).max(200),
  metaDescription: z.string().max(320).nullable().optional(),
  h1: z.string().max(200).nullable().optional(),
  bodyMarkdown: z.string().max(50_000).nullable().optional(),
  variables: z.record(z.string(), z.any()).default({}),
  listingFilter: z.record(z.string(), z.any()).default({}),
  status: z.enum(["draft", "published", "archived"]).default("draft"),
});

export const upsertTenantPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => upsertSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertMember(data.workspaceId, context.userId);
    const row: Record<string, any> = {
      workspace_id: data.workspaceId,
      template_id: data.templateId,
      slug: data.slug.toLowerCase(),
      title: data.title,
      meta_description: data.metaDescription ?? null,
      h1: data.h1 ?? null,
      body_markdown: data.bodyMarkdown ?? null,
      variables: data.variables,
      listing_filter: data.listingFilter,
      status: data.status,
      published_at: data.status === "published" ? new Date().toISOString() : null,
    };
    if (data.id) {
      const { data: out, error } = await sb()
        .from("tenant_pages")
        .update(row)
        .eq("id", data.id)
        .eq("workspace_id", data.workspaceId)
        .select("id")
        .single();
      if (error) return { ok: false as const, error: error.message };
      return { ok: true as const, id: out.id };
    } else {
      const { data: out, error } = await sb()
        .from("tenant_pages")
        .insert(row)
        .select("id")
        .single();
      if (error) return { ok: false as const, error: error.message };
      return { ok: true as const, id: out.id };
    }
  });

export const deleteTenantPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ workspaceId: z.string().uuid(), id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertMember(data.workspaceId, context.userId);
    await sb()
      .from("tenant_pages")
      .delete()
      .eq("id", data.id)
      .eq("workspace_id", data.workspaceId);
    return { ok: true as const };
  });

export const bulkCreatePages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        workspaceId: z.string().uuid(),
        templateId: z.string().uuid(),
        rows: z
          .array(
            z.object({
              slug: slugSchema,
              title: z.string().min(2).max(200),
              metaDescription: z.string().max(320).optional(),
              variables: z.record(z.string(), z.any()).default({}),
              listingFilter: z.record(z.string(), z.any()).default({}),
            }),
          )
          .min(1)
          .max(500),
        status: z.enum(["draft", "published"]).default("draft"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertMember(data.workspaceId, context.userId);
    const inserts = data.rows.map((r) => ({
      workspace_id: data.workspaceId,
      template_id: data.templateId,
      slug: r.slug.toLowerCase(),
      title: r.title,
      meta_description: r.metaDescription ?? null,
      h1: r.title,
      variables: r.variables,
      listing_filter: r.listingFilter,
      status: data.status,
      published_at: data.status === "published" ? new Date().toISOString() : null,
    }));
    const { data: out, error } = await sb()
      .from("tenant_pages")
      .upsert(inserts, { onConflict: "workspace_id,slug", ignoreDuplicates: false })
      .select("id");
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, count: out?.length ?? 0 };
  });
