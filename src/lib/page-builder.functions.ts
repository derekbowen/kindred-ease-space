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
  .handler(async ({ data, context }) => {
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

    const pageSlugs = new Set((pages ?? []).map((p: any) => String(p.slug).toLowerCase()));
    const pageCities = new Set(
      (pages ?? [])
        .map((p: any) => (p.variables?.city as string | undefined)?.toLowerCase())
        .filter(Boolean),
    );

    const cityMap = new Map<string, BuilderCity>();
    for (const row of listings ?? []) {
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
    const published = (pages ?? []).filter((p: any) => p.status === "published").length;
    const drafts = (pages ?? []).filter((p: any) => p.status === "draft").length;

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
      recentSlugs: [...pageSlugs].slice(0, 20),
    };
  });