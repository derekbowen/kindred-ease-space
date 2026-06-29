import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";

const sb = () => supabaseAdmin as any;

export type BuilderCity = {
  city: string;
  state: string | null;
  listingCount: number;
  hasPage: boolean;
};

export const getPageBuilderContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ workspaceId: workspaceIdSchema }).parse(d))
  .handler(
    async ({
      data,
      context,
    }): Promise<{
      workspaceName: string;
      domain: string | null;
      stats: {
        publishedPages: number;
        draftPages: number;
        syncedListings: number;
        cityGaps: number;
      };
      cities: BuilderCity[];
      gaps: BuilderCity[];
      recentSlugs: string[];
    }> => {
      await assertWorkspaceMember(data.workspaceId, context.userId);

      const [{ data: listings }, { data: pages }, { data: ws }] = await Promise.all([
        sb()
          .from("tenant_listings")
          .select("city, state")
          .eq("workspace_id", data.workspaceId)
          .eq("state_published", true)
          .not("city", "is", null)
          .limit(2000),
        sb()
          .from("tenant_pages")
          .select("slug, variables, status")
          .eq("workspace_id", data.workspaceId),
        sb()
          .from("workspaces")
          .select("name, marketplace_domain")
          .eq("id", data.workspaceId)
          .maybeSingle(),
      ]);

      type PageRow = {
        slug: string | null;
        variables: Record<string, unknown> | null;
        status: string | null;
      };
      type ListingRow = { city: string | null; state: string | null };

      const pageRows = (pages ?? []) as PageRow[];
      const pageSlugs = new Set(
        pageRows.map((p) => String(p.slug ?? "").toLowerCase()).filter(Boolean),
      );
      const pageCities = new Set(
        pageRows
          .map((p) => (p.variables?.city as string | undefined)?.toLowerCase())
          .filter(Boolean) as string[],
      );

      const cityMap = new Map<string, BuilderCity>();
      for (const row of (listings ?? []) as ListingRow[]) {
        const city = String(row.city ?? "").trim();
        if (!city) continue;
        const state = row.state ? String(row.state).trim() : null;
        const key = `${city.toLowerCase()}|${(state ?? "").toLowerCase()}`;
        const existing = cityMap.get(key);
        if (existing) {
          existing.listingCount += 1;
        } else {
          cityMap.set(key, {
            city,
            state,
            listingCount: 1,
            hasPage: pageCities.has(city.toLowerCase()),
          });
        }
      }

      const cities = [...cityMap.values()]
        .sort((a, b) => b.listingCount - a.listingCount)
        .slice(0, 40);

      const gaps = cities.filter((c) => !c.hasPage).slice(0, 12);
      const published = pageRows.filter((p) => p.status === "published").length;
      const drafts = pageRows.filter((p) => p.status === "draft").length;

      const recentSlugs: string[] = [...pageSlugs].slice(0, 20);

      return {
        workspaceName: ws?.name ?? "Your marketplace",
        domain: ws?.marketplace_domain ?? null,
        stats: {
          publishedPages: published,
          draftPages: drafts,
          syncedListings: listings?.length ?? 0,
          cityGaps: gaps.length,
        },
        cities,
        gaps,
        recentSlugs,
      };
    },
  );
