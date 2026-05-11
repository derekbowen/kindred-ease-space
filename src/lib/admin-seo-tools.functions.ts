import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "./admin-helpers.functions";
import { requireWorkspaceSecret } from "./workspace-secrets.server";

const sb = () => supabaseAdmin as any;

// ============================================================================
// 1. GSC IMPORT + KEYWORD OPPORTUNITY FINDER
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

export const importGscQueries = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      workspaceId: workspaceIdSchema,
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
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const captured_at = new Date().toISOString();
    const payload = data.rows.map((r) => ({
      ...r,
      ctr: r.ctr ?? null,
      position: r.position ?? null,
      captured_at,
      workspace_id: data.workspaceId,
    }));
    const { error, count } = await sb()
      .from("gsc_query_data")
      .upsert(payload, { onConflict: "workspace_id,url_path,query", count: "exact" });
    if (error) return { ok: false as const, error: error.message, total: data.rows.length };
    return { ok: true as const, total: data.rows.length, upserted: count ?? data.rows.length };
  });

export const findKeywordOpportunities = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      workspaceId: workspaceIdSchema,
      minPosition: z.number().min(1).max(100).default(5),
      maxPosition: z.number().min(1).max(100).default(20),
      minImpressions: z.number().int().min(0).default(50),
      limit: z.number().int().min(10).max(500).default(100),
      pathLike: z.string().max(200).default(""),
    }).parse(d),
  )
  .handler(async ({ data, context }): Promise<{ rows: KeywordRow[]; total: number }> => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    let q = sb()
      .from("gsc_query_data")
      .select("*", { count: "exact" })
      .eq("workspace_id", data.workspaceId)
      .gte("position", data.minPosition)
      .lte("position", data.maxPosition)
      .gte("impressions", data.minImpressions)
      .order("impressions", { ascending: false })
      .limit(data.limit);
    if (data.pathLike) q = q.ilike("url_path", `%${data.pathLike}%`);
    const { data: rows, count } = await q;
    return { rows: (rows || []) as KeywordRow[], total: count || 0 };
  });

export const getKeywordStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ workspaceId: workspaceIdSchema }).parse(d))
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const ws = data.workspaceId;
    const [totalQ, oppQ, topQ] = await Promise.all([
      sb().from("gsc_query_data").select("*", { count: "exact", head: true }).eq("workspace_id", ws),
      sb().from("gsc_query_data").select("*", { count: "exact", head: true }).eq("workspace_id", ws)
        .gte("position", 5).lte("position", 20).gte("impressions", 50),
      sb().from("gsc_query_data").select("*", { count: "exact", head: true }).eq("workspace_id", ws)
        .lte("position", 3),
    ]);
    return {
      totalQueries: totalQ.count || 0,
      opportunities: oppQ.count || 0,
      top3: topQ.count || 0,
    };
  });

// ============================================================================
// 2. COMPETITOR PAGE SCRAPER (Firecrawl, BYOK)
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
      workspaceId: workspaceIdSchema,
      q: z.string().max(200).default(""),
      limit: z.number().int().min(10).max(500).default(100),
    }).parse(d),
  )
  .handler(async ({ data, context }): Promise<{ rows: CompetitorRow[] }> => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    let q = sb()
      .from("competitor_pages")
      .select("id, url, domain, title, meta_description, h1, word_count, notes, last_scraped_at, updated_at")
      .eq("workspace_id", data.workspaceId)
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
      workspaceId: workspaceIdSchema,
      url: z.string().url(),
      notes: z.string().max(1000).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    let fcKey: string;
    try {
      fcKey = await requireWorkspaceSecret(data.workspaceId, "FIRECRAWL_API_KEY", "FIRECRAWL_API_KEY");
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "Missing FIRECRAWL_API_KEY" };
    }

    const resp = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${fcKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: data.url, formats: ["markdown"], onlyMainContent: true }),
    });
    if (resp.status === 402) return { ok: false as const, error: "Firecrawl credits exhausted" };
    if (!resp.ok) return { ok: false as const, error: `Firecrawl ${resp.status}: ${(await resp.text()).slice(0, 200)}` };
    const json = await resp.json();
    const doc = json?.data || json;
    const markdown: string = doc?.markdown || "";
    const meta = doc?.metadata || {};
    if (!markdown || markdown.trim().length < 50) {
      return { ok: false as const, error: `Scrape returned ${markdown.length} chars. Page may block bots or render entirely client-side.` };
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
        workspace_id: data.workspaceId,
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
      }, { onConflict: "workspace_id,url" })
      .select("id, url, word_count")
      .maybeSingle();
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, id: row?.id, word_count: row?.word_count };
  });

export const deleteCompetitor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema, id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const { error } = await sb()
      .from("competitor_pages")
      .delete()
      .eq("workspace_id", data.workspaceId)
      .eq("id", data.id);
    return error ? { ok: false as const, error: error.message } : { ok: true as const };
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
  "all","any","some","one","two","three","up","down","out","into","over","under","about","near","there","here",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export const generateLinkSuggestions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      workspaceId: workspaceIdSchema,
      sampleSize: z.number().int().min(20).max(2000).default(500),
      minScore: z.number().min(0.05).max(1).default(0.18),
      perPage: z.number().int().min(1).max(20).default(5),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const { data: pages } = await sb()
      .from("content_pages")
      .select("url_path, title, body_markdown")
      .eq("workspace_id", data.workspaceId)
      .eq("status", "published")
      .order("updated_at", { ascending: false })
      .limit(data.sampleSize);
    if (!pages?.length) return { ok: false as const, error: "No published pages to analyze" };

    const tokenized = (pages as any[]).map((p) => ({
      url: p.url_path as string,
      title: p.title as string | null,
      body: p.body_markdown as string,
      tokens: tokenize(`${p.title || ""} ${(p.body_markdown || "").slice(0, 4000)}`),
    }));

    const suggestions: { workspace_id: string; from_url: string; to_url: string; anchor_text: string | null; score: number; reason: string }[] = [];
    for (let i = 0; i < tokenized.length; i++) {
      const a = tokenized[i];
      const candidates: { to_url: string; anchor_text: string | null; score: number }[] = [];
      for (let j = 0; j < tokenized.length; j++) {
        if (i === j) continue;
        const b = tokenized[j];
        const score = jaccard(a.tokens, b.tokens);
        if (score < data.minScore) continue;
        if (a.body && a.body.includes(b.url)) continue;
        candidates.push({ to_url: b.url, anchor_text: b.title, score });
      }
      candidates.sort((x, y) => y.score - x.score);
      for (const c of candidates.slice(0, data.perPage)) {
        suggestions.push({
          workspace_id: data.workspaceId,
          from_url: a.url,
          to_url: c.to_url,
          anchor_text: c.anchor_text,
          score: Math.round(c.score * 1000) / 1000,
          reason: `Topic overlap (Jaccard ${(c.score * 100).toFixed(1)}%)`,
        });
      }
    }
    if (!suggestions.length) return { ok: true as const, count: 0 };
    const { error, count } = await sb()
      .from("internal_link_suggestions")
      .upsert(suggestions, { onConflict: "workspace_id,from_url,to_url", count: "exact" });
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, count: count ?? suggestions.length };
  });

export const listLinkSuggestions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      workspaceId: workspaceIdSchema,
      status: z.enum(["pending", "applied", "dismissed", "all"]).default("pending"),
      q: z.string().max(200).default(""),
      limit: z.number().int().min(10).max(500).default(100),
    }).parse(d),
  )
  .handler(async ({ data, context }): Promise<{ rows: LinkSuggestionRow[] }> => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    let q = sb()
      .from("internal_link_suggestions")
      .select("id, from_url, to_url, anchor_text, score, reason, status, created_at")
      .eq("workspace_id", data.workspaceId)
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
      workspaceId: workspaceIdSchema,
      ids: z.array(z.string().uuid()).min(1).max(500),
      status: z.enum(["pending", "applied", "dismissed"]),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const { error } = await sb()
      .from("internal_link_suggestions")
      .update({ status: data.status, updated_at: new Date().toISOString() })
      .eq("workspace_id", data.workspaceId)
      .in("id", data.ids);
    return error ? { ok: false as const, error: error.message } : { ok: true as const, count: data.ids.length };
  });
