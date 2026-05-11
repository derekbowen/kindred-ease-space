import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type ServiceCategory = {
  slug: string;
  name: string;
  plural_name: string;
  icon: string | null;
  hero_image_url: string | null;
  intro_markdown: string | null;
  seo_title: string | null;
  seo_description: string | null;
  sort_order: number;
};

export type DirectoryProvider = {
  slug: string;
  name: string;
  business_type: string | null;
  city: string | null;
  state_code: string | null;
  logo_url: string | null;
  hero_image_url: string | null;
  description: string | null;
  primary_category: string | null;
  secondary_categories: string[];
  is_featured: boolean;
  rating: number | null;
  rating_count: number | null;
};

export const listServiceCategories = createServerFn({ method: "GET" }).handler(async () => {
  const { data } = await supabaseAdmin
    .from("service_categories")
    .select("slug, name, plural_name, icon, hero_image_url, intro_markdown, seo_title, seo_description, sort_order")
    .eq("is_published", true)
    .order("sort_order");
  const cats = (data ?? []) as ServiceCategory[];
  // also fetch counts per category
  const countsRes = await (supabaseAdmin as any).rpc("count_providers_by_category");
  const counts = countsRes?.data ?? null;
  const countMap = new Map<string, number>();
  if (Array.isArray(counts)) for (const r of counts as any[]) countMap.set(r.primary_category, Number(r.n) || 0);
  return { categories: cats.map((c) => ({ ...c, provider_count: countMap.get(c.slug) ?? 0 })) };
});

export const getCategoryWithProviders = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ slug: z.string().min(1) }).parse(d))
  .handler(async ({ data }) => {
    const [{ data: cat }, { data: provs }] = await Promise.all([
      supabaseAdmin.from("service_categories").select("*").eq("slug", data.slug).eq("is_published", true).maybeSingle(),
      supabaseAdmin
        .from("providers")
        .select("slug, name, business_type, city, state_code, logo_url, hero_image_url, description, primary_category, secondary_categories, is_featured, featured_until, listing_paid_until, plan, rating, rating_count")
        .eq("is_published", true)
        .or(`primary_category.eq.${data.slug},secondary_categories.cs.{${data.slug}}`)
        .order("is_featured", { ascending: false })
        .order("rating", { ascending: false, nullsFirst: false })
        .order("name")
        .limit(500),
    ]);
    return {
      category: (cat as ServiceCategory | null) ?? null,
      providers: ((provs as any[]) ?? []) as DirectoryProvider[],
    };
  });

const STATE_NAMES: Record<string, string> = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",DC:"District of Columbia",
};
export const stateName = (code: string) => STATE_NAMES[code.toUpperCase()] ?? code.toUpperCase();

function citySlugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export const getCategoryStateProviders = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ slug: z.string().min(1), state: z.string().length(2) }).parse(d))
  .handler(async ({ data }) => {
    const stateCode = data.state.toUpperCase();
    const [{ data: cat }, { data: rows }] = await Promise.all([
      supabaseAdmin.from("service_categories").select("*").eq("slug", data.slug).eq("is_published", true).maybeSingle(),
      supabaseAdmin
        .from("providers")
        .select("slug, name, business_type, city, city_slug, state_code, logo_url, hero_image_url, description, primary_category, secondary_categories, is_featured, featured_until, listing_paid_until, plan, rating, rating_count")
        .eq("is_published", true)
        .eq("state_code", stateCode)
        .or(`primary_category.eq.${data.slug},secondary_categories.cs.{${data.slug}}`)
        .order("is_featured", { ascending: false })
        .order("rating", { ascending: false, nullsFirst: false })
        .order("name")
        .limit(500),
    ]);
    const provs = (rows ?? []) as any[];
    const cityMap = new Map<string, { name: string; slug: string; count: number }>();
    for (const r of provs) {
      if (!r.city) continue;
      const slug = r.city_slug || citySlugify(r.city);
      const cur = cityMap.get(slug);
      if (cur) cur.count++;
      else cityMap.set(slug, { name: r.city, slug, count: 1 });
    }
    return {
      category: (cat as ServiceCategory | null) ?? null,
      stateCode,
      stateName: stateName(stateCode),
      providers: provs,
      cities: [...cityMap.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    };
  });

export const getCategoryCityProviders = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ slug: z.string().min(1), state: z.string().length(2), city: z.string().min(1) }).parse(d))
  .handler(async ({ data }) => {
    const stateCode = data.state.toUpperCase();
    const citySlug = data.city.toLowerCase();
    const [{ data: cat }, { data: provs }] = await Promise.all([
      supabaseAdmin.from("service_categories").select("*").eq("slug", data.slug).eq("is_published", true).maybeSingle(),
      supabaseAdmin
        .from("providers")
        .select("slug, name, business_type, city, city_slug, state_code, logo_url, hero_image_url, description, primary_category, secondary_categories, is_featured, featured_until, listing_paid_until, plan, rating, rating_count, address, phone, website_url")
        .eq("is_published", true)
        .eq("state_code", stateCode)
        .or(`primary_category.eq.${data.slug},secondary_categories.cs.{${data.slug}}`)
        .order("is_featured", { ascending: false })
        .order("rating", { ascending: false, nullsFirst: false })
        .order("name")
        .limit(500),
    ]);
    const filtered = ((provs ?? []) as any[]).filter((p) => {
      if (p.city_slug) return p.city_slug.toLowerCase() === citySlug;
      if (p.city) return citySlugify(p.city) === citySlug;
      return false;
    });
    const displayCity = filtered[0]?.city || citySlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      category: (cat as ServiceCategory | null) ?? null,
      stateCode,
      stateName: stateName(stateCode),
      citySlug,
      cityName: displayCity,
      providers: filtered,
    };
  });

// All (state, city) combos for a category — used by sitemap and state hubs
export const listCategoryGeoCoverage = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ slug: z.string().min(1) }).parse(d))
  .handler(async ({ data }) => {
    const { data: rows } = await supabaseAdmin
      .from("providers")
      .select("city, city_slug, state_code")
      .eq("is_published", true)
      .or(`primary_category.eq.${data.slug},secondary_categories.cs.{${data.slug}}`)
      .limit(5000);
    const states = new Map<string, Map<string, { name: string; slug: string; count: number }>>();
    for (const r of rows ?? []) {
      if (!r.state_code || !r.city) continue;
      const sc = r.state_code.toUpperCase();
      const slug = r.city_slug || citySlugify(r.city);
      if (!states.has(sc)) states.set(sc, new Map());
      const cm = states.get(sc)!;
      const cur = cm.get(slug);
      if (cur) cur.count++;
      else cm.set(slug, { name: r.city, slug, count: 1 });
    }
    return {
      states: [...states.entries()]
        .map(([code, cm]) => ({
          code,
          name: stateName(code),
          cities: [...cm.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });

const ListProviderInput = z.object({
  name: z.string().min(2).max(120),
  primary_category: z.string().min(2),
  city: z.string().min(2).max(80),
  state_code: z.string().length(2),
  website_url: z.string().url().max(300).optional().or(z.literal("")),
  phone: z.string().max(40).optional().or(z.literal("")),
  email: z.string().email().max(160),
  description: z.string().min(20).max(2000),
  services: z.array(z.string().max(60)).max(20).optional(),
});

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export const submitProviderListing = createServerFn({ method: "POST" })
  .inputValidator((d) => ListProviderInput.parse(d))
  .handler(async ({ data }) => {
    // verify category exists & published
    const { data: cat } = await supabaseAdmin
      .from("service_categories")
      .select("slug")
      .eq("slug", data.primary_category)
      .eq("is_published", true)
      .maybeSingle();
    if (!cat) throw new Error("Invalid category");

    const baseSlug = slugify(`${data.name}-${data.city}-${data.state_code}`);
    let slug = baseSlug;
    // ensure uniqueness
    for (let i = 0; i < 5; i++) {
      const { data: exists } = await supabaseAdmin.from("providers").select("id").eq("slug", slug).maybeSingle();
      if (!exists) break;
      slug = `${baseSlug}-${Math.floor(Math.random() * 9000) + 1000}`;
    }

    const { error } = await supabaseAdmin.from("providers").insert({
      slug,
      name: data.name.trim(),
      business_type: cat.slug,
      primary_category: cat.slug,
      city: data.city.trim(),
      state_code: data.state_code.toUpperCase(),
      website_url: data.website_url || null,
      phone: data.phone || null,
      email: data.email,
      description: data.description.trim(),
      services: data.services ?? [],
      is_published: false,
      submission_status: "pending",
      claim_status: "pending",
      submitter_email: data.email,
    });
    if (error) throw new Error(error.message);
    return { ok: true, slug };
  });

// --- Admin ---
async function requireAdmin(userId: string) {
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
  if (!data) throw new Error("Not authorized");
}

export const adminListPendingProviders = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(10).max(200).default(50),
    status: z.enum(["pending","approved","rejected","all"]).default("all"),
    search: z.string().trim().max(120).default(""),
  }).partial().parse(d ?? {}))
  .handler(async ({ context, data }) => {
    const { userId } = context as { userId: string };
    await requireAdmin(userId);
    const page = data?.page ?? 1;
    const pageSize = data?.pageSize ?? 50;
    const status = data?.status ?? "all";
    const search = (data?.search ?? "").trim();
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let q = supabaseAdmin
      .from("providers")
      .select("id, slug, name, primary_category, city, state_code, email, submitter_email, description, website_url, phone, services, created_at, submission_status, is_published, is_featured, plan, featured_until, listing_paid_until, gsc_impressions, gsc_clicks, gsc_position, ai_content_generated_at, source_type", { count: "exact" })
      .order("submission_status", { ascending: true })
      .order("created_at", { ascending: false })
      .range(from, to);
    if (status !== "all") q = q.eq("submission_status", status);
    if (search) {
      const esc = search.replace(/[%_,]/g, "");
      q = q.or(`name.ilike.%${esc}%,slug.ilike.%${esc}%,city.ilike.%${esc}%,state_code.ilike.%${esc}%,email.ilike.%${esc}%`);
    }
    const { data: rows, count } = await q;
    return { providers: rows ?? [], total: count ?? 0, page, pageSize };
  });

// ============ Scrape competitor directory URL → create provider ============
export const adminScrapeProviderUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({
    url: z.string().url(),
    autoCreate: z.boolean().default(true),
  }).parse(d))
  .handler(async ({ context, data }) => {
    const { userId } = context as { userId: string };
    await requireAdmin(userId);
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not configured");

    const sourceType = guessSourceType(data.url);
    const { data: job } = await supabaseAdmin
      .from("provider_scrape_jobs")
      .insert({ source_url: data.url, source_type: sourceType, status: "running", created_by: userId })
      .select("id")
      .single();
    const jobId = job?.id as string;

    try {
      const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          url: data.url,
          formats: [
            { type: "json", prompt: "Extract EVERY business listing visible on the page (search results, map results, directory pages may contain dozens). Return JSON: { listings: [ { name (string, required), description (string, 1-3 sentences, may be empty), website (string|null), phone (string|null), email (string|null), address (string|null), city (string|null), state_code (2-letter US state, string|null), services (string[]), rating (number|null), rating_count (integer|null), logo_url (string|null), hero_image_url (string|null), gallery_urls (string[]) } ] }. If the page is a single business listing, return one item in the array. Never invent businesses; only include those actually on the page." }
          ],
          onlyMainContent: true,
        }),
      });
      const payload: any = await res.json();
      if (!res.ok || !payload?.success) throw new Error(payload?.error || `Firecrawl ${res.status}`);
      const j = payload.data?.json ?? payload.json ?? {};
      let listings: any[] = Array.isArray(j?.listings) ? j.listings
        : Array.isArray(j?.businesses) ? j.businesses
        : Array.isArray(j?.results) ? j.results
        : (j?.name ? [j] : []);
      listings = listings.filter((l) => l && typeof l.name === "string" && l.name.trim().length > 1);

      const providerIds: string[] = [];
      if (data.autoCreate && listings.length) {
        for (const it of listings) {
          const slug = slugify(`${it.name}-${it.city ?? ""}-${it.state_code ?? ""}`);
          if (!slug) continue;

          // Image enrichment: if we have a website but no images, scrape the site for branding/images
          let logo_url: string | null = it.logo_url ?? null;
          let hero_image_url: string | null = it.hero_image_url ?? null;
          let gallery_urls: string[] = Array.isArray(it.gallery_urls) ? it.gallery_urls.filter(Boolean) : [];
          if (it.website && (!logo_url || !hero_image_url || gallery_urls.length === 0)) {
            try {
              const er = await fetch("https://api.firecrawl.dev/v2/scrape", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({
                  url: it.website,
                  formats: [
                    "branding",
                    { type: "json", prompt: "From this business website, return JSON: { logo_url (string|null, the company logo image URL), hero_image_url (string|null, the main hero/banner photo URL), gallery_urls (string[], up to 6 representative photo URLs of pools, work, or the business — absolute https URLs only). Use absolute URLs from <img src> attributes. No data: URIs, no SVG sprites, no tracking pixels." }
                  ],
                  onlyMainContent: false,
                }),
              });
              const ep: any = await er.json().catch(() => null);
              const ej = ep?.data?.json ?? ep?.json ?? {};
              const branding = ep?.data?.branding ?? ep?.branding ?? {};
              const isHttp = (u: any) => typeof u === "string" && /^https?:\/\//i.test(u) && !/\.svg(\?|$)/i.test(u);
              logo_url = logo_url || (isHttp(ej.logo_url) ? ej.logo_url : null) || (isHttp(branding?.logo) ? branding.logo : null) || (isHttp(branding?.images?.logo) ? branding.images.logo : null);
              hero_image_url = hero_image_url || (isHttp(ej.hero_image_url) ? ej.hero_image_url : null) || (isHttp(branding?.images?.ogImage) ? branding.images.ogImage : null);
              const extra = Array.isArray(ej.gallery_urls) ? ej.gallery_urls.filter(isHttp) : [];
              gallery_urls = Array.from(new Set([...gallery_urls, ...extra])).slice(0, 8);
            } catch {/* image enrichment is best-effort */}
          }

          const upsert = await supabaseAdmin
            .from("providers")
            .upsert({
              slug,
              name: it.name,
              description: it.description ?? null,
              website_url: it.website ?? null,
              phone: it.phone ?? null,
              email: it.email ?? null,
              address: it.address ?? null,
              city: it.city ?? null,
              state_code: it.state_code ?? null,
              services: Array.isArray(it.services) ? it.services : [],
              rating: typeof it.rating === "number" ? it.rating : null,
              rating_count: typeof it.rating_count === "number" ? it.rating_count : null,
              logo_url,
              hero_image_url,
              gallery_urls,
              source_url: data.url,
              source_type: sourceType,
              scraped_at: new Date().toISOString(),
              submission_status: "pending",
              is_published: false,
            }, { onConflict: "slug" })
            .select("id")
            .single();
          const id = (upsert.data as any)?.id;
          if (id) providerIds.push(id);
        }
      }

      await supabaseAdmin.from("provider_scrape_jobs").update({
        status: "success", provider_id: providerIds[0] ?? null, raw: { count: listings.length, listings },
      }).eq("id", jobId);

      return { ok: true, jobId, providerId: providerIds[0] ?? null, providerIds, count: providerIds.length, extracted: listings };
    } catch (e: any) {
      await supabaseAdmin.from("provider_scrape_jobs").update({
        status: "failed", error: String(e?.message ?? e),
      }).eq("id", jobId);
      throw e;
    }
  });

export const adminListScrapeJobs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin((context as any).userId);
    const { data } = await supabaseAdmin
      .from("provider_scrape_jobs")
      .select("id, source_url, source_type, status, provider_id, error, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    return { jobs: data ?? [] };
  });

// ============ GSC import (CSV upload from user) ============
export const adminImportGscRows = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({
    rows: z.array(z.object({
      slug: z.string(),
      impressions: z.number().int().nonnegative(),
      clicks: z.number().int().nonnegative(),
      position: z.number().nullable().optional(),
      kind: z.enum(["provider", "page"]).optional(),
    })).max(5000),
  }).parse(d))
  .handler(async ({ context, data }) => {
    await requireAdmin((context as any).userId);
    const now = new Date().toISOString();
    let updated = 0;
    for (const r of data.rows) {
      const kind = r.kind ?? "provider";
      const table = kind === "page" ? "content_pages" : "providers";
      const matchCol = kind === "page" ? "url_path" : "slug";
      const matchVal = kind === "page" ? `/p/${r.slug.replace(/^\/+/, "")}` : r.slug;
      const { error, count } = await (supabaseAdmin as any)
        .from(table)
        .update({
          gsc_impressions: r.impressions,
          gsc_clicks: r.clicks,
          gsc_position: r.position ?? null,
          gsc_updated_at: now,
        }, { count: "exact" })
        .eq(matchCol, matchVal);
      if (!error && (count ?? 0) > 0) updated += 1;
    }
    return { ok: true, updated, total: data.rows.length };
  });

// ============ AI long-form content backfill ============
export const adminGenerateProviderContent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    await requireAdmin((context as any).userId);
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY is not configured");
    const { data: p } = await supabaseAdmin
      .from("providers")
      .select("id, name, city, state_code, primary_category, description, services, website_url")
      .eq("id", data.id)
      .single();
    if (!p) throw new Error("Provider not found");

    const sys = "You write SEO-optimized, factual long-form content for a pool services directory. Use second person, friendly founder-mentor tone. No banned words: leverage, utilize, seamlessly, robust, dive into, elevate, game-changer, unlock, journey, landscape, bustling, thriving, vibrant, state-of-the-art, cutting-edge. No em dashes. Output valid JSON only.";
    const user = `Write content for ${p.name}${p.city ? ` in ${p.city}, ${p.state_code}` : ""}. Category: ${p.primary_category ?? "pool services"}. Services: ${(p.services ?? []).join(", ") || "general pool services"}. Existing description: ${p.description ?? "(none)"}.

Return JSON with shape: { "long_description": string (700-900 words, markdown, no headings above h3), "faq": Array<{question: string, answer: string}> (5 items, locally relevant) }.`;

    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
        response_format: { type: "json_object" },
      }),
    });
    if (!r.ok) throw new Error(`AI gateway ${r.status}: ${await r.text()}`);
    const j: any = await r.json();
    const content = JSON.parse(j.choices?.[0]?.message?.content ?? "{}");
    await supabaseAdmin.from("providers").update({
      long_description: content.long_description ?? null,
      faq: Array.isArray(content.faq) ? content.faq : [],
      ai_content_generated_at: new Date().toISOString(),
    }).eq("id", data.id);
    return { ok: true };
  });

export const adminListProvidersMissingAI = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ limit: z.number().int().min(1).max(100).default(10) }).parse(d))
  .handler(async ({ context, data }) => {
    await requireAdmin((context as any).userId);
    const { data: rows, error } = await supabaseAdmin
      .from("providers")
      .select("id, name, slug, city, state_code")
      .eq("is_published", true)
      .is("long_description", null)
      .order("updated_at", { ascending: true })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    return { providers: rows ?? [] };
  });

export const adminBulkGenerateProviderContent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ limit: z.number().int().min(1).max(50).default(10), onlyMissing: z.boolean().default(true) }).parse(d))
  .handler(async ({ context, data }) => {
    await requireAdmin((context as any).userId);
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY is not configured");

    let q = supabaseAdmin
      .from("providers")
      .select("id, name, city, state_code, primary_category, description, services")
      .eq("is_published", true)
      .order("updated_at", { ascending: true })
      .limit(data.limit);
    if (data.onlyMissing) q = q.is("long_description", null);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const p of rows ?? []) {
      try {
        const sys = "You write SEO-optimized, factual long-form content for a pool services directory. Use second person, friendly founder-mentor tone. No banned words: leverage, utilize, seamlessly, robust, dive into, elevate, game-changer, unlock, journey, landscape, bustling, thriving, vibrant, state-of-the-art, cutting-edge. No em dashes. Output valid JSON only.";
        const user = `Write content for ${p.name}${p.city ? ` in ${p.city}, ${p.state_code}` : ""}. Category: ${p.primary_category ?? "pool services"}. Services: ${(p.services ?? []).join(", ") || "general pool services"}. Existing description: ${p.description ?? "(none)"}.\n\nReturn JSON: { "long_description": string (700-900 words, markdown, no headings above h3), "faq": Array<{question:string,answer:string}> (5 items) }.`;
        const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [{ role: "system", content: sys }, { role: "user", content: user }],
            response_format: { type: "json_object" },
          }),
        });
        if (r.status === 429) { results.push({ id: p.id, ok: false, error: "rate limited" }); await new Promise(rs => setTimeout(rs, 3000)); continue; }
        if (r.status === 402) throw new Error("AI credits exhausted");
        if (!r.ok) { results.push({ id: p.id, ok: false, error: `gateway ${r.status}` }); continue; }
        const j: any = await r.json();
        const content = JSON.parse(j.choices?.[0]?.message?.content ?? "{}");
        await supabaseAdmin.from("providers").update({
          long_description: content.long_description ?? null,
          faq: Array.isArray(content.faq) ? content.faq : [],
          ai_content_generated_at: new Date().toISOString(),
        }).eq("id", p.id);
        results.push({ id: p.id, ok: true });
      } catch (e: any) {
        results.push({ id: p.id, ok: false, error: e?.message || String(e) });
      }
      await new Promise(rs => setTimeout(rs, 800));
    }
    return { ok: true, attempted: results.length, succeeded: results.filter(r => r.ok).length, results };
  });

function guessSourceType(url: string): string {
  const h = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (h.includes("yelp")) return "yelp";
  if (h.includes("google")) return "google";
  if (h.includes("bbb.org")) return "bbb";
  if (h.includes("angi") || h.includes("angieslist")) return "angi";
  if (h.includes("houzz")) return "houzz";
  if (h.includes("thumbtack")) return "thumbtack";
  return "web";
}


export const adminUpdateProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        action: z.enum([
          "approve", "reject", "publish", "unpublish",
          "feature", "unfeature",
          "mark_paid", "mark_unpaid",
          "delete",
        ]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context as { userId: string };
    await requireAdmin(userId);
    const sb = supabaseAdmin;
    if (data.action === "delete") {
      const { error } = await sb.from("providers").delete().eq("id", data.id);
      if (error) throw new Error(error.message);
      return { ok: true };
    }
    const patch: Record<string, unknown> = {};
    const inOneYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    if (data.action === "approve") {
      patch.submission_status = "approved";
      patch.is_published = true;
    }
    if (data.action === "reject") {
      patch.submission_status = "rejected";
      patch.is_published = false;
    }
    if (data.action === "publish") patch.is_published = true;
    if (data.action === "unpublish") patch.is_published = false;
    if (data.action === "feature") {
      patch.is_featured = true;
      patch.featured_until = inOneYear;
      patch.plan = "featured";
      // featured implies a paid listing too
      patch.listing_paid_until = inOneYear;
    }
    if (data.action === "unfeature") {
      patch.is_featured = false;
      patch.featured_until = null;
      // downgrade plan back to paid if still within paid window, else free
      const { data: row } = await sb.from("providers").select("listing_paid_until").eq("id", data.id).maybeSingle();
      const paidUntil = (row as any)?.listing_paid_until ? new Date((row as any).listing_paid_until).getTime() : 0;
      patch.plan = paidUntil > Date.now() ? "paid" : "free";
    }
    if (data.action === "mark_paid") {
      patch.listing_paid_until = inOneYear;
      patch.plan = "paid";
      patch.is_published = true;
    }
    if (data.action === "mark_unpaid") {
      patch.listing_paid_until = null;
      patch.plan = "free";
      patch.is_featured = false;
      patch.featured_until = null;
    }
    const { error } = await (sb.from("providers") as any).update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ============= Provider Claims =============

const SubmitClaimInput = z.object({
  provider_slug: z.string().min(1).max(120),
  claimer_name: z.string().min(2).max(120),
  claimer_email: z.string().email().max(160),
  claimer_phone: z.string().max(40).optional().or(z.literal("")),
  claimer_role: z.string().max(80).optional().or(z.literal("")),
  business_email: z.string().email().max(160).optional().or(z.literal("")),
  business_phone: z.string().max(40).optional().or(z.literal("")),
  business_website: z.string().url().max(300).optional().or(z.literal("")),
  verification_notes: z.string().max(2000).optional().or(z.literal("")),
  proposed_name: z.string().max(120).optional().or(z.literal("")),
  proposed_description: z.string().max(3000).optional().or(z.literal("")),
  proposed_address: z.string().max(300).optional().or(z.literal("")),
  proposed_services: z.array(z.string().max(60)).max(20).optional(),
  source_path: z.string().max(300).optional().or(z.literal("")),
});

export const submitProviderClaim = createServerFn({ method: "POST" })
  .inputValidator((d) => SubmitClaimInput.parse(d))
  .handler(async ({ data }) => {
    const { data: prov } = await supabaseAdmin
      .from("providers")
      .select("id, slug, claim_status")
      .eq("slug", data.provider_slug)
      .maybeSingle();
    if (!prov) throw new Error("Listing not found");
    if (prov.claim_status === "claimed") {
      throw new Error("This listing has already been claimed.");
    }

    const proposed: Record<string, unknown> = {};
    if (data.proposed_name) proposed.name = data.proposed_name;
    if (data.proposed_description) proposed.description = data.proposed_description;
    if (data.proposed_address) proposed.address = data.proposed_address;
    if (data.proposed_services?.length) proposed.services = data.proposed_services;
    if (data.business_email) proposed.email = data.business_email;
    if (data.business_phone) proposed.phone = data.business_phone;
    if (data.business_website) proposed.website_url = data.business_website;

    const { error } = await supabaseAdmin.from("provider_claims").insert({
      provider_id: prov.id,
      provider_slug: prov.slug,
      claimer_name: data.claimer_name.trim(),
      claimer_email: data.claimer_email,
      claimer_phone: data.claimer_phone || null,
      claimer_role: data.claimer_role || null,
      business_email: data.business_email || null,
      business_phone: data.business_phone || null,
      business_website: data.business_website || null,
      verification_notes: data.verification_notes || null,
      proposed_updates: proposed as any,
      source_path: data.source_path || null,
    });
    if (error) throw new Error(error.message);

    // Mark provider claim_status as pending if currently unclaimed
    if (prov.claim_status === "unclaimed") {
      await (supabaseAdmin.from("providers") as any)
        .update({ claim_status: "pending" })
        .eq("id", prov.id);
    }
    return { ok: true };
  });

export const adminListProviderClaims = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context as { userId: string };
    await requireAdmin(userId);
    const { data } = await supabaseAdmin
      .from("provider_claims")
      .select("*")
      .order("status", { ascending: true })
      .order("created_at", { ascending: false })
      .limit(200);
    return { claims: data ?? [] };
  });

export const adminReviewProviderClaim = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        action: z.enum(["approve", "reject", "delete"]),
        admin_notes: z.string().max(2000).optional(),
        apply_proposed: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context as { userId: string };
    await requireAdmin(userId);

    const { data: claim } = await supabaseAdmin
      .from("provider_claims")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (!claim) throw new Error("Claim not found");

    if (data.action === "delete") {
      const { error } = await supabaseAdmin.from("provider_claims").delete().eq("id", data.id);
      if (error) throw new Error(error.message);
      return { ok: true };
    }

    const newStatus = data.action === "approve" ? "approved" : "rejected";
    const { error: updErr } = await (supabaseAdmin.from("provider_claims") as any)
      .update({
        status: newStatus,
        admin_notes: data.admin_notes ?? null,
        reviewed_at: new Date().toISOString(),
        reviewed_by: userId,
      })
      .eq("id", data.id);
    if (updErr) throw new Error(updErr.message);

    if (data.action === "approve") {
      const patch: Record<string, unknown> = {
        claim_status: "claimed",
        claimed_at: new Date().toISOString(),
      };
      if (data.apply_proposed && claim.proposed_updates && typeof claim.proposed_updates === "object") {
        Object.assign(patch, claim.proposed_updates as Record<string, unknown>);
      }
      const { error: provErr } = await (supabaseAdmin.from("providers") as any)
        .update(patch)
        .eq("id", claim.provider_id);
      if (provErr) throw new Error(provErr.message);
    } else if (data.action === "reject") {
      // If no other pending claims, reset provider claim_status to unclaimed
      const { count } = await (supabaseAdmin as any)
        .from("provider_claims")
        .select("id", { count: "exact", head: true })
        .eq("provider_id", claim.provider_id)
        .eq("status", "pending");
      if (!count) {
        await (supabaseAdmin.from("providers") as any)
          .update({ claim_status: "unclaimed" })
          .eq("id", claim.provider_id)
          .eq("claim_status", "pending");
      }
    }

    return { ok: true };
  });

// ============= Provider Plan / Payment Requests =============

const SubmitPlanInput = z.object({
  provider_slug: z.string().min(1).max(120),
  requester_name: z.string().min(2).max(120),
  requester_email: z.string().email().max(160),
  requester_phone: z.string().max(40).optional().or(z.literal("")),
  requested_plan: z.enum(["paid", "featured"]),
  payment_method: z.string().max(80).optional().or(z.literal("")),
  payment_reference: z.string().max(200).optional().or(z.literal("")),
  amount_usd: z.number().nonnegative().optional(),
  notes: z.string().max(2000).optional().or(z.literal("")),
  source_path: z.string().max(300).optional().or(z.literal("")),
});

export const submitProviderPlanRequest = createServerFn({ method: "POST" })
  .inputValidator((d) => SubmitPlanInput.parse(d))
  .handler(async ({ data }) => {
    const { data: prov } = await supabaseAdmin
      .from("providers")
      .select("id, slug")
      .eq("slug", data.provider_slug)
      .maybeSingle();
    if (!prov) throw new Error("Listing not found");

    const { error } = await supabaseAdmin.from("provider_plan_requests" as any).insert({
      provider_id: prov.id,
      provider_slug: prov.slug,
      requester_name: data.requester_name.trim(),
      requester_email: data.requester_email,
      requester_phone: data.requester_phone || null,
      requested_plan: data.requested_plan,
      payment_method: data.payment_method || null,
      payment_reference: data.payment_reference || null,
      amount_usd: data.amount_usd ?? (data.requested_plan === "featured" ? 25 : 5),
      notes: data.notes || null,
      source_path: data.source_path || null,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getProviderStatus = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ slug: z.string().min(1).max(120), email: z.string().email().max(160).optional() }).parse(d))
  .handler(async ({ data }) => {
    const { data: prov } = await supabaseAdmin
      .from("providers")
      .select("id, slug, name, city, state_code, primary_category, is_published, is_featured, plan, claim_status, submission_status, listing_paid_until, featured_until, claimed_at")
      .eq("slug", data.slug)
      .maybeSingle();
    if (!prov) return { provider: null, claims: [], plan_requests: [] };

    const filterEmail = data.email?.toLowerCase();
    const [{ data: claims }, { data: reqs }] = await Promise.all([
      supabaseAdmin
        .from("provider_claims")
        .select("id, status, claimer_name, claimer_email, created_at, reviewed_at, admin_notes")
        .eq("provider_id", prov.id)
        .order("created_at", { ascending: false })
        .limit(20),
      (supabaseAdmin as any)
        .from("provider_plan_requests")
        .select("id, status, requested_plan, amount_usd, payment_method, payment_reference, requester_email, created_at, reviewed_at, admin_notes")
        .eq("provider_id", prov.id)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);
    const filterFn = (r: any) => !filterEmail || (r.claimer_email || r.requester_email || "").toLowerCase() === filterEmail;
    return {
      provider: prov,
      claims: ((claims as any[]) ?? []).filter(filterFn),
      plan_requests: ((reqs as any[]) ?? []).filter(filterFn),
    };
  });

export const adminListPlanRequests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId } = context as { userId: string };
    await requireAdmin(userId);
    const { data } = await (supabaseAdmin as any)
      .from("provider_plan_requests")
      .select("*")
      .order("status", { ascending: true })
      .order("created_at", { ascending: false })
      .limit(200);
    return { requests: data ?? [] };
  });

export const adminReviewPlanRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      id: z.string().uuid(),
      action: z.enum(["approve", "reject", "delete"]),
      admin_notes: z.string().max(2000).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context as { userId: string };
    await requireAdmin(userId);
    const sb = supabaseAdmin as any;

    const { data: req } = await sb.from("provider_plan_requests").select("*").eq("id", data.id).maybeSingle();
    if (!req) throw new Error("Request not found");

    if (data.action === "delete") {
      const { error } = await sb.from("provider_plan_requests").delete().eq("id", data.id);
      if (error) throw new Error(error.message);
      return { ok: true };
    }

    const newStatus = data.action === "approve" ? "approved" : "rejected";
    const { error: updErr } = await sb.from("provider_plan_requests")
      .update({
        status: newStatus,
        admin_notes: data.admin_notes ?? null,
        reviewed_at: new Date().toISOString(),
        reviewed_by: userId,
      })
      .eq("id", data.id);
    if (updErr) throw new Error(updErr.message);

    if (data.action === "approve") {
      const inOneYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      const patch: Record<string, unknown> = {
        is_published: true,
        listing_paid_until: inOneYear,
        plan: req.requested_plan,
      };
      if (req.requested_plan === "featured") {
        patch.is_featured = true;
        patch.featured_until = inOneYear;
      }
      const { error: provErr } = await (supabaseAdmin.from("providers") as any)
        .update(patch)
        .eq("id", req.provider_id);
      if (provErr) throw new Error(provErr.message);
    }
    return { ok: true };
  });
