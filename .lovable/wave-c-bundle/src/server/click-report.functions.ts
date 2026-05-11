import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const InputSchema = z.object({
  days: z.number().int().min(1).max(365).default(30),
  limit: z.number().int().min(1).max(500).default(50),
});

export type CityClickReportRow = {
  to_city_slug: string;
  city_name: string | null;
  state_code: string | null;
  total_clicks: number;
  unique_visitors: number;
  last_clicked_at: string;
};

export type CityClickReport = {
  rows: CityClickReportRow[];
  windowDays: number;
  generatedAt: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function assertAdmin(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error("Failed to verify admin role");
  if (!data) throw new Error("Forbidden: admin role required");
}

export const getCityClickReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data, context }): Promise<CityClickReport> => {
    const { userId } = context as { userId: string };
    await assertAdmin(userId);

    const since = new Date(Date.now() - data.days * 24 * 60 * 60 * 1000).toISOString();

    // Pull raw click rows in the window (admin client — already gated above).
    // Cap raw scan at 50k to be safe.
    const { data: rows, error } = await supabaseAdmin
      .from("city_link_clicks")
      .select("to_city_slug, visitor_hash, clicked_at")
      .gte("clicked_at", since)
      .order("clicked_at", { ascending: false })
      .limit(50000);

    if (error) throw new Error(error.message);

    const agg = new Map<
      string,
      { total: number; visitors: Set<string>; last: string }
    >();
    for (const r of rows ?? []) {
      const slug = r.to_city_slug as string;
      const entry = agg.get(slug) ?? { total: 0, visitors: new Set<string>(), last: r.clicked_at as string };
      entry.total += 1;
      if (r.visitor_hash) entry.visitors.add(r.visitor_hash as string);
      if ((r.clicked_at as string) > entry.last) entry.last = r.clicked_at as string;
      agg.set(slug, entry);
    }

    const sortedSlugs = Array.from(agg.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, data.limit);

    // Look up display names for top slugs only.
    const slugs = sortedSlugs.map(([s]) => s);
    const { data: cities } = slugs.length
      ? await supabaseAdmin
          .from("cities")
          .select("slug, name, state_code")
          .in("slug", slugs)
      : { data: [] as Array<{ slug: string; name: string; state_code: string }> };

    const cityMap = new Map<string, { name: string; state_code: string }>();
    for (const c of cities ?? []) cityMap.set(c.slug, { name: c.name, state_code: c.state_code });

    const result: CityClickReportRow[] = sortedSlugs.map(([slug, v]) => ({
      to_city_slug: slug,
      city_name: cityMap.get(slug)?.name ?? null,
      state_code: cityMap.get(slug)?.state_code ?? null,
      total_clicks: v.total,
      unique_visitors: v.visitors.size,
      last_clicked_at: v.last,
    }));

    return {
      rows: result,
      windowDays: data.days,
      generatedAt: new Date().toISOString(),
    };
  });
