import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { recordPage404 } from "@/lib/page-data.helpers.server";

const sb = () => supabaseAdmin as any;

/**
 * Resolve the public request host server-side. Route loaders run during SSR
 * where `window` is undefined, so the host MUST come from request headers
 * (Cloudflare sets `x-forwarded-host` to the original tenant domain), not from
 * the client. Returns undefined when called outside a request context.
 */
function resolveRequestHost(): string | undefined {
  try {
    const raw = getRequestHeader("x-forwarded-host") || getRequestHeader("host");
    if (!raw) return undefined;
    return raw.split(",")[0]!.trim().toLowerCase().replace(/:\d+$/, "") || undefined;
  } catch {
    return undefined;
  }
}

export type PublicListing = {
  id: string;
  title: string;
  description: string | null;
  price_amount: number | null;
  price_currency: string | null;
  city: string | null;
  state: string | null;
  marketplace_url: string;
  images: Array<{ url: string; alt?: string; width?: number | null; height?: number | null }>;
  structured_data: any;
};

export type PublicTenantPage = {
  id: string;
  slug: string;
  title: string;
  meta_description: string | null;
  h1: string | null;
  body_markdown: string | null;
  variables: Record<string, any>;
  template_slug: string;
  workspace_name: string;
  listings: PublicListing[];
};

export const getPublicTenantPage = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ slug: z.string().min(1).max(200) }).parse(d))
  .handler(async ({ data }): Promise<{ page: PublicTenantPage | null; host: string | null; redirect?: string }> => {
    const host = resolveRequestHost() ?? null;
    let workspaceId: string | null = null;

    if (host) {
      const { data: ws, error } = await sb().rpc("current_workspace_id_by_host", { _host: host });
      if (error) console.error("[getPublicTenantPage] host lookup failed:", error.message);
      if (ws) workspaceId = ws as string;
    }

    if (!workspaceId) return { page: null, host };

    const { data: redirectRow } = await sb()
      .from("content_pages")
      .select("redirect_to")
      .eq("workspace_id", workspaceId)
      .eq("status", "redirect")
      .or(`slug.eq.${data.slug},url_path.eq./p/${data.slug}`)
      .maybeSingle();
    if (redirectRow?.redirect_to) {
      return { page: null, host, redirect: redirectRow.redirect_to as string };
    }

    const { data: page } = await sb()
      .from("tenant_pages")
      .select(
        "id, slug, title, meta_description, h1, body_markdown, variables, listing_filter, template_id, page_templates:template_id(slug), workspaces:workspace_id(name)",
      )
      .eq("workspace_id", workspaceId)
      .eq("slug", data.slug)
      .eq("status", "published")
      .maybeSingle();

    if (!page) {
      // Legacy content_pages rows (pre-unification) still need to render at /p/{slug}.
      const { data: legacy } = await sb()
        .from("content_pages")
        .select("id, slug, title, seo_title, seo_description, body_markdown, workspaces:workspace_id(name)")
        .eq("workspace_id", workspaceId)
        .eq("slug", data.slug)
        .eq("status", "published")
        .maybeSingle();
      if (!legacy) {
        await recordPage404(workspaceId, data.slug);
        return { page: null, host };
      }
      return {
        page: {
          id: legacy.id,
          slug: legacy.slug ?? data.slug,
          title: legacy.seo_title || legacy.title || data.slug,
          meta_description: legacy.seo_description,
          h1: legacy.title,
          body_markdown: legacy.body_markdown,
          variables: {},
          template_slug: "city_hub",
          workspace_name: (legacy.workspaces as any)?.name ?? "",
          listings: [],
        },
        host,
      };
    }

    const f = (page.listing_filter ?? {}) as Record<string, any>;
    let q = sb()
      .from("tenant_listings")
      .select(
        "id, title, description, price_amount, price_currency, city, state, marketplace_url, images, structured_data",
      )
      .eq("workspace_id", workspaceId)
      .eq("state_published", true);
    if (f.city) q = q.ilike("city", String(f.city));
    if (f.state) q = q.ilike("state", String(f.state));
    if (f.category) q = q.eq("category", String(f.category));
    q = q.order("synced_at", { ascending: false }).limit(Math.min(Number(f.limit ?? 24), 100));
    const { data: listings } = await q;

    return {
      page: {
        id: page.id,
        slug: page.slug,
        title: page.title,
        meta_description: page.meta_description,
        h1: page.h1,
        body_markdown: page.body_markdown,
        variables: (page.variables ?? {}) as Record<string, any>,
        template_slug: (page.page_templates as any)?.slug ?? "city_hub",
        workspace_name: (page.workspaces as any)?.name ?? "",
        listings: (listings ?? []) as PublicListing[],
      },
      host,
    };
  });