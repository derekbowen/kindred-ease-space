import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type HeroReportRow = {
  city_slug: string;
  city_name: string | null;
  state_code: string | null;
  has_hero: boolean;
  ok: number;
  miss: number;
  skipped: number;
  error: number;
  last_status: string | null;
  last_error: string | null;
  last_source_url: string | null;
  last_ran_at: string | null;
};

export const getHeroBackfillReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: roleRow } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleRow) throw new Error("Admin role required");

    // Pull all log rows (paginated to bypass 1000-row default).
    const pageSize = 1000;
    type LogRow = {
      city_slug: string;
      status: string;
      error: string | null;
      source_url: string | null;
      ran_at: string;
    };
    const all: LogRow[] = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabaseAdmin
        .from("cities_hero_backfill_log")
        .select("city_slug,status,error,source_url,ran_at")
        .order("ran_at", { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      all.push(...(data as LogRow[]));
      if (data.length < pageSize) break;
    }

    // Aggregate per city.
    const bySlug = new Map<string, HeroReportRow>();
    for (const row of all) {
      let agg = bySlug.get(row.city_slug);
      if (!agg) {
        agg = {
          city_slug: row.city_slug, city_name: null, state_code: null,
          has_hero: false, ok: 0, miss: 0, skipped: 0, error: 0,
          last_status: null, last_error: null, last_source_url: null, last_ran_at: null,
        };
        bySlug.set(row.city_slug, agg);
      }
      if (row.status === "ok") agg.ok++;
      else if (row.status === "miss") agg.miss++;
      else if (row.status === "skipped") agg.skipped++;
      else if (row.status === "error") agg.error++;
      // First row encountered is newest (ordered desc).
      if (!agg.last_ran_at) {
        agg.last_status = row.status;
        agg.last_error = row.error;
        agg.last_source_url = row.source_url;
        agg.last_ran_at = row.ran_at;
      }
    }

    // Hydrate city name/state/has_hero in chunks.
    const slugs = Array.from(bySlug.keys());
    const chunk = 500;
    for (let i = 0; i < slugs.length; i += chunk) {
      const piece = slugs.slice(i, i + chunk);
      const { data: cities } = await supabaseAdmin
        .from("cities")
        .select("slug,name,state_code,hero_image_url")
        .in("slug", piece);
      for (const c of cities ?? []) {
        const agg = bySlug.get(c.slug);
        if (!agg) continue;
        agg.city_name = c.name;
        agg.state_code = c.state_code;
        agg.has_hero = !!c.hero_image_url;
      }
    }

    const rows = Array.from(bySlug.values()).sort((a, b) => {
      // Failing-first ordering.
      const fa = a.error * 10 + a.miss * 3 + a.skipped;
      const fb = b.error * 10 + b.miss * 3 + b.skipped;
      if (fb !== fa) return fb - fa;
      return (a.city_name ?? a.city_slug).localeCompare(b.city_name ?? b.city_slug);
    });

    const totals = rows.reduce(
      (acc, r) => {
        acc.cities++;
        acc.ok += r.ok; acc.miss += r.miss; acc.skipped += r.skipped; acc.error += r.error;
        if (!r.has_hero) acc.missingHero++;
        if (r.last_status && r.last_status !== "ok") acc.lastFailing++;
        return acc;
      },
      { cities: 0, ok: 0, miss: 0, skipped: 0, error: 0, missingHero: 0, lastFailing: 0 },
    );

    return { rows, totals };
  });
