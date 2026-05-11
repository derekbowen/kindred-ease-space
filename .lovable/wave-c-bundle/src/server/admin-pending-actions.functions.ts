import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

async function requireAdmin(userId: string) {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("Not authorized");
}

export type FailedPage = {
  slug: string;
  url_path: string | null;
  title: string | null;
  status: string | null;
  updated_at: string | null;
  last_error: string | null;
};

/** List pending pages for a template, joined with last_error from content_plan. */
export const listPendingFailures = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ template_type: z.string().min(1), limit: z.number().int().min(1).max(500).default(100) }).parse(d),
  )
  .handler(async ({ context, data }): Promise<FailedPage[]> => {
    const { userId } = context as { userId: string };
    await requireAdmin(userId);

    const { data: pages } = await supabaseAdmin
      .from("content_pages")
      .select("slug, url_path, title, status, updated_at")
      .like("url_path", "/p/%")
      .neq("status", "published")
      .eq("template_type", data.template_type)
      .order("updated_at", { ascending: false })
      .limit(data.limit);

    const slugs = (pages || []).map((p) => p.slug).filter(Boolean) as string[];
    const errMap = new Map<string, string>();
    if (slugs.length > 0) {
      const { data: plan } = await supabaseAdmin
        .from("content_plan")
        .select("slug, last_error")
        .in("slug", slugs);
      for (const r of plan || []) {
        if (r.last_error) errMap.set(r.slug as string, r.last_error as string);
      }
    }
    return (pages || []).map((p: any) => ({
      slug: p.slug,
      url_path: p.url_path,
      title: p.title,
      status: p.status,
      updated_at: p.updated_at,
      last_error: errMap.get(p.slug) ?? null,
    }));
  });

/** Re-queue pending pages for a template by flipping their plan rows back to pending and clearing last_error. */
export const retryPendingTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ template_type: z.string().min(1), limit: z.number().int().min(1).max(1000).default(500) }).parse(d),
  )
  .handler(async ({ context, data }): Promise<{ retried: number; slugs: string[] }> => {
    const { userId } = context as { userId: string };
    await requireAdmin(userId);

    const { data: pages } = await supabaseAdmin
      .from("content_pages")
      .select("slug")
      .like("url_path", "/p/%")
      .neq("status", "published")
      .eq("template_type", data.template_type)
      .limit(data.limit);

    const slugs = (pages || []).map((p) => p.slug).filter(Boolean) as string[];
    if (slugs.length === 0) return { retried: 0, slugs: [] };

    // Reset plan rows so the next batch run picks them up
    const { error } = await supabaseAdmin
      .from("content_plan")
      .update({ status: "pending", last_error: null })
      .in("slug", slugs);
    if (error) throw new Error(error.message);

    return { retried: slugs.length, slugs };
  });

/* ─────────────────────────── Spanish batch ─────────────────────────────── */

function slugify(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const queueSpanishCityBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ count: z.number().int().min(1).max(500).default(100) }).parse(d),
  )
  .handler(async ({ context, data }): Promise<{ inserted: number; skipped: number; sample: string[] }> => {
    const { userId } = context as { userId: string };
    await requireAdmin(userId);

    // 1. Find existing Spanish slugs to skip
    const { data: existing } = await supabaseAdmin
      .from("content_plan")
      .select("city, state_code")
      .eq("source_type", "hosting_es");
    const existingKeys = new Set(
      (existing || [])
        .map((r) => `${(r.city || "").toLowerCase()}|${(r.state_code || "").toUpperCase()}`)
        .filter((k) => k !== "|"),
    );

    // 2. Pick top cities by population from content_plan (cities table has no
    //    population). Use the existing English plan rows as the population source
    //    of truth — each row already has population_2024.
    const { data: candidates } = await supabaseAdmin
      .from("content_plan")
      .select("city, state, state_code, population_2024")
      .eq("source_type", "city")
      .not("city", "is", null)
      .not("state_code", "is", null)
      .order("population_2024", { ascending: false, nullsFirst: false })
      .limit(data.count * 4); // overfetch since we'll filter

    const newRows: Array<Record<string, any>> = [];
    let skipped = 0;
    for (const row of candidates || []) {
      const city = (row.city || "").trim();
      const st = (row.state_code || "").trim().toUpperCase();
      if (!city || !st) continue;
      const key = `${city.toLowerCase()}|${st}`;
      if (existingKeys.has(key)) {
        skipped++;
        continue;
      }
      const citySlug = slugify(city);
      const stateLower = st.toLowerCase();
      newRows.push({
        source_type: "hosting_es",
        priority_tier: "T1 (200k+)",
        priority_score: row.population_2024 ?? 0,
        city,
        state: row.state,
        state_code: st,
        population_2024: row.population_2024,
        slug: `conviertete-en-anfitrion-de-piscina-${citySlug}-${stateLower}`,
        h1: `Conviértete en Anfitrión de Piscina en ${city}, ${st}`,
        meta_title: `Renta Tu Piscina en ${city}, ${st} – Gana $4K-$8K+/Mes`,
        meta_description: `Convierte tu piscina en ${city} en ingresos premium. Seguro de $2M. 90% de ganancias. Soporte en español.`,
        primary_keyword: `renta de alberca ${city}`,
        supporting_keywords: `alquiler de piscina ${city}; anfitrión de piscina ${city} ${st}; piscina privada ${city}`,
        uniqueness_angle: `Página en español para hispanohablantes en ${city}, ${row.state ?? st}.`,
        status: "pending",
      });
      existingKeys.add(key);
      if (newRows.length >= data.count) break;
    }

    if (newRows.length === 0) return { inserted: 0, skipped, sample: [] };

    const { error } = await supabaseAdmin
      .from("content_plan")
      .upsert(newRows as any, { onConflict: "slug", ignoreDuplicates: true });
    if (error) throw new Error(error.message);

    return {
      inserted: newRows.length,
      skipped,
      sample: newRows.slice(0, 5).map((r) => r.slug as string),
    };
  });
