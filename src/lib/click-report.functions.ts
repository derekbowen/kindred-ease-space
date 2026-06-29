import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";

/**
 * Aggregated click report sourced from city_link_clicks.
 * Reconstructed from the PRNM admin bundle (the source `click-report.functions`
 * file was not included in the export). Shape mirrors what
 * admin.click-report.tsx expects.
 */

export type CityClickRow = {
  to_city_slug: string;
  clicks: number;
  unique_visitors: number;
  top_referrer: string | null;
};

export type CityClickReport = {
  windowDays: number;
  totalClicks: number;
  uniqueVisitors: number;
  topCities: CityClickRow[];
};

const InputSchema = z.object({
  workspaceId: workspaceIdSchema,
  days: z.number().int().min(1).max(365).default(30),
  limit: z.number().int().min(1).max(500).default(50),
});

export const getCityClickReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => InputSchema.parse(data))
  .handler(async ({ data, context }): Promise<CityClickReport> => {
    await assertWorkspaceMember(data.workspaceId, context.userId);

    const since = new Date(Date.now() - data.days * 24 * 60 * 60 * 1000).toISOString();

    const { data: rows, error } = await supabaseAdmin
      .from("city_link_clicks")
      .select("to_city_slug, visitor_hash, referrer_path")
      .eq("workspace_id", data.workspaceId)
      .gte("clicked_at", since);

    if (error) {
      console.error("[getCityClickReport] query failed", error);
      return { windowDays: data.days, totalClicks: 0, uniqueVisitors: 0, topCities: [] };
    }

    const all = rows ?? [];
    const totalClicks = all.length;
    const uniqueVisitors = new Set(all.map((r) => r.visitor_hash).filter(Boolean)).size;

    const byCity = new Map<
      string,
      { clicks: number; visitors: Set<string>; referrers: Map<string, number> }
    >();
    for (const r of all) {
      const slug = r.to_city_slug;
      if (!slug) continue;
      let entry = byCity.get(slug);
      if (!entry) {
        entry = { clicks: 0, visitors: new Set(), referrers: new Map() };
        byCity.set(slug, entry);
      }
      entry.clicks += 1;
      if (r.visitor_hash) entry.visitors.add(r.visitor_hash);
      if (r.referrer_path) {
        entry.referrers.set(r.referrer_path, (entry.referrers.get(r.referrer_path) || 0) + 1);
      }
    }

    const topCities: CityClickRow[] = Array.from(byCity.entries())
      .map(([to_city_slug, e]) => {
        const top = Array.from(e.referrers.entries()).sort((a, b) => b[1] - a[1])[0];
        return {
          to_city_slug,
          clicks: e.clicks,
          unique_visitors: e.visitors.size,
          top_referrer: top ? top[0] : null,
        };
      })
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, data.limit);

    return { windowDays: data.days, totalClicks, uniqueVisitors, topCities };
  });
