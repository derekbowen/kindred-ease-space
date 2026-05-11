import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const sb = () => supabaseAdmin as any;

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
  .handler(async ({ data }): Promise<{ page: PublicTenantPage | null }> => {
    let workspaceId = data.workspaceId ?? null;

    if (!workspaceId && data.host) {
      const { data: ws } = await sb().rpc("workspace_for_host", { _host: data.host });
      if (ws) workspaceId = ws as string;
    }
    // Fallback: if there is exactly one workspace in the project, use it
    if (!workspaceId) {
      const { data: rows } = await sb().from("workspaces").select("id").limit(2);
      if (rows && rows.length === 1) workspaceId = rows[0].id;
    }
    if (!workspaceId) return { page: null };

    const { data: page } = await sb()
      .from("tenant_pages")
      .select(
        "id, slug, title, meta_description, h1, body_markdown, variables, listing_filter, template_id, page_templates:template_id(slug), workspaces:workspace_id(name)",
      )
      .eq("workspace_id", workspaceId)
      .eq("slug", data.slug)
      .eq("status", "published")
      .maybeSingle();

    if (!page) return { page: null };

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
    };
  });
