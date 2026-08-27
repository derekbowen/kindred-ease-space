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

// No "/": the public route /p/$slug matches a single path segment, so a slug
// containing a slash creates a page that can never be reached.
const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9-]*$/i, "Use letters, numbers and dashes");

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

    // Publishing consumes a page-entitlement slot, so the status flip goes
    // through the atomic DB gate (publish_tenant_pages), never a direct write:
    // content is saved first (as draft when not already live), then the gate
    // decides whether a slot is available. Editing an ALREADY-published page
    // doesn't consume a new slot and stays a direct update.
    const wantsPublish = data.status === "published";
    let alreadyPublished = false;
    if (data.id) {
      const { data: existing } = await sb()
        .from("tenant_pages")
        .select("status")
        .eq("id", data.id)
        .eq("workspace_id", data.workspaceId)
        .maybeSingle();
      alreadyPublished = existing?.status === "published";
    }

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
      status: wantsPublish && alreadyPublished ? "published" : wantsPublish ? "draft" : data.status,
    };

    let pageId: string;
    if (data.id) {
      const { data: out, error } = await sb()
        .from("tenant_pages")
        .update(row)
        .eq("id", data.id)
        .eq("workspace_id", data.workspaceId)
        .select("id")
        .single();
      if (error) return { ok: false as const, error: error.message };
      pageId = out.id;
    } else {
      const { data: out, error } = await sb()
        .from("tenant_pages")
        .insert(row)
        .select("id")
        .single();
      if (error) return { ok: false as const, error: error.message };
      pageId = out.id;
    }

    if (wantsPublish && !alreadyPublished) {
      const { publishPagesAtomically, pageLimitMessage } = await import(
        "@/lib/entitlements.functions"
      );
      const gate = await publishPagesAtomically(data.workspaceId, [pageId]);
      if (gate.published === 0) {
        return {
          ok: false as const,
          code: "page_limit" as const,
          error: `${pageLimitMessage(gate.limit)} Your changes were saved as a draft.`,
          id: pageId,
          limit: gate.limit,
          publishedTotal: gate.publishedTotal,
        };
      }
    }

    return { ok: true as const, id: pageId };
  });

export const deleteTenantPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ workspaceId: z.string().uuid(), id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertMember(data.workspaceId, context.userId);
    const { error } = await sb()
      .from("tenant_pages")
      .delete()
      .eq("id", data.id)
      .eq("workspace_id", data.workspaceId);
    if (error) throw new Error(error.message);
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

    // Protect already-published pages: a re-import (same workspace+slug) must not
    // silently overwrite a live page's edited content, status, or published_at.
    // Skip published slugs; upsert only new pages and existing drafts.
    // A duplicate slug inside one batch makes the upsert fail with a raw
    // Postgres "cannot affect row a second time" error — keep the first
    // occurrence and count the rest as skipped.
    const seenSlugs = new Set<string>();
    const uniqueRows = data.rows.filter((r) => {
      const s = r.slug.toLowerCase();
      if (seenSlugs.has(s)) return false;
      seenSlugs.add(s);
      return true;
    });
    const dupSkipped = data.rows.length - uniqueRows.length;

    const slugs = uniqueRows.map((r) => r.slug.toLowerCase());
    const { data: existing } = await sb()
      .from("tenant_pages")
      .select("slug, status")
      .eq("workspace_id", data.workspaceId)
      .in("slug", slugs);
    const publishedSlugs = new Set(
      (existing ?? []).filter((r: any) => r.status === "published").map((r: any) => r.slug),
    );

    // Bulk pre-check (§31): know the entitlement BEFORE generating/publishing.
    // Rows are always written as drafts; if publishing was requested, the
    // atomic gate then flips as many as the plan allows and reports the rest.
    const inserts = uniqueRows
      .filter((r) => !publishedSlugs.has(r.slug.toLowerCase()))
      .map((r) => ({
        workspace_id: data.workspaceId,
        template_id: data.templateId,
        slug: r.slug.toLowerCase(),
        title: r.title,
        meta_description: r.metaDescription ?? null,
        h1: r.title,
        variables: r.variables,
        listing_filter: r.listingFilter,
        status: "draft",
      }));

    const skipped = uniqueRows.length - inserts.length + dupSkipped;
    if (inserts.length === 0) {
      return { ok: true as const, count: 0, skipped, publishedCount: 0, limitDenied: 0, limit: null as number | null };
    }
    const { data: out, error } = await sb()
      .from("tenant_pages")
      .upsert(inserts, { onConflict: "workspace_id,slug", ignoreDuplicates: false })
      .select("id");
    if (error) return { ok: false as const, error: error.message };

    let publishedCount = 0;
    let limitDenied = 0;
    let limit: number | null = null;
    if (data.status === "published" && out && out.length > 0) {
      const { publishPagesAtomically } = await import("@/lib/entitlements.functions");
      const gate = await publishPagesAtomically(
        data.workspaceId,
        (out as Array<{ id: string }>).map((r) => r.id),
      );
      publishedCount = gate.published;
      limitDenied = gate.denied;
      limit = gate.limit;
    }

    return {
      ok: true as const,
      count: out?.length ?? 0,
      skipped,
      publishedCount,
      limitDenied,
      limit,
    };
  });
