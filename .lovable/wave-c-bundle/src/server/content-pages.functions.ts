/**
 * content_pages access contract (SECURITY)
 * ----------------------------------------
 * - The table has NO public/anon SELECT RLS policy. The only policy is
 *   "Admins manage content pages" (ALL, has_role admin).
 * - Table-level grants for `anon` and `authenticated` are REVOKED
 *   (migration 20260503_content_pages_revoke_grants). Defense-in-depth:
 *   even if a permissive policy is later added, PostgREST still rejects
 *   the request at the grant layer.
 * - Therefore content_pages MUST be queried server-side using
 *   `supabaseAdmin` (service role bypasses RLS + grants).
 * - NEVER import this table via the browser `@/integrations/supabase/client`.
 *   Public /p/{slug} pages render SSR through `lookupContentPage` below;
 *   sitemap routes use `supabaseAdmin` directly.
 */
import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";

// Fire-and-forget: log a 301 redirect from a legacy slug to the canonical
// slug. Failures are swallowed so logging never blocks the user-visible
// redirect.
function logRedirect(fromSlug: string, toSlug: string): void {
  let userAgent: string | null = null;
  let referrer: string | null = null;
  try {
    userAgent = getRequestHeader("user-agent") ?? null;
    referrer = getRequestHeader("referer") ?? null;
  } catch {
    // No active request context; leave as null.
  }
  void (supabaseAdmin as any)
    .from("redirect_log")
    .insert({
      from_slug: fromSlug,
      to_slug: toSlug,
      user_agent: userAgent,
      referrer: referrer,
    })
    .then((res: { error?: unknown }) => {
      if (res?.error) console.error("[redirect_log] insert failed", res.error);
    });
}

export type ContentPageTemplateType =
  | "host_acq_city"
  | "event_guide"
  | "resource"
  | "elearning"
  | "listing"
  | "host_advocacy_hub"
  | "host_advocacy_state"
  | "spanish_host_acq"
  | "spanish_resource"
  | "homepage"
  | "host_acq_hub"
  | "swim_instructor_city"
  | "swim_instructor_hub"
  | "account_legal"
  | "other";

export interface ContentPage {
  id: string;
  slug: string | null;
  url_path: string;
  source_url: string;
  template_type: ContentPageTemplateType | null;
  category: string;
  locale: string;
  title: string | null;
  seo_title: string | null;
  seo_description: string | null;
  hero_image_url: string | null;
  body_markdown: string | null;
  raw_html: string | null;
  status: string;
  scraped_at: string | null;
  updated_at: string;
  // Compatibility aliases used by older templates
  description?: string | null;
  content?: string | null;
  cover_image_url?: string | null;
  language?: string;
  author?: string | null;
  published_at?: string | null;
  is_published?: boolean;
  legacy_slugs?: string[];
  hreflang_alt?: string | null;
  /** Optional AI/derived enrichment surfaced on blog posts. */
  tldr_bullets?: string[] | null;
  related_slugs?: string[] | null;
  topic?: string | null;
}

export type ContentPageLookupResult =
  | { kind: "found"; page: ContentPage }
  | { kind: "redirect"; canonicalSlug: string }
  | { kind: "not_found" };

/**
 * Looks up a content page by slug. If the slug is in another row's
 * `legacy_slugs[]` array, returns a redirect descriptor pointing at the
 * canonical slug. Caller is responsible for issuing the 301.
 */
export const lookupContentPage = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => z.object({ slug: z.string().min(1) }).parse(data))
  .handler(async ({ data }): Promise<ContentPageLookupResult> => {
    const { slug } = data;

    // Prefer canonical /p/{slug} url_path; multiple rows may share a slug
    // (e.g. nested legacy paths like /p/foo/become-a-pool-host-...)
    const canonicalPath = `/p/${slug}`;
    const { data: rows } = await (supabaseAdmin as any)
      .from("content_pages")
      .select("*")
      .eq("slug", slug)
      .eq("status", "published")
      .order("priority", { ascending: false })
      .limit(5);

    const list = (rows ?? []) as ContentPage[];
    const page =
      list.find((r) => r.url_path === canonicalPath) ?? list[0] ?? null;

    if (page) {
      // Honor an explicit redirect_to on the canonical row.
      const redirectTo = (page as unknown as { redirect_to?: string | null }).redirect_to;
      if (redirectTo && typeof redirectTo === "string") {
        const target = redirectTo.startsWith("/p/")
          ? redirectTo.slice(3)
          : redirectTo;
        if (target && target !== slug) {
          logRedirect(slug, target);
          return { kind: "redirect", canonicalSlug: target };
        }
      }
      return { kind: "found", page };
    }

    // Alias lookup: any published page that lists this slug in legacy_slugs[]
    // becomes the canonical destination for a 301 redirect.
    const { data: aliasRows } = await (supabaseAdmin as any)
      .from("content_pages")
      .select("slug")
      .contains("legacy_slugs", [slug])
      .eq("status", "published")
      .limit(1);
    const alias = (aliasRows ?? [])[0] as { slug: string | null } | undefined;
    if (alias?.slug && alias.slug !== slug) {
      logRedirect(slug, alias.slug);
      return { kind: "redirect", canonicalSlug: alias.slug };
    }

    // Fallback: many host-acq / swim-instructor slugs are stored with a
    // `-{state_code}` suffix (e.g. `become-a-swimming-pool-host-cleveland-oh`).
    // If a visitor hits the bare-city variant (`...-cleveland`), look up the
    // city's state and 301 to the canonical state-suffixed slug if it exists.
    const KNOWN_PREFIXES = [
      "become-a-swimming-pool-host-",
      "swim-instructor-pool-rental-",
      "rent-a-swimming-pool-",
      "pool-rental-",
      "host-acquisition-",
    ];
    const matchedPrefix = KNOWN_PREFIXES.find((p) => slug.startsWith(p));
    if (matchedPrefix) {
      const citySlug = slug.slice(matchedPrefix.length);
      if (!/-[a-z]{2}$/.test(citySlug) && citySlug.length > 0) {
        const { data: cityRows } = await (supabaseAdmin as any)
          .from("cities")
          .select("slug, state_code")
          .eq("slug", citySlug)
          .eq("is_published", true)
          .limit(1);
        const city = (cityRows ?? [])[0] as { slug: string; state_code: string } | undefined;
        if (city?.state_code) {
          const candidate = `${matchedPrefix}${citySlug}-${city.state_code.toLowerCase()}`;
          const { data: candRows } = await (supabaseAdmin as any)
            .from("content_pages")
            .select("slug")
            .eq("slug", candidate)
            .eq("status", "published")
            .limit(1);
          if ((candRows ?? []).length > 0) {
            logRedirect(slug, candidate);
            return { kind: "redirect", canonicalSlug: candidate };
          }
        }
      }
    }

    // Fallback: published blog posts also live at /p/{slug} now (legacy
    // /blog/{slug} URLs were retired). Render them through the dispatcher
    // as a synthetic resource-article page so canonical, OG, and JSON-LD
    // are all built from /p/{slug} via the existing head() pipeline.
    const { data: blogRows } = await (supabaseAdmin as any)
      .from("blog_posts")
      .select(
        "id, slug, title, excerpt, content, cover_image_url, author, seo_title, seo_description, is_published, published_at, updated_at, topic, tldr_bullets, related_slugs",
      )
      .eq("slug", slug)
      .eq("is_published", true)
      .limit(1);
    const blog = (blogRows ?? [])[0] as
      | {
          id: string;
          slug: string;
          title: string | null;
          excerpt: string | null;
          content: string | null;
          cover_image_url: string | null;
          author: string | null;
          seo_title: string | null;
          seo_description: string | null;
          published_at: string | null;
          updated_at: string;
          topic: string | null;
          tldr_bullets: unknown;
          related_slugs: unknown;
        }
      | undefined;
    if (blog) {
      const tldr = Array.isArray(blog.tldr_bullets)
        ? (blog.tldr_bullets as unknown[]).filter((s): s is string => typeof s === "string")
        : null;
      const related = Array.isArray(blog.related_slugs)
        ? (blog.related_slugs as unknown[]).filter((s): s is string => typeof s === "string")
        : null;
      const synthetic: ContentPage = {
        id: blog.id,
        slug: blog.slug,
        url_path: `/p/${blog.slug}`,
        source_url: `${"" /* no upstream */}`,
        template_type: "resource",
        category: blog.topic ?? "blog",
        locale: "en",
        title: blog.title,
        seo_title: blog.seo_title,
        seo_description: blog.seo_description,
        hero_image_url: blog.cover_image_url,
        body_markdown: blog.content,
        raw_html: null,
        status: "published",
        scraped_at: null,
        updated_at: blog.updated_at,
        description: blog.excerpt,
        content: blog.content,
        cover_image_url: blog.cover_image_url,
        language: "en",
        author: blog.author,
        published_at: blog.published_at,
        is_published: true,
        legacy_slugs: [],
        hreflang_alt: null,
        tldr_bullets: tldr,
        related_slugs: related,
        topic: blog.topic,
      };
      return { kind: "found", page: synthetic };
    }

    return { kind: "not_found" };
  });

export const getHreflangSibling = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => z.object({ pageId: z.string().uuid() }).parse(data))
  .handler(async ({ data }): Promise<{ sibling: null | { slug: string; language: string } }> => {
    const { pageId } = data;

    // Load the source page to read its hreflang_alt FK / hreflang_group.
    const { data: pageRow } = await (supabaseAdmin as any)
      .from("content_pages")
      .select("id, locale, hreflang_group, hreflang_alt")
      .eq("id", pageId)
      .maybeSingle();

    if (!pageRow) return { sibling: null };

    // Prefer the explicit hreflang_alt FK when present.
    const altId = (pageRow as { hreflang_alt?: string | null }).hreflang_alt;
    if (altId) {
      const { data: sib } = await (supabaseAdmin as any)
        .from("content_pages")
        .select("slug, locale, status")
        .eq("id", altId)
        .eq("status", "published")
        .maybeSingle();
      if (sib?.slug && sib?.locale) {
        return { sibling: { slug: sib.slug, language: sib.locale } };
      }
      return { sibling: null };
    }

    // Fallback: find another published row sharing the same hreflang_group.
    const group = (pageRow as { hreflang_group?: string | null }).hreflang_group;
    if (!group) return { sibling: null };

    const { data: sibRows } = await (supabaseAdmin as any)
      .from("content_pages")
      .select("slug, locale")
      .eq("hreflang_group", group)
      .eq("status", "published")
      .neq("id", pageId)
      .limit(1);

    const sib = (sibRows ?? [])[0] as { slug: string | null; locale: string | null } | undefined;
    if (sib?.slug && sib?.locale) {
      return { sibling: { slug: sib.slug, language: sib.locale } };
    }
    return { sibling: null };
  });

