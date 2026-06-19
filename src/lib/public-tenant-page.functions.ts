import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

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
    // Mirror window.location.host (hostname[:port]) but drop a trailing port so
    // it matches the stored domain. Take the first value if a list is present.
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
  .inputValidator((d) =>
    z
      .object({
        slug: z.string().min(1).max(200),
        host: z.string().min(3).max(253).optional(),
        workspaceId: z.string().uuid().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<{ page: PublicTenantPage | null; host: string | null }> => {
    let workspaceId = data.workspaceId ?? null;

    // Prefer the host the client passed (if any), but always fall back to the
    // real request host resolved server-side — the loader can't read it during SSR.
    const host = data.host ?? resolveRequestHost() ?? null;
    if (!workspaceId && host) {
      const { data: ws } = await sb().rpc("workspace_for_host", { _host: host });
      if (ws) workspaceId = ws as string;
    }
    // Fallback: if there is exactly one workspace in the project, use it
    if (!workspaceId) {
      const { data: rows } = await sb().from("workspaces").select("id").limit(2);
      if (rows && rows.length === 1) workspaceId = rows[0].id;
    }
    if (!workspaceId) return { page: null, host };

    const { data: page } = await sb()
      .from("tenant_pages")
      .select(
        "id, slug, title, meta_description, h1, body_markdown, variables, listing_filter, template_id, page_templates:template_id(slug), workspaces:workspace_id(name)",
      )
      .eq("workspace_id", workspaceId)
      .eq("slug", data.slug)
      .eq("status", "published")
      .maybeSingle();

    if (!page) return { page: null, host };

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
