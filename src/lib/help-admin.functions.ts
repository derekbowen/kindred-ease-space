import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { marked } from "marked";

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("has_role", {
    _user_id: userId,
    _role: "admin",
  });
  if (error || !data) throw new Error("forbidden");
}

function readingTime(md: string): number {
  const words = md.replace(/[`*_#>\-\[\]\(\)]/g, " ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

function renderHtml(md: string): string {
  return marked.parse(md ?? "", { async: false }) as string;
}

// ---------------- Categories ----------------

export const adminListCategories = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data, error } = await supabaseAdmin
      .from("help_categories")
      .select("id,slug,name,description,icon,sort_order,is_published,updated_at")
      .is("workspace_id", null)
      .order("sort_order", { ascending: true });
    if (error) throw error;
    return data ?? [];
  });

const CategoryUpsertSchema = z.object({
  id: z.string().uuid().optional().nullable(),
  slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9-]+$/),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  icon: z.string().trim().max(60).optional().nullable(),
  sort_order: z.number().int().min(0).default(0),
  is_published: z.boolean().default(true),
});

export const adminUpsertCategory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => CategoryUpsertSchema.parse(d))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.supabase, context.userId);
    const payload = {
      slug: data.slug,
      name: data.name,
      description: data.description ?? null,
      icon: data.icon ?? null,
      sort_order: data.sort_order,
      is_published: data.is_published,
      workspace_id: null,
    };
    if (data.id) {
      const { error } = await supabaseAdmin.from("help_categories").update(payload).eq("id", data.id);
      if (error) throw error;
      return { id: data.id };
    }
    const { data: row, error } = await supabaseAdmin
      .from("help_categories")
      .insert(payload)
      .select("id")
      .single();
    if (error) throw error;
    return { id: row!.id as string };
  });

export const adminDeleteCategory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.supabase, context.userId);
    const { error } = await supabaseAdmin.from("help_categories").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

export const adminReorderCategories = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ ids: z.array(z.string().uuid()).max(200) }).parse(d)
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context.supabase, context.userId);
    await Promise.all(
      data.ids.map((id, idx) =>
        supabaseAdmin.from("help_categories").update({ sort_order: idx }).eq("id", id)
      )
    );
    return { ok: true };
  });

// ---------------- Articles ----------------

export const adminListArticles = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data, error } = await supabaseAdmin
      .from("help_articles")
      .select("id,slug,title,category_slug,status,is_popular,view_count,helpful_count,not_helpful_count,updated_at,published_at")
      .is("workspace_id", null)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return data ?? [];
  });

export const adminGetArticle = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.supabase, context.userId);
    const { data: row, error } = await supabaseAdmin
      .from("help_articles")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    return row;
  });

const ArticleUpsertSchema = z.object({
  id: z.string().uuid().optional().nullable(),
  slug: z.string().trim().min(1).max(150).regex(/^[a-z0-9-]+$/),
  title: z.string().trim().min(1).max(200),
  category_slug: z.string().trim().min(1).max(100),
  excerpt: z.string().trim().max(500).optional().nullable(),
  content: z.string().max(100000).default(""),
  status: z.enum(["draft", "published", "archived"]).default("draft"),
  is_popular: z.boolean().default(false),
  seo_title: z.string().trim().max(200).optional().nullable(),
  seo_description: z.string().trim().max(300).optional().nullable(),
  tags: z.array(z.string().trim().max(40)).max(20).default([]),
  author_name: z.string().trim().max(120).optional().nullable(),
});

export const adminUpsertArticle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ArticleUpsertSchema.parse(d))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.supabase, context.userId);
    const isPublishing = data.status === "published";
    const payload: Record<string, unknown> = {
      slug: data.slug,
      title: data.title,
      category_slug: data.category_slug,
      excerpt: data.excerpt ?? null,
      content: data.content,
      body_html: renderHtml(data.content),
      status: data.status,
      is_popular: data.is_popular,
      is_published: isPublishing,
      seo_title: data.seo_title ?? null,
      seo_description: data.seo_description ?? null,
      tags: data.tags,
      author_name: data.author_name ?? null,
      reading_time_minutes: readingTime(data.content),
      workspace_id: null,
    };
    if (isPublishing) {
      payload.published_at = new Date().toISOString();
    }
    if (data.id) {
      // don't overwrite published_at if already set and re-publishing
      if (isPublishing) {
        const { data: existing } = await supabaseAdmin
          .from("help_articles")
          .select("published_at")
          .eq("id", data.id)
          .maybeSingle();
        if (existing?.published_at) delete payload.published_at;
      }
      const { error } = await supabaseAdmin.from("help_articles").update(payload).eq("id", data.id);
      if (error) throw error;
      return { id: data.id };
    }
    const { data: row, error } = await supabaseAdmin
      .from("help_articles")
      .insert(payload)
      .select("id")
      .single();
    if (error) throw error;
    return { id: row!.id as string };
  });

export const adminDeleteArticle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    await assertAdmin(context.supabase, context.userId);
    const { error } = await supabaseAdmin.from("help_articles").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });
