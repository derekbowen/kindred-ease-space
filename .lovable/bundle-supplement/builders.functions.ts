import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { stateName } from "@/lib/states";





export const listBuilderStates = createServerFn({ method: "GET" }).handler(
  async () => {
    const { data, error } = await supabaseAdmin
      .from("providers")
      .select("state_code")
      .eq("is_published", true)
      .not("state_code", "is", null)
      .limit(5000);
    if (error) console.error("listBuilderStates:", error);
    const counts = new Map<string, number>();
    for (const r of data ?? []) {
      const sc = (r as { state_code: string | null }).state_code;
      if (!sc) continue;
      counts.set(sc, (counts.get(sc) ?? 0) + 1);
    }
    return {
      states: Array.from(counts.entries())
        .map(([code, count]) => ({
          code, name: stateName(code), count, slug: code.toLowerCase(),
        }))
        .sort((a, b) => b.count - a.count),
    };
  },
);

export const listAllBuilders = createServerFn({ method: "GET" }).handler(
  async () => {
    const { data, error } = await supabaseAdmin
      .from("providers")
      .select("slug, name, city, city_slug, state_code, rating, rating_count, business_type, logo_url")
      .eq("is_published", true)
      .order("rating", { ascending: false, nullsFirst: false })
      .order("rating_count", { ascending: false, nullsFirst: false })
      .limit(1000);
    if (error) console.error("listAllBuilders:", error);
    return { providers: data ?? [] };
  },
);

export const getBuildersByState = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ state: z.string().regex(/^[a-z]{2}$/) }).parse(d))
  .handler(async ({ data }) => {
    const code = data.state.toUpperCase();
    const { data: providers, error } = await supabaseAdmin
      .from("providers")
      .select("slug, name, city, city_slug, state_code, rating, rating_count, business_type, logo_url, hero_image_url, latitude, longitude")
      .eq("is_published", true)
      .eq("state_code", code)
      .order("rating", { ascending: false, nullsFirst: false })
      .order("rating_count", { ascending: false, nullsFirst: false })
      .limit(500);
    if (error) console.error("getBuildersByState:", error);
    // Aggregate cities for this state
    const cityMap = new Map<string, { city: string; slug: string; count: number }>();
    for (const p of providers ?? []) {
      const row = p as { city: string | null; city_slug: string | null };
      if (!row.city || !row.city_slug) continue;
      const existing = cityMap.get(row.city_slug);
      if (existing) existing.count++;
      else cityMap.set(row.city_slug, { city: row.city, slug: row.city_slug, count: 1 });
    }
    const cities = Array.from(cityMap.values()).sort((a, b) => b.count - a.count);
    return {
      state: { code, name: stateName(code), slug: code.toLowerCase(), count: providers?.length ?? 0 },
      providers: providers ?? [],
      cities,
    };
  });

export const getBuildersByCity = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => z.object({ state: z.string().regex(/^[a-z]{2}$/), city: z.string().regex(/^[a-z0-9-]+$/).max(80) }).parse(d))
  .handler(async ({ data }) => {
    const code = data.state.toUpperCase();
    // city slug as stored is "<city>-<state-lower>" e.g. "charlotte-nc"
    const fullSlug = data.city.endsWith(`-${data.state}`) ? data.city : `${data.city}-${data.state}`;
    const { data: providers, error } = await supabaseAdmin
      .from("providers")
      .select("slug, name, city, city_slug, state_code, rating, rating_count, business_type, address, phone, website_url, logo_url, hero_image_url, latitude, longitude, description")
      .eq("is_published", true)
      .eq("state_code", code)
      .eq("city_slug", fullSlug)
      .order("rating", { ascending: false, nullsFirst: false })
      .order("rating_count", { ascending: false, nullsFirst: false });
    if (error) console.error("getBuildersByCity:", error);
    const cityName = providers?.[0]?.city ?? null;
    return {
      state: { code, name: stateName(code), slug: code.toLowerCase() },
      city: cityName ? { name: cityName as string, slug: fullSlug } : null,
      providers: providers ?? [],
    };
  });

export const submitProviderLead = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({
      name: z.string().trim().min(1).max(120),
      email: z.string().trim().email().max(255),
      phone: z.string().trim().max(40).optional().or(z.literal("")),
      company: z.string().trim().max(160).optional().or(z.literal("")),
      website: z.string().trim().max(300).optional().or(z.literal("")),
      city: z.string().trim().max(120).optional().or(z.literal("")),
      state_code: z.string().trim().max(4).optional().or(z.literal("")),
      message: z.string().trim().max(2000).optional().or(z.literal("")),
      source_provider_slug: z.string().trim().max(120).optional().or(z.literal("")),
      source_path: z.string().trim().max(300).optional().or(z.literal("")),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const blank = (s?: string) => (s && s.trim() ? s.trim() : null);
    const { error } = await supabaseAdmin.from("provider_leads").insert({
      name: data.name.trim(),
      email: data.email.trim().toLowerCase(),
      phone: blank(data.phone),
      company: blank(data.company),
      website: blank(data.website),
      city: blank(data.city),
      state_code: blank(data.state_code)?.toUpperCase() ?? null,
      message: blank(data.message),
      source_provider_slug: blank(data.source_provider_slug),
      source_path: blank(data.source_path),
    });
    if (error) {
      console.error("submitProviderLead:", error);
      return { ok: false as const, error: "Could not submit. Please try again." };
    }
    return { ok: true as const };
  });
