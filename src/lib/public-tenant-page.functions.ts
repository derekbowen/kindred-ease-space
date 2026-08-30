import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { recordPage404 } from "@/lib/page-data.helpers.server";

const sb = () => supabaseAdmin as any;

/**
 * Rebuild each listing's marketplace URL — and the URL inside its JSON-LD —
 * from the stored Sharetribe id via the MarketplaceAdapter.
 *
 * Sync still writes marketplace_url for backward compatibility, but it is a
 * FALLBACK, not the source of truth: a customer whose frontend route
 * convention differs (or changes) gets correct links immediately, with no
 * re-sync of their catalogue.
 */
async function resolveListingUrls(
  workspaceId: string,
  rows: Array<Record<string, any>>,
): Promise<PublicListing[]> {
  if (rows.length === 0) return [];
  let cfg: import("@/lib/marketplace/adapter").MarketplaceRouteConfig | null = null;
  try {
    const { data: integration } = await sb()
      .from("tenant_integrations")
      .select("marketplace_url, route_config")
      .eq("workspace_id", workspaceId)
      .eq("provider", "sharetribe")
      .maybeSingle();
    if (integration?.marketplace_url) {
      const { resolveRouteConfig } = await import("@/lib/marketplace/adapter");
      cfg = resolveRouteConfig(integration.marketplace_url, integration.route_config);
    }
  } catch (e) {
    // A config read failure must degrade to the persisted URL, never break the
    // page — this runs on every public page view.
    console.error("[public-page] route config unavailable", workspaceId, String(e));
  }

  const { buildListingUrl } = await import("@/lib/marketplace/adapter");
  return rows.map((r) => {
    const derived =
      cfg && r.sharetribe_listing_id
        ? buildListingUrl(cfg, {
            sharetribe_listing_id: r.sharetribe_listing_id,
            slug: r.slug,
          })
        : null;
    const url = derived ?? r.marketplace_url;
    // Keep JSON-LD consistent with the link the visitor actually follows;
    // a stale `url` in structured data is a mismatch Google can penalise.
    let structured = r.structured_data;
    if (structured && typeof structured === "object" && derived) {
      structured = { ...structured, url };
      if ((structured as any).offers && typeof (structured as any).offers === "object") {
        structured = { ...structured, offers: { ...(structured as any).offers, url } };
      }
    }
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      price_amount: r.price_amount,
      price_currency: r.price_currency,
      city: r.city,
      state: r.state,
      marketplace_url: url,
      images: r.images,
      structured_data: structured,
    } as PublicListing;
  });
}

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
  /** Other published pages in this workspace — internal links so pSEO pages form
   * a crawlable network instead of sitemap-only orphans. */
  related_pages: Array<{ slug: string; title: string }>;
};

export const getPublicTenantPage = createServerFn({ method: "GET" })
  .inputValidator((d) =>
    z
      .object({
        slug: z.string().min(1).max(200),
        // Platform-hosted preview: resolve the workspace by its slug instead of
        // the request host, so a fresh customer can view a page on founders.click
        // before their custom domain is connected/verified.
        workspaceSlug: z.string().min(1).max(120).optional(),
      })
      .parse(d),
  )
  .handler(
    async ({
      data,
    }): Promise<{
      page: PublicTenantPage | null;
      host: string | null;
      redirect?: string;
      preview: boolean;
    }> => {
      const host = resolveRequestHost() ?? null;
      let workspaceId: string | null = null;
      const preview = Boolean(data.workspaceSlug);

      if (data.workspaceSlug) {
        const { data: ws } = await sb()
          .from("workspaces")
          .select("id")
          .eq("slug", data.workspaceSlug)
          .maybeSingle();
        if (ws?.id) workspaceId = ws.id as string;
      } else if (host) {
        const { data: ws, error } = await sb().rpc("current_workspace_id_by_host", { _host: host });
        if (error) console.error("[getPublicTenantPage] host lookup failed:", error.message);
        if (ws) workspaceId = ws as string;
      }

      if (!workspaceId) return { page: null, host, preview };

      // Internal links: without them every pSEO page is a sitemap-only orphan
      // (the listing cards link off-site with nofollow), which Google's doorway
      // guidance penalizes and which starves the network of crawl equity.
      const wsId = workspaceId;
      const fetchRelated = async (excludeSlug: string) => {
        const { data: rel } = await sb()
          .from("tenant_pages")
          .select("slug, title")
          .eq("workspace_id", wsId)
          .eq("status", "published")
          .neq("slug", excludeSlug)
          .order("published_at", { ascending: false })
          .limit(8);
        return (rel ?? []).map((r: any) => ({
          slug: r.slug as string,
          title: r.title as string,
        }));
      };

      const { data: redirectRow } = await sb()
        .from("content_pages")
        .select("redirect_to")
        .eq("workspace_id", workspaceId)
        .eq("status", "redirect")
        .or(`slug.eq.${data.slug},url_path.eq./a/${data.slug},url_path.eq./p/${data.slug}`)
        .maybeSingle();
      if (redirectRow?.redirect_to) {
        return { page: null, host, redirect: redirectRow.redirect_to as string, preview };
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
          .select(
            "id, slug, title, seo_title, seo_description, body_markdown, workspaces:workspace_id(name)",
          )
          .eq("workspace_id", workspaceId)
          .eq("slug", data.slug)
          .eq("status", "published")
          .maybeSingle();
        if (!legacy) {
          // Don't pollute the 404 log with the owner's own preview hits.
          if (!preview) await recordPage404(workspaceId, data.slug);
          return { page: null, host, preview };
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
            related_pages: await fetchRelated(data.slug),
          },
          host,
          preview,
        };
      }

      const f = (page.listing_filter ?? {}) as Record<string, any>;
      let q = sb()
        .from("tenant_listings")
        .select(
          "id, title, description, price_amount, price_currency, city, state, marketplace_url, images, structured_data, sharetribe_listing_id, slug",
        )
        .eq("workspace_id", workspaceId)
        .eq("state_published", true);
      if (f.city) q = q.ilike("city", String(f.city));
      if (f.state) q = q.ilike("state", String(f.state));
      if (f.category) q = q.eq("category", String(f.category));
      q = q.order("synced_at", { ascending: false }).limit(Math.min(Number(f.limit ?? 24), 100));
      const { data: listings } = await q;

      // Derive marketplace URLs at RENDER time through the adapter, so a
      // route-template change takes effect immediately instead of requiring a
      // full listing re-sync. The persisted marketplace_url is a legacy
      // fallback only — never the authority.
      const resolvedListings = await resolveListingUrls(
        workspaceId,
        (listings ?? []) as any[],
      );

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
          listings: resolvedListings,
          related_pages: await fetchRelated(data.slug),
        },
        host,
        preview,
      };
    },
  );
