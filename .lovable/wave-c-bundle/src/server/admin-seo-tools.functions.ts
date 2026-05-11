import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

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
// 1. KEYWORD OPPORTUNITY FINDER
// ============================================================================

export type KeywordRow = {
  id: string;
  url_path: string;
  query: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  captured_at: string;
};

/** Import GSC query-level CSV (Page, Query, Clicks, Impressions, CTR, Position). */
export const importGscQueries = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      rows: z.array(z.object({
        url_path: z.string().min(1),
        query: z.string().min(1).max(300),
        clicks: z.number().int().min(0).default(0),
        impressions: z.number().int().min(0).default(0),
        ctr: z.number().nullable().optional(),
        position: z.number().nullable().optional(),
      })).min(1).max(5000),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const captured_at = new Date().toISOString();
    const payload = data.rows.map((r) => ({
      ...r,
      ctr: r.ctr ?? null,
      position: r.position ?? null,
      captured_at,
    }));
    const { error, count } = await sb()
      .from("gsc_query_data")
      .upsert(payload, { onConflict: "url_path,query", count: "exact" });
    if (error) return { ok: false, error: error.message, total: data.rows.length };
    return { ok: true, total: data.rows.length, upserted: count ?? data.rows.length };
  });

/** Find keyword opportunities — queries where we rank position 5-20 with real impressions. */
export const findKeywordOpportunities = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      minPosition: z.number().min(1).max(100).default(5),
      maxPosition: z.number().min(1).max(100).default(20),
      minImpressions: z.number().int().min(0).default(50),
      limit: z.number().int().min(10).max(500).default(100),
      pathLike: z.string().max(200).default(""),
    }).parse(d ?? {}),
  )
  .handler(async ({ data, context }): Promise<{ rows: KeywordRow[]; total: number }> => {
    await assertAdmin((context as any).userId);
    let q = sb()
      .from("gsc_query_data")
      .select("*", { count: "exact" })
      .gte("position", data.minPosition)
      .lte("position", data.maxPosition)
      .gte("impressions", data.minImpressions)
      .order("impressions", { ascending: false })
      .limit(data.limit);
    if (data.pathLike) q = q.ilike("url_path", `%${data.pathLike}%`);
    const { data: rows, count } = await q;
    return { rows: (rows || []) as KeywordRow[], total: count || 0 };
  });

export const getKeywordStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin((context as any).userId);
    const [{ count: totalQueries }, { count: opportunities }, { count: top3 }] = await Promise.all([
      sb().from("gsc_query_data").select("*", { count: "exact", head: true }),
      sb().from("gsc_query_data").select("*", { count: "exact", head: true })
        .gte("position", 5).lte("position", 20).gte("impressions", 50),
      sb().from("gsc_query_data").select("*", { count: "exact", head: true })
        .lte("position", 3),
    ]);
    return {
      totalQueries: totalQueries || 0,
      opportunities: opportunities || 0,
      top3: top3 || 0,
    };
  });

// ============================================================================
// 2. COMPETITOR TRACKER
// ============================================================================

export type CompetitorRow = {
  id: string;
  url: string;
  domain: string | null;
  title: string | null;
  meta_description: string | null;
  h1: string | null;
  word_count: number;
  notes: string | null;
  last_scraped_at: string | null;
  updated_at: string;
};

export const listCompetitorPages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      q: z.string().max(200).default(""),
      limit: z.number().int().min(10).max(500).default(100),
    }).parse(d ?? {}),
  )
  .handler(async ({ data, context }): Promise<{ rows: CompetitorRow[] }> => {
    await assertAdmin((context as any).userId);
    let q = sb()
      .from("competitor_pages")
      .select("id, url, domain, title, meta_description, h1, word_count, notes, last_scraped_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(data.limit);
    if (data.q) q = q.or(`url.ilike.%${data.q}%,title.ilike.%${data.q}%,domain.ilike.%${data.q}%`);
    const { data: rows } = await q;
    return { rows: (rows || []) as CompetitorRow[] };
  });

export const scrapeCompetitorUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      url: z.string().url(),
      notes: z.string().max(1000).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const fcKey = process.env.FIRECRAWL_API_KEY;
    if (!fcKey) return { ok: false, error: "FIRECRAWL_API_KEY not configured" };

    // Sharetribe (poolrentalnearme.com /l/, swimply.com/pooldetails, peerspace, giggster)
    // are JS-rendered SPAs — Firecrawl returns empty markdown without waiting.
    let isSpa = false;
    try {
      const h = new URL(data.url).hostname.replace(/^www\./, "");
      isSpa = /poolrentalnearme\.com|swimply\.com|peerspace\.com|giggster\.com/.test(h);
    } catch { /* noop */ }

    const resp = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: data.url,
        formats: ["markdown"],
        onlyMainContent: !isSpa, // SPAs need full DOM, main-content extraction strips listing details
        waitFor: isSpa ? 4000 : 0,
      }),
    });
    if (resp.status === 402) return { ok: false, error: "Firecrawl credits exhausted" };
    if (!resp.ok) return { ok: false, error: `Firecrawl ${resp.status}: ${(await resp.text()).slice(0, 200)}` };
    const json = await resp.json();
    const doc = json?.data || json;
    const markdown: string = doc?.markdown || "";
    const meta = doc?.metadata || {};
    if (!markdown || markdown.trim().length < 50) {
      return { ok: false, error: `Scrape returned ${markdown.length} chars. Page may block bots or render entirely client-side. Try a different URL.` };
    }
    let domain: string | null = null;
    try { domain = new URL(data.url).hostname.replace(/^www\./, ""); } catch { /* noop */ }
    const h1Match = markdown.match(/^#\s+(.+)$/m);
    const headings = Array.from(markdown.matchAll(/^(#{1,3})\s+(.+)$/gm)).slice(0, 50).map((m) => ({
      level: m[1].length,
      text: m[2].trim(),
    }));
    const word_count = markdown.split(/\s+/).filter(Boolean).length;

    const { data: row, error } = await sb()
      .from("competitor_pages")
      .upsert({
        url: data.url,
        domain,
        title: meta.title || meta.ogTitle || null,
        meta_description: meta.description || meta.ogDescription || null,
        h1: h1Match ? h1Match[1].trim() : null,
        word_count,
        headings,
        markdown: markdown.slice(0, 50000),
        notes: data.notes ?? null,
        last_scraped_at: new Date().toISOString(),
      }, { onConflict: "url" })
      .select("id, url, word_count")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: row?.id, word_count: row?.word_count };
  });

export const compareCompetitorToPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      competitor_id: z.string().uuid(),
      our_url_path: z.string().min(1),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const [{ data: comp }, { data: ours }] = await Promise.all([
      sb().from("competitor_pages").select("url, title, h1, word_count, headings, markdown").eq("id", data.competitor_id).maybeSingle(),
      sb().from("content_pages").select("url_path, title, body_markdown").eq("url_path", data.our_url_path).maybeSingle(),
    ]);
    if (!comp) return { ok: false, error: "Competitor page not found" };
    if (!ours) return { ok: false, error: "Our page not found" };
    const ourWords = (ours.body_markdown || "").split(/\s+/).filter(Boolean).length;
    const ourHeadings = Array.from((ours.body_markdown || "").matchAll(/^(#{1,3})\s+(.+)$/gm))
      .map((m) => (m as RegExpMatchArray)[2].trim().toLowerCase());
    const compHeadings = (comp.headings || []) as Array<{ level: number; text: string }>;
    const missing = compHeadings.filter((h) => !ourHeadings.includes(h.text.toLowerCase()));
    return {
      ok: true,
      our: { url_path: ours.url_path, title: ours.title, word_count: ourWords, headings: ourHeadings.length },
      competitor: { url: comp.url, title: comp.title, word_count: comp.word_count, headings: compHeadings.length },
      word_gap: comp.word_count - ourWords,
      missing_sections: missing.slice(0, 30),
    };
  });

export const deleteCompetitor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const { error } = await sb().from("competitor_pages").delete().eq("id", data.id);
    return error ? { ok: false, error: error.message } : { ok: true };
  });

// ============================================================================
// 3. INTERNAL LINK RECOMMENDER
// ============================================================================

export type LinkSuggestionRow = {
  id: string;
  from_url: string;
  to_url: string;
  anchor_text: string | null;
  score: number;
  reason: string | null;
  status: string;
  created_at: string;
};

const STOP = new Set([
  "the","a","an","and","or","of","in","to","for","with","on","at","by","from","is","are","was","were",
  "be","been","being","this","that","these","those","it","its","as","but","if","then","than","so","you",
  "your","i","we","our","they","them","their","he","she","his","her","not","no","yes","do","does","did",
  "have","has","had","will","would","can","could","should","may","might","just","also","very","more","most",
  "all","any","some","one","two","three","up","down","out","into","over","under","about","near","there","here"
]);

function tokenize(text: string): Set<string> {
  return new Set(
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Build internal link suggestions by topic overlap across published /p/ pages. */
export const generateLinkSuggestions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      sampleSize: z.number().int().min(20).max(2000).default(500),
      minScore: z.number().min(0.05).max(1).default(0.18),
      perPage: z.number().int().min(1).max(20).default(5),
    }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const { data: pages } = await sb()
      .from("content_pages")
      .select("url_path, title, body_markdown")
      .eq("status", "published")
      .like("url_path", "/p/%")
      .order("updated_at", { ascending: false })
      .limit(data.sampleSize);
    if (!pages?.length) return { ok: false, error: "No pages to analyze" };

    const tokenized = (pages as any[]).map((p) => ({
      url: p.url_path as string,
      title: p.title as string | null,
      body: p.body_markdown as string,
      tokens: tokenize(`${p.title || ""} ${(p.body_markdown || "").slice(0, 4000)}`),
    }));

    const suggestions: { from_url: string; to_url: string; anchor_text: string | null; score: number; reason: string }[] = [];
    for (let i = 0; i < tokenized.length; i++) {
      const a = tokenized[i];
      const candidates: { to_url: string; anchor_text: string | null; score: number }[] = [];
      for (let j = 0; j < tokenized.length; j++) {
        if (i === j) continue;
        const b = tokenized[j];
        const score = jaccard(a.tokens, b.tokens);
        if (score < data.minScore) continue;
        // Skip if `a` already links to `b`
        if (a.body && a.body.includes(b.url)) continue;
        candidates.push({ to_url: b.url, anchor_text: b.title, score });
      }
      candidates.sort((x, y) => y.score - x.score);
      for (const c of candidates.slice(0, data.perPage)) {
        suggestions.push({
          from_url: a.url,
          to_url: c.to_url,
          anchor_text: c.anchor_text,
          score: Math.round(c.score * 1000) / 1000,
          reason: `Topic overlap (Jaccard ${(c.score * 100).toFixed(1)}%)`,
        });
      }
    }
    if (!suggestions.length) return { ok: true, count: 0 };
    const { error, count } = await sb()
      .from("internal_link_suggestions")
      .upsert(suggestions, { onConflict: "from_url,to_url", count: "exact" });
    if (error) return { ok: false, error: error.message };
    return { ok: true, count: count ?? suggestions.length };
  });

export const listLinkSuggestions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      status: z.enum(["pending", "applied", "dismissed", "all"]).default("pending"),
      q: z.string().max(200).default(""),
      limit: z.number().int().min(10).max(500).default(100),
    }).parse(d ?? {}),
  )
  .handler(async ({ data, context }): Promise<{ rows: LinkSuggestionRow[] }> => {
    await assertAdmin((context as any).userId);
    let q = sb()
      .from("internal_link_suggestions")
      .select("id, from_url, to_url, anchor_text, score, reason, status, created_at")
      .order("score", { ascending: false })
      .limit(data.limit);
    if (data.status !== "all") q = q.eq("status", data.status);
    if (data.q) q = q.or(`from_url.ilike.%${data.q}%,to_url.ilike.%${data.q}%,anchor_text.ilike.%${data.q}%`);
    const { data: rows } = await q;
    return { rows: (rows || []) as LinkSuggestionRow[] };
  });

export const updateLinkSuggestionStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      ids: z.array(z.string().uuid()).min(1).max(500),
      status: z.enum(["pending", "applied", "dismissed"]),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const { error } = await sb()
      .from("internal_link_suggestions")
      .update({ status: data.status, updated_at: new Date().toISOString() })
      .in("id", data.ids);
    return error ? { ok: false, error: error.message } : { ok: true, count: data.ids.length };
  });

/** Apply a link suggestion: append a markdown link to the from_url's page body. */
export const applyLinkSuggestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const { data: sug } = await sb()
      .from("internal_link_suggestions")
      .select("from_url, to_url, anchor_text")
      .eq("id", data.id)
      .maybeSingle();
    if (!sug) return { ok: false, error: "Suggestion not found" };
    const { data: page } = await sb()
      .from("content_pages")
      .select("id, body_markdown")
      .eq("url_path", sug.from_url)
      .maybeSingle();
    if (!page) return { ok: false, error: "From-page not found" };
    if ((page.body_markdown || "").includes(sug.to_url)) {
      await sb().from("internal_link_suggestions").update({ status: "applied", updated_at: new Date().toISOString() }).eq("id", data.id);
      return { ok: true, alreadyLinked: true };
    }
    const anchor = sug.anchor_text || sug.to_url;
    const linkLine = `\n\nRelated: [${anchor}](${sug.to_url})`;
    const newBody = (page.body_markdown || "") + linkLine;
    const { error: uErr } = await sb()
      .from("content_pages")
      .update({ body_markdown: newBody, updated_at: new Date().toISOString() })
      .eq("id", page.id);
    if (uErr) return { ok: false, error: uErr.message };
    await sb().from("internal_link_suggestions").update({ status: "applied", updated_at: new Date().toISOString() }).eq("id", data.id);
    return { ok: true };
  });

/** Bulk apply: actually inserts the markdown link for every selected suggestion. */
export const applyLinkSuggestionsBulk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ ids: z.array(z.string().uuid()).min(1).max(2500) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const client = sb();
    const { data: sugs } = await client
      .from("internal_link_suggestions")
      .select("id, from_url, to_url, anchor_text, status")
      .in("id", data.ids);
    if (!sugs?.length) return { ok: false, error: "No suggestions found" };

    // Group by from_url so each page is read+written once.
    const byPage = new Map<string, typeof sugs>();
    for (const s of sugs) {
      if (!byPage.has(s.from_url)) byPage.set(s.from_url, [] as any);
      byPage.get(s.from_url)!.push(s);
    }

    let applied = 0, skipped = 0, failed = 0;
    const appliedIds: string[] = [];
    const nowIso = new Date().toISOString();

    for (const [fromUrl, items] of byPage) {
      const { data: page } = await client
        .from("content_pages")
        .select("id, body_markdown")
        .eq("url_path", fromUrl)
        .maybeSingle();
      if (!page) { failed += items.length; continue; }
      let body = page.body_markdown || "";
      for (const s of items) {
        if (body.includes(s.to_url)) { skipped++; appliedIds.push(s.id); continue; }
        const anchor = s.anchor_text || s.to_url;
        body += `\n\nRelated: [${anchor}](${s.to_url})`;
        applied++;
        appliedIds.push(s.id);
      }
      const { error: uErr } = await client
        .from("content_pages")
        .update({ body_markdown: body, updated_at: nowIso })
        .eq("id", page.id);
      if (uErr) { failed += items.length; continue; }
    }

    if (appliedIds.length) {
      await client.from("internal_link_suggestions")
        .update({ status: "applied", updated_at: nowIso })
        .in("id", appliedIds);
    }
    return { ok: true, applied, skipped, failed, total: sugs.length };
  });
