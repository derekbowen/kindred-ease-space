import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAdmin(userId: string) {
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("Forbidden");
}
const sb = () => supabaseAdmin as any;

// ============================================================================
// COMPETITOR RADAR — sitemap diff + auto-scrape new pages
// ============================================================================

export type CompetitorSiteRow = {
  id: string;
  domain: string;
  sitemap_url: string;
  label: string | null;
  is_active: boolean;
  last_checked_at: string | null;
  last_url_count: number;
};

export type CompetitorUrlRow = {
  id: string;
  site_id: string;
  url: string;
  first_seen_at: string;
  last_seen_at: string;
  scraped_at: string | null;
  title: string | null;
  word_count: number | null;
  acknowledged: boolean;
  domain?: string | null;
  kind?: string | null;
  city_slug?: string | null;
  state_code?: string | null;
  summary?: string | null;
};

export const listCompetitorSites = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ rows: CompetitorSiteRow[] }> => {
    await assertAdmin((context as any).userId);
    const { data } = await sb()
      .from("competitor_sites")
      .select("*")
      .order("created_at", { ascending: false });
    return { rows: (data || []) as CompetitorSiteRow[] };
  });

export const addCompetitorSite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      domain: z.string().min(2).max(200),
      sitemap_url: z.string().url(),
      label: z.string().max(120).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const domain = data.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
    const { error } = await sb().from("competitor_sites").insert({
      domain,
      sitemap_url: data.sitemap_url,
      label: data.label ?? null,
    });
    return error ? { ok: false, error: error.message } : { ok: true };
  });

export const deleteCompetitorSite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const { error } = await sb().from("competitor_sites").delete().eq("id", data.id);
    return error ? { ok: false, error: error.message } : { ok: true };
  });

/** Fetch sitemap (and nested sitemap indexes) and return all <loc> URLs. */
async function fetchSitemapUrls(sitemapUrl: string, depth = 0): Promise<string[]> {
  if (depth > 2) return [];
  const res = await fetch(sitemapUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; PoolRentalNearMeBot/1.0; +https://www.poolrentalnearme.com)" } });
  if (!res.ok) throw new Error(`Sitemap fetch ${res.status}`);
  const xml = await res.text();
  const locs = Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)).map((m) => m[1]);
  // If this is a sitemap index, recurse
  if (/<sitemapindex/i.test(xml)) {
    const out: string[] = [];
    for (const child of locs.slice(0, 25)) {
      try {
        const sub = await fetchSitemapUrls(child, depth + 1);
        out.push(...sub);
      } catch { /* skip */ }
    }
    return out;
  }
  return locs;
}

/** Run sitemap diff for one (or all) competitor sites. Returns count of new URLs found. */
export const runCompetitorScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ site_id: z.string().uuid().optional() }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    let q = sb().from("competitor_sites").select("*").eq("is_active", true);
    if (data.site_id) q = q.eq("id", data.site_id);
    const { data: sites } = await q;
    const results: { domain: string; new_count: number; total: number; error?: string }[] = [];

    for (const site of (sites || []) as CompetitorSiteRow[]) {
      try {
        const urls = await fetchSitemapUrls(site.sitemap_url);
        const unique = Array.from(new Set(urls)).slice(0, 10000);
        const now = new Date().toISOString();

        // Get existing URLs for this site
        const { data: existing } = await sb()
          .from("competitor_urls")
          .select("url")
          .eq("site_id", site.id);
        const existingSet = new Set(((existing || []) as { url: string }[]).map((r) => r.url));

        const newOnes = unique.filter((u) => !existingSet.has(u));

        // Upsert (set last_seen_at) + insert new with quick classification
        if (newOnes.length) {
          await sb().from("competitor_urls").insert(
            newOnes.map((url) => {
              const c = quickClassifyUrl(url);
              return {
                site_id: site.id,
                url,
                first_seen_at: now,
                last_seen_at: now,
                kind: c.kind,
                city_slug: c.city_slug,
                state_code: c.state_code,
              };
            }),
          );
        }
        // Touch last_seen_at for existing ones we still saw
        const stillSeen = unique.filter((u) => existingSet.has(u));
        if (stillSeen.length) {
          // Chunk to avoid huge IN clauses
          for (let i = 0; i < stillSeen.length; i += 500) {
            const chunk = stillSeen.slice(i, i + 500);
            await sb().from("competitor_urls")
              .update({ last_seen_at: now })
              .eq("site_id", site.id)
              .in("url", chunk);
          }
        }

        await sb().from("competitor_sites").update({
          last_checked_at: now,
          last_url_count: unique.length,
        }).eq("id", site.id);

        results.push({ domain: site.domain, new_count: newOnes.length, total: unique.length });
      } catch (e: any) {
        results.push({ domain: site.domain, new_count: 0, total: 0, error: e?.message || "scan failed" });
      }
    }
    return { ok: true, results };
  });

export const listNewCompetitorUrls = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      onlyUnacknowledged: z.boolean().default(true),
      limit: z.number().int().min(10).max(500).default(100),
      site_id: z.string().uuid().optional(),
      kind: z.string().optional(),
      excludeListings: z.boolean().default(true),
    }).parse(d ?? {}),
  )
  .handler(async ({ data, context }): Promise<{ rows: CompetitorUrlRow[] }> => {
    await assertAdmin((context as any).userId);
    let q = sb()
      .from("competitor_urls")
      .select("id, site_id, url, first_seen_at, last_seen_at, scraped_at, title, word_count, acknowledged, kind, city_slug, state_code, summary, competitor_sites(domain)")
      .order("first_seen_at", { ascending: false })
      .limit(data.limit);
    if (data.onlyUnacknowledged) q = q.eq("acknowledged", false);
    if (data.site_id) q = q.eq("site_id", data.site_id);
    if (data.kind) q = q.eq("kind", data.kind);
    if (data.excludeListings && !data.kind) q = q.neq("kind", "listing");
    const { data: rows } = await q;
    const flat = (rows || []).map((r: any) => ({
      ...r,
      domain: r.competitor_sites?.domain ?? null,
    }));
    return { rows: flat as CompetitorUrlRow[] };
  });

export const acknowledgeCompetitorUrls = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const { error } = await sb()
      .from("competitor_urls")
      .update({ acknowledged: true })
      .in("id", data.ids);
    return error ? { ok: false, error: error.message } : { ok: true };
  });

/** Scrape a discovered URL with Firecrawl to populate title + word_count. */
export const scrapeCompetitorUrlRow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const { data: row } = await sb()
      .from("competitor_urls")
      .select("id, url")
      .eq("id", data.id)
      .maybeSingle();
    if (!row) return { ok: false, error: "Not found" };
    const fcKey = process.env.FIRECRAWL_API_KEY;
    if (!fcKey) return { ok: false, error: "FIRECRAWL_API_KEY not configured" };
    const resp = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: row.url, formats: ["markdown"], onlyMainContent: true }),
    });
    if (!resp.ok) return { ok: false, error: `Firecrawl ${resp.status}` };
    const json = await resp.json();
    const doc = json?.data || json;
    const md = doc?.markdown || "";
    const meta = doc?.metadata || {};
    const word_count = md.split(/\s+/).filter(Boolean).length;
    await sb().from("competitor_urls").update({
      title: meta.title || meta.ogTitle || null,
      word_count,
      scraped_at: new Date().toISOString(),
    }).eq("id", data.id);
    return { ok: true, word_count };
  });

// ============================================================================
// HOST MATCHER — find real-person/business contact info for competitor listings
// ============================================================================

export type CompetitorHostMatchRow = {
  id: string;
  competitor_url_id: string;
  competitor_url: string;
  domain: string | null;
  host_first_name: string | null;
  host_city: string | null;
  host_state: string | null;
  candidate_name: string | null;
  candidate_business_name: string | null;
  candidate_email: string | null;
  candidate_phone: string | null;
  candidate_website: string | null;
  candidate_social_url: string | null;
  candidate_source: string | null;
  candidate_evidence: string | null;
  match_confidence: number;
  status: string;
  admin_notes: string | null;
  created_at: string;
  enriched_at: string | null;
  enriched_tier: string | null;
  enriched_emails: string[] | null;
  enriched_phones: string[] | null;
  enriched_socials: string[] | null;
  property_address: string | null;
  revenue_signal_score: number | null;
  revenue_signal_notes: string | null;
  enrichment_cost_usd: number | null;
};

export const listHostMatches = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      status: z.enum(["new", "review", "contacted", "converted", "dismissed", "all"]).default("new"),
      minConfidence: z.number().min(0).max(100).default(40),
      limit: z.number().min(1).max(500).default(100),
    }).parse(d ?? {}),
  )
  .handler(async ({ data, context }): Promise<{ rows: CompetitorHostMatchRow[] }> => {
    await assertAdmin((context as any).userId);
    let q = sb().from("competitor_host_matches").select("*")
      .gte("match_confidence", data.minConfidence)
      .order("match_confidence", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.status !== "all") q = q.eq("status", data.status);
    const { data: rows } = await q;
    return { rows: (rows || []) as CompetitorHostMatchRow[] };
  });

export const updateHostMatchStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.string().uuid(),
      status: z.enum(["new", "review", "contacted", "converted", "dismissed"]),
      admin_notes: z.string().max(2000).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const patch: any = { status: data.status };
    if (data.admin_notes !== undefined) patch.admin_notes = data.admin_notes;
    const { error } = await sb().from("competitor_host_matches").update(patch).eq("id", data.id);
    return error ? { ok: false, error: error.message } : { ok: true };
  });

export const runHostMatchOne = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ competitor_url_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const { matchCompetitorUrl } = await import("./host-matcher.server");
    const { runReverseImageMatch } = await import("./reverse-image-host-matcher.server");

    // Run text-based matcher and reverse-image matcher in parallel.
    // Both insert into competitor_host_matches; UI's Host matches tab picks them up.
    const [textRes, imgRes] = await Promise.allSettled([
      matchCompetitorUrl(data.competitor_url_id),
      runReverseImageMatch(data.competitor_url_id),
    ]);

    const text = textRes.status === "fulfilled" ? textRes.value : { ok: false, inserted: 0, reason: (textRes as any).reason?.message };
    const img = imgRes.status === "fulfilled" ? imgRes.value : { ok: false, inserted: 0, reason: (imgRes as any).reason?.message };

    return {
      ok: text.ok || img.ok,
      inserted: (text.inserted || 0) + (img.inserted || 0),
      text_pipeline: text,
      reverse_image_pipeline: img,
    };
  });

export const enrichHostMatchOne = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      match_id: z.string().uuid(),
      force_tier: z.enum(["osint", "batchdata", "pdl"]).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const { enrichHostMatch } = await import("./contact-enricher.server");
    return enrichHostMatch(data.match_id, { force_tier: data.force_tier });
  });

export const getEnrichmentSpend = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin((context as any).userId);
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 7) + "-01";
    const { data: todayRows } = await sb()
      .from("enrichment_spend_log").select("cost_usd, outcome")
      .eq("spend_date", today);
    const { data: monthRows } = await sb()
      .from("enrichment_spend_log").select("cost_usd")
      .gte("spend_date", monthStart);
    const today_total = (todayRows || []).reduce((s: number, r: any) => s + Number(r.cost_usd || 0), 0);
    const month_total = (monthRows || []).reduce((s: number, r: any) => s + Number(r.cost_usd || 0), 0);
    return {
      today_spend_usd: Number(today_total.toFixed(2)),
      today_calls: (todayRows || []).length,
      today_hits: (todayRows || []).filter((r: any) => r.outcome === "hit").length,
      month_spend_usd: Number(month_total.toFixed(2)),
      daily_cap_usd: 10,
      monthly_target_usd: 25,
    };
  });

export const reportFalsePositive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      match_id: z.string().uuid(),
      reason: z.string().max(500).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const userId = (context as any).userId;
    await assertAdmin(userId);
    const { data: m } = await sb()
      .from("competitor_host_matches").select("*").eq("id", data.match_id).maybeSingle();
    if (!m) return { ok: false, error: "match not found" };
    await sb().from("host_match_false_positives").insert({
      match_id: m.id,
      competitor_url: m.competitor_url,
      domain: m.domain,
      candidate_name: m.candidate_name,
      candidate_business_name: m.candidate_business_name,
      candidate_email: m.candidate_email,
      candidate_phone: m.candidate_phone,
      candidate_website: m.candidate_website,
      candidate_source: m.candidate_source,
      host_first_name: m.host_first_name,
      host_city: m.host_city,
      host_state: m.host_state,
      match_confidence: m.match_confidence,
      reason: data.reason || null,
      reported_by: userId,
    });
    await sb().from("competitor_host_matches")
      .update({ status: "dismissed", admin_notes: `[false positive] ${data.reason || ""}`.slice(0, 2000) })
      .eq("id", m.id);
    return { ok: true };
  });

export const runValidatorSelfTests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin((context as any).userId);
    const { runSelfTests } = await import("./lead-validators.server");
    const results = runSelfTests();
    return { results, allPassed: results.every((r) => r.pass) };
  });

// ============================================================================
// SERP RANK TRACKER
// ============================================================================

export type TrackedKeywordRow = {
  id: string;
  keyword: string;
  target_url_path: string | null;
  market: string;
  is_active: boolean;
  last_position: number | null;
  previous_position: number | null;
  last_checked_at: string | null;
};

export const listTrackedKeywords = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ rows: TrackedKeywordRow[] }> => {
    await assertAdmin((context as any).userId);
    const { data } = await sb()
      .from("tracked_keywords")
      .select("*")
      .order("last_position", { ascending: true, nullsFirst: false });
    return { rows: (data || []) as TrackedKeywordRow[] };
  });

export const addTrackedKeyword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      keyword: z.string().min(1).max(200),
      target_url_path: z.string().max(300).optional(),
      market: z.string().max(10).default("us"),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const { error } = await sb().from("tracked_keywords").insert({
      keyword: data.keyword.trim(),
      target_url_path: data.target_url_path || null,
      market: data.market,
    });
    return error ? { ok: false, error: error.message } : { ok: true };
  });

export const deleteTrackedKeyword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const { error } = await sb().from("tracked_keywords").delete().eq("id", data.id);
    return error ? { ok: false, error: error.message } : { ok: true };
  });

/**
 * Check current position of tracked keywords by scraping Google SERP via Firecrawl.
 * Returns the position where poolrentalnearme.com appears (1-100) or null.
 */
export const runSerpCheck = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const serpKey = process.env.SERPAPI_KEY;
    if (!serpKey) return { ok: false, error: "SERPAPI_KEY not configured" };

    let q = sb().from("tracked_keywords").select("*").eq("is_active", true);
    if (data.id) q = q.eq("id", data.id);
    else q = q.order("last_checked_at", { ascending: true, nullsFirst: true }).limit(data.limit);
    const { data: kws } = await q;

    const results: { keyword: string; position: number | null; delta: number | null; error?: string }[] = [];

    for (const kw of (kws || []) as TrackedKeywordRow[]) {
      try {
        const params = new URLSearchParams({
          engine: "google",
          q: kw.keyword,
          gl: kw.market || "us",
          hl: "en",
          num: "100",
          api_key: serpKey,
        });
        const resp = await fetch(`https://serpapi.com/search.json?${params.toString()}`);
        if (!resp.ok) {
          const txt = await resp.text().catch(() => "");
          results.push({ keyword: kw.keyword, position: null, delta: null, error: `serpapi ${resp.status}: ${txt.slice(0, 120)}` });
          continue;
        }
        const json: any = await resp.json();
        const organic: any[] = Array.isArray(json?.organic_results) ? json.organic_results : [];
        let position: number | null = null;
        let urlFound: string | null = null;
        for (const r of organic) {
          const link: string = r?.link || "";
          if (link.includes("poolrentalnearme.com")) {
            position = typeof r?.position === "number" ? r.position : (organic.indexOf(r) + 1);
            urlFound = link;
            break;
          }
        }
        const now = new Date().toISOString();
        await sb().from("serp_rankings").insert({
          keyword_id: kw.id,
          position,
          url_found: urlFound,
          checked_at: now,
        });
        await sb().from("tracked_keywords").update({
          previous_position: kw.last_position,
          last_position: position,
          last_checked_at: now,
        }).eq("id", kw.id);
        const delta = (kw.last_position != null && position != null) ? kw.last_position - position : null;
        results.push({ keyword: kw.keyword, position, delta });
      } catch (e: any) {
        results.push({ keyword: kw.keyword, position: null, delta: null, error: e?.message || String(e) });
      }
    }
    return { ok: true, results };
  });

// ============================================================================
// AI PAGE AUDITOR — score 0-100 vs top competitors
// ============================================================================

export type PageAuditRow = {
  id: string;
  url_path: string;
  score: number | null;
  summary: string | null;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  audited_at: string;
};

function normalizeAuditPath(input: string): string {
  let p = (input || "").trim();
  // Strip protocol+host if user pasted a full URL
  p = p.replace(/^https?:\/\/[^/]+/i, "");
  // Drop query/hash
  p = p.replace(/[?#].*$/, "");
  // Drop trailing slash (except root)
  if (p.length > 1) p = p.replace(/\/+$/, "");
  // Ensure leading slash
  if (!p.startsWith("/")) p = "/" + p;
  return p;
}

export const auditPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ url_path: z.string().min(1).max(300) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const lovKey = process.env.LOVABLE_API_KEY;
    if (!lovKey) return { ok: false, error: "LOVABLE_API_KEY not configured" };

    const path = normalizeAuditPath(data.url_path);
    const slugFromPath = path.replace(/^\/p\//, "");

    // 1. Exact url_path match
    let { data: page } = await sb()
      .from("content_pages")
      .select("url_path, title, seo_description, body_markdown")
      .eq("url_path", path)
      .maybeSingle();

    // 2. Exact slug match
    if (!page && slugFromPath && slugFromPath !== path) {
      const { data: bySlug } = await sb()
        .from("content_pages")
        .select("url_path, title, seo_description, body_markdown")
        .eq("slug", slugFromPath)
        .maybeSingle();
      page = bySlug;
    }

    // 3. legacy_slugs alias match
    if (!page && slugFromPath) {
      const { data: byLegacy } = await sb()
        .from("content_pages")
        .select("url_path, title, seo_description, body_markdown")
        .contains("legacy_slugs", [slugFromPath])
        .maybeSingle();
      page = byLegacy;
    }

    // 4. Fuzzy suggestions
    if (!page) {
      const needle = slugFromPath || path.replace(/^\//, "");
      const { data: similar } = await sb()
        .from("content_pages")
        .select("url_path, title, status")
        .or(`url_path.ilike.%${needle}%,slug.ilike.%${needle}%,title.ilike.%${needle}%`)
        .limit(8);
      return {
        ok: false,
        error: `Page not found for "${path}".`,
        suggestions: (similar || []).map((r: any) => ({ url_path: r.url_path, title: r.title, status: r.status })),
      };
    }

    // Get competitor pages on same topic for context
    const { data: comps } = await sb()
      .from("competitor_pages")
      .select("url, title, word_count, headings")
      .order("word_count", { ascending: false })
      .limit(3);

    const ourBody = (page.body_markdown || "").slice(0, 8000);
    const compSummary = (comps || []).map((c: any) =>
      `- ${c.url} (${c.word_count} words): ${(c.headings || []).slice(0, 8).map((h: any) => h.text).join(" | ")}`,
    ).join("\n") || "No competitor data yet.";

    const prompt = `You are an SEO auditor. Score this page 0-100 vs top-ranking competitors and return STRICT JSON:
{"score": <0-100>, "summary": "<one sentence>", "strengths": ["..."], "weaknesses": ["..."], "recommendations": ["..."]}

Page URL: ${page.url_path}
Title: ${page.title || "(none)"}
Description: ${page.seo_description || "(none)"}
Body (truncated):
${ourBody}

Competitor pages on similar topics:
${compSummary}

Return ONLY JSON, no markdown fences.`;

    const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${lovKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!aiResp.ok) return { ok: false, error: `AI ${aiResp.status}: ${(await aiResp.text()).slice(0, 200)}` };
    const aiJson = await aiResp.json();
    const content: string = aiJson?.choices?.[0]?.message?.content || "";
    const cleaned = content.replace(/```json\s*/i, "").replace(/```\s*$/i, "").trim();
    let parsed: any;
    try { parsed = JSON.parse(cleaned); } catch {
      return { ok: false, error: "AI returned non-JSON", raw: content.slice(0, 300) };
    }

    const { data: row, error } = await sb().from("page_audits").insert({
      url_path: page.url_path || path,
      score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
      summary: String(parsed.summary || "").slice(0, 1000),
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 20) : [],
      weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses.slice(0, 20) : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.slice(0, 20) : [],
    }).select("*").maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, audit: row as PageAuditRow };
  });

export const listRecentAudits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      limit: z.number().int().min(10).max(200).default(50),
      url_path: z.string().max(300).optional(),
    }).parse(d ?? {}),
  )
  .handler(async ({ data, context }): Promise<{ rows: PageAuditRow[] }> => {
    await assertAdmin((context as any).userId);
    let q = sb().from("page_audits").select("*").order("audited_at", { ascending: false }).limit(data.limit);
    if (data.url_path) q = q.eq("url_path", data.url_path);
    const { data: rows } = await q;
    return { rows: (rows || []) as PageAuditRow[] };
  });

// ============================================================================
// COMPETITOR INTEL — classify, city-gap detection, digest, listing-url filter
// ============================================================================

/** Patterns that identify low-signal listing/profile URLs we usually want to skip. */
const LISTING_URL_PATTERNS = [
  /\/pooldetails\//i,
  /\/pool\/\d+/i,
  /\/listings?\/[^/]+\/?$/i,
  /\/l\/[a-z0-9-]{6,}/i,
  /\/space\/[^/]+\/?$/i,
  /\/venue\/[^/]+\/?$/i,
  /\/host\/[^/]+\/?$/i,
  /\/users?\/[^/]+\/?$/i,
];

export function isListingDetailUrl(url: string): boolean {
  return LISTING_URL_PATTERNS.some((rx) => rx.test(url));
}

/** Heuristic classifier — fast, free, no AI call. */
export function quickClassifyUrl(url: string): { kind: string; city_slug: string | null; state_code: string | null } {
  if (isListingDetailUrl(url)) return { kind: "listing", city_slug: null, state_code: null };
  const u = url.toLowerCase();
  if (/\/blog\//.test(u) || /\/article(s)?\//.test(u) || /\/posts?\//.test(u) || /\/guide(s)?\//.test(u)) {
    return { kind: "blog", city_slug: null, state_code: null };
  }
  // City page patterns: /pool-rental-{city}-{state}, /{city}-{state}, /city/{slug}, /location/{slug}
  const cityPatterns = [
    /\/(?:pool-rentals?|pool-party|swimming-pool)-(?:in-|near-)?([a-z][a-z-]+)-([a-z]{2})\/?$/i,
    /\/(?:cities|locations?|city|area)\/([a-z][a-z-]+?)(?:-([a-z]{2}))?\/?$/i,
    /\/([a-z][a-z-]+)-([a-z]{2})\/?$/,
    /\/p\/([a-z][a-z-]+?)(?:-([a-z]{2}))?\/?$/,
  ];
  for (const rx of cityPatterns) {
    const m = u.match(rx);
    if (m) {
      const slug = m[1];
      const state = m[2] || null;
      if (slug.length >= 3 && slug.length <= 60) {
        return { kind: "city_page", city_slug: slug, state_code: state ? state.toUpperCase() : null };
      }
    }
  }
  if (/\/(?:category|categories|tag|topics?)\//.test(u)) {
    return { kind: "category", city_slug: null, state_code: null };
  }
  if (/\/(?:about|pricing|how-it-works|faq|trust|safety|insurance|help)/.test(u)) {
    return { kind: "feature", city_slug: null, state_code: null };
  }
  return { kind: "other", city_slug: null, state_code: null };
}

/** Backfill classification for any rows missing `kind`. Fast — pure heuristic. */
export const classifyCompetitorUrls = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ limit: z.number().int().min(10).max(5000).default(2000), force: z.boolean().default(false) }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    let q = sb().from("competitor_urls").select("id, url, kind").limit(data.limit);
    if (!data.force) q = q.is("kind", null);
    const { data: rows } = await q;
    const list = (rows || []) as { id: string; url: string }[];
    let updated = 0;
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      await Promise.all(chunk.map(async (r) => {
        const c = quickClassifyUrl(r.url);
        const { error } = await sb().from("competitor_urls")
          .update({ kind: c.kind, city_slug: c.city_slug, state_code: c.state_code })
          .eq("id", r.id);
        if (!error) updated += 1;
      }));
    }
    return { ok: true, updated, total: list.length };
  });

/** City-gap detector: cities competitors cover that we don't. */
export type CityGapRow = {
  city_slug: string;
  state_code: string | null;
  competitor_urls: { url: string; domain: string | null }[];
  has_our_page: boolean;
  our_slug: string | null;
};

export const detectCityGaps = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ minCompetitors: z.number().int().min(1).max(5).default(1) }).parse(d ?? {}),
  )
  .handler(async ({ context }): Promise<{ rows: CityGapRow[] }> => {
    await assertAdmin((context as any).userId);
    const { data: cityRows } = await sb()
      .from("competitor_urls")
      .select("url, city_slug, state_code, competitor_sites(domain)")
      .eq("kind", "city_page")
      .not("city_slug", "is", null)
      .limit(5000);
    const grouped = new Map<string, { city_slug: string; state_code: string | null; urls: { url: string; domain: string | null }[] }>();
    for (const r of (cityRows || []) as any[]) {
      const key = `${r.city_slug}|${r.state_code || ""}`;
      if (!grouped.has(key)) grouped.set(key, { city_slug: r.city_slug, state_code: r.state_code, urls: [] });
      grouped.get(key)!.urls.push({ url: r.url, domain: r.competitor_sites?.domain ?? null });
    }
    // Check our content_pages — slug or url_path containing the city slug
    const slugs = Array.from(grouped.keys()).map((k) => k.split("|")[0]);
    const { data: ours } = await sb()
      .from("content_pages")
      .select("slug, url_path")
      .or(slugs.slice(0, 200).map((s) => `slug.ilike.%${s}%,url_path.ilike.%${s}%`).join(","));
    const oursMap = new Map<string, string>();
    for (const o of (ours || []) as any[]) {
      for (const s of slugs) {
        if ((o.slug || "").includes(s) || (o.url_path || "").includes(s)) {
          oursMap.set(s, o.slug || o.url_path);
        }
      }
    }
    const out: CityGapRow[] = Array.from(grouped.values())
      .filter((g) => g.urls.length >= 1)
      .map((g) => ({
        city_slug: g.city_slug,
        state_code: g.state_code,
        competitor_urls: g.urls.slice(0, 5),
        has_our_page: oursMap.has(g.city_slug),
        our_slug: oursMap.get(g.city_slug) || null,
      }))
      .sort((a, b) => {
        if (a.has_our_page !== b.has_our_page) return a.has_our_page ? 1 : -1;
        return b.competitor_urls.length - a.competitor_urls.length;
      })
      .slice(0, 200);
    return { rows: out };
  });

/** Create a content_pages draft for a city the competitors cover. */
export const createCounterPageFromGap = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      city_slug: z.string().min(2).max(80),
      state_code: z.string().length(2).nullable().optional(),
      competitor_url: z.string().url().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const stateSuffix = data.state_code ? `-${data.state_code.toLowerCase()}` : "";
    const slug = `${data.city_slug}${stateSuffix}`;
    const url_path = `/p/${slug}`;
    // Already exists?
    const { data: existing } = await sb()
      .from("content_pages")
      .select("id, url_path")
      .or(`slug.eq.${slug},url_path.eq.${url_path}`)
      .maybeSingle();
    if (existing) return { ok: false, error: "Page already exists", url_path: existing.url_path };
    const cityName = data.city_slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    const stateLabel = data.state_code ? `, ${data.state_code.toUpperCase()}` : "";
    const { data: ins, error } = await sb().from("content_pages").insert({
      slug,
      url_path,
      title: `Pool rental in ${cityName}${stateLabel}`,
      seo_title: `Pool rental ${cityName}${stateLabel} — book hourly swim time`,
      seo_description: `Find heated, private pools to rent by the hour in ${cityName}${stateLabel}. Book a backyard pool for your party, family, or workout — vetted hosts, $2M insurance included.`,
      status: "draft",
      category: "city",
      template_type: "city",
      locale: "en",
      in_sitemap: false,
      source_url: data.competitor_url || null,
    }).select("id, url_path").maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: ins?.id, url_path: ins?.url_path };
  });

/** Generate a competitor intel digest from the last N days of new URLs. */
export const generateCompetitorDigest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ days: z.number().int().min(1).max(30).default(7) }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const since = new Date(Date.now() - data.days * 86400_000).toISOString();
    const { data: rows } = await sb()
      .from("competitor_urls")
      .select("url, kind, city_slug, first_seen_at, competitor_sites(domain)")
      .gte("first_seen_at", since)
      .neq("kind", "listing")
      .limit(1000);
    const list = (rows || []) as any[];
    if (list.length === 0) {
      return { ok: true, digest: "_No new content pages from competitors in the selected window._", count: 0 };
    }
    // Group by domain + kind
    const groups = new Map<string, { domain: string; kind: string; urls: string[] }>();
    for (const r of list) {
      const key = `${r.competitor_sites?.domain || "unknown"}|${r.kind || "other"}`;
      if (!groups.has(key)) groups.set(key, { domain: r.competitor_sites?.domain || "unknown", kind: r.kind || "other", urls: [] });
      groups.get(key)!.urls.push(r.url);
    }
    const summary = Array.from(groups.values())
      .map((g) => `${g.domain} · ${g.kind} (${g.urls.length}): ${g.urls.slice(0, 8).join(", ")}`)
      .join("\n");
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) return { ok: true, digest: `## Last ${data.days} days\n\n\`\`\`\n${summary}\n\`\`\``, count: list.length };
    try {
      const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: "You are a competitive intelligence analyst for a pool-rental marketplace. Be terse, founder-to-founder, no fluff." },
            { role: "user", content: `Summarize what these competitors shipped in the last ${data.days} days. Identify themes (city expansion, new features, content angles), call out which competitor is moving fastest, and end with 2-3 specific actions we should take this week. Markdown, under 250 words.\n\n${summary}` },
          ],
        }),
      });
      const j = await resp.json();
      const md = j?.choices?.[0]?.message?.content || `## Last ${data.days} days\n\n${summary}`;
      return { ok: true, digest: md, count: list.length };
    } catch (e: any) {
      return { ok: true, digest: `## Last ${data.days} days\n\n\`\`\`\n${summary}\n\`\`\``, count: list.length, warning: e?.message };
    }
  });
