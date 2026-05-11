import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type BlogHubPost = {
  slug: string;
  title: string;
  topic: string | null;
  excerpt: string | null;
  cover_image_url: string | null;
  published_at: string | null;
  updated_at: string | null;
};

/**
 * Public list of published blog posts for the /p/blog hub.
 * Uses supabaseAdmin (RLS-bypassing) — read-only, no PII.
 */
export const listPublishedBlogPosts = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ posts: BlogHubPost[] }> => {
    try {
      const { data, error } = await supabaseAdmin
        .from("blog_posts")
        .select("slug, title, topic, excerpt, cover_image_url, published_at, updated_at")
        .eq("is_published", true)
        .order("published_at", { ascending: false, nullsFirst: false })
        .order("updated_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return { posts: (data ?? []) as BlogHubPost[] };
    } catch {
      return { posts: [] };
    }
  },
);
