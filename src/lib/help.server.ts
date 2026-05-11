// Server-only Help Center data access. Uses supabaseAdmin with workspace_id IS NULL
// to scope to the platform-level (founders.click) help center.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type HelpCategory = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  sort_order: number;
};

export type HelpArticleListItem = {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  category_slug: string;
  reading_time_minutes: number | null;
  view_count: number;
  published_at: string | null;
  updated_at: string;
};

export type HelpArticleFull = HelpArticleListItem & {
  content: string;
  author_name: string | null;
  author_avatar_url: string | null;
  helpful_count: number;
  not_helpful_count: number;
  related_article_ids: string[];
  tags: string[];
};

export async function listCategories(): Promise<HelpCategory[]> {
  const { data, error } = await supabaseAdmin
    .from("help_categories")
    .select("id,slug,name,description,icon,sort_order")
    .is("workspace_id", null)
    .eq("is_published", true)
    .order("sort_order", { ascending: true });
  if (error) {
    console.error("[help] listCategories", error);
    return [];
  }
  return (data ?? []) as HelpCategory[];
}

export async function getCategoryBySlug(slug: string): Promise<HelpCategory | null> {
  const { data, error } = await supabaseAdmin
    .from("help_categories")
    .select("id,slug,name,description,icon,sort_order")
    .is("workspace_id", null)
    .eq("slug", slug)
    .eq("is_published", true)
    .maybeSingle();
  if (error) {
    console.error("[help] getCategoryBySlug", error);
    return null;
  }
  return (data as HelpCategory) ?? null;
}

export async function listArticlesByCategory(categorySlug: string): Promise<HelpArticleListItem[]> {
  const { data, error } = await supabaseAdmin
    .from("help_articles")
    .select("id,slug,title,excerpt,category_slug,reading_time_minutes,view_count,published_at,updated_at")
    .is("workspace_id", null)
    .eq("category_slug", categorySlug)
    .eq("status", "published")
    .order("sort_order", { ascending: true })
    .order("published_at", { ascending: false });
  if (error) {
    console.error("[help] listArticlesByCategory", error);
    return [];
  }
  return (data ?? []) as HelpArticleListItem[];
}

export async function getArticleBySlug(categorySlug: string, articleSlug: string): Promise<HelpArticleFull | null> {
  const { data, error } = await supabaseAdmin
    .from("help_articles")
    .select("id,slug,title,excerpt,category_slug,reading_time_minutes,view_count,published_at,updated_at,content,author_name,author_avatar_url,helpful_count,not_helpful_count,related_article_ids,tags")
    .is("workspace_id", null)
    .eq("category_slug", categorySlug)
    .eq("slug", articleSlug)
    .eq("status", "published")
    .maybeSingle();
  if (error) {
    console.error("[help] getArticleBySlug", error);
    return null;
  }
  return (data as HelpArticleFull) ?? null;
}

export async function getRelatedArticles(ids: string[]): Promise<HelpArticleListItem[]> {
  if (!ids?.length) return [];
  const { data, error } = await supabaseAdmin
    .from("help_articles")
    .select("id,slug,title,excerpt,category_slug,reading_time_minutes,view_count,published_at,updated_at")
    .in("id", ids)
    .eq("status", "published")
    .limit(4);
  if (error) {
    console.error("[help] getRelatedArticles", error);
    return [];
  }
  return (data ?? []) as HelpArticleListItem[];
}

export async function listPopularArticles(limit = 6): Promise<HelpArticleListItem[]> {
  const { data, error } = await supabaseAdmin
    .from("help_articles")
    .select("id,slug,title,excerpt,category_slug,reading_time_minutes,view_count,published_at,updated_at")
    .is("workspace_id", null)
    .eq("status", "published")
    .order("view_count", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[help] listPopularArticles", error);
    return [];
  }
  return (data ?? []) as HelpArticleListItem[];
}

export async function listRecentArticles(limit = 4): Promise<HelpArticleListItem[]> {
  const { data, error } = await supabaseAdmin
    .from("help_articles")
    .select("id,slug,title,excerpt,category_slug,reading_time_minutes,view_count,published_at,updated_at")
    .is("workspace_id", null)
    .eq("status", "published")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[help] listRecentArticles", error);
    return [];
  }
  return (data ?? []) as HelpArticleListItem[];
}

export async function listAllPublishedArticleSlugs(): Promise<Array<{ category_slug: string; slug: string; updated_at: string }>> {
  const { data, error } = await supabaseAdmin
    .from("help_articles")
    .select("category_slug,slug,updated_at")
    .is("workspace_id", null)
    .eq("status", "published");
  if (error) {
    console.error("[help] listAllPublishedArticleSlugs", error);
    return [];
  }
  return (data ?? []) as Array<{ category_slug: string; slug: string; updated_at: string }>;
}

export async function searchArticles(query: string, limit = 25): Promise<Array<HelpArticleListItem & { rank: number }>> {
  const q = query.trim();
  if (!q) return [];
  // websearch_to_tsquery handles user-supplied phrases safely.
  const { data, error } = await supabaseAdmin.rpc as never; // not used; fallback below
  void data; void error; void q;

  // Use a textSearch query — postgrest supports websearch type.
  const res = await supabaseAdmin
    .from("help_articles")
    .select("id,slug,title,excerpt,category_slug,reading_time_minutes,view_count,published_at,updated_at")
    .is("workspace_id", null)
    .eq("status", "published")
    .textSearch("search_vector", q, { type: "websearch", config: "english" })
    .limit(limit);
  if (res.error) {
    console.error("[help] searchArticles", res.error);
    return [];
  }
  return ((res.data ?? []) as HelpArticleListItem[]).map((a) => ({ ...a, rank: 0 }));
}

export async function incrementArticleView(articleId: string): Promise<void> {
  // Best-effort; ignore failures.
  const { error } = await supabaseAdmin
    .from("help_articles")
    .select("view_count")
    .eq("id", articleId)
    .single();
  if (error) return;
  await supabaseAdmin.rpc as never;
  // Use atomic update via raw SQL through a stored fn would be cleaner; do simple update.
  await supabaseAdmin
    .from("help_articles")
    .update({ view_count: (await supabaseAdmin.from("help_articles").select("view_count").eq("id", articleId).single()).data?.view_count ?? 0 + 1 })
    .eq("id", articleId);
}

export async function logSearchQuery(query: string, resultsCount: number, sessionId?: string | null): Promise<void> {
  const { error } = await supabaseAdmin.from("help_search_queries").insert({
    query: query.slice(0, 500),
    results_count: resultsCount,
    session_id: sessionId ?? null,
  });
  if (error) console.error("[help] logSearchQuery", error);
}

export async function submitFeedback(params: {
  articleId: string;
  isHelpful: boolean;
  comment?: string | null;
  sessionId?: string | null;
}): Promise<void> {
  const { error } = await supabaseAdmin.from("help_article_feedback").insert({
    article_id: params.articleId,
    is_helpful: params.isHelpful,
    comment: params.comment?.slice(0, 1000) ?? null,
    session_id: params.sessionId ?? null,
  });
  if (error) {
    console.error("[help] submitFeedback", error);
    throw error;
  }
  // Increment counter (best-effort, non-atomic)
  const { data } = await supabaseAdmin
    .from("help_articles")
    .select("helpful_count,not_helpful_count")
    .eq("id", params.articleId)
    .single();
  if (data) {
    if (params.isHelpful) {
      await supabaseAdmin
        .from("help_articles")
        .update({ helpful_count: (data.helpful_count ?? 0) + 1 })
        .eq("id", params.articleId);
    } else {
      await supabaseAdmin
        .from("help_articles")
        .update({ not_helpful_count: (data.not_helpful_count ?? 0) + 1 })
        .eq("id", params.articleId);
    }
  }
}

export async function submitTicket(params: {
  email: string;
  name?: string | null;
  subject: string;
  message: string;
  category?: string | null;
  workspaceId?: string | null;
}): Promise<{ id: string }> {
  const { data, error } = await supabaseAdmin
    .from("support_tickets")
    .insert({
      email: params.email,
      name: params.name ?? null,
      subject: params.subject,
      message: params.message,
      category: params.category ?? null,
      workspace_id: params.workspaceId ?? null,
    })
    .select("id")
    .single();
  if (error) {
    console.error("[help] submitTicket", error);
    throw error;
  }
  return { id: data!.id as string };
}
