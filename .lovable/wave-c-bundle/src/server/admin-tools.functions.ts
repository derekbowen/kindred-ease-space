import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function assertAdmin(userId: string) {
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
  if (!data) throw new Error("Forbidden");
}

export type SeoIssueRow = {
  id: string;
  url_path: string | null;
  title: string | null;
  template_type: string | null;
  words: number;
  has_meta: boolean;
  updated_at: string;
};

const ISSUE_KINDS = ["thin", "empty", "missing_meta", "title_is_slug"] as const;
type IssueKind = (typeof ISSUE_KINDS)[number];

export const listSeoIssues = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      kind: z.enum(ISSUE_KINDS),
      limit: z.number().int().min(1).max(500).default(100),
    }).parse(d),
  )
  .handler(async ({ data, context }): Promise<{ rows: SeoIssueRow[] }> => {
    await assertAdmin((context as any).userId);
    let q = (supabaseAdmin as any)
      .from("content_pages")
      .select("id, url_path, title, template_type, body_markdown, seo_description, updated_at, slug, status")
      .eq("status", "published")
      .like("url_path", "/p/%")
      .order("updated_at", { ascending: false })
      .limit(500);
    const { data: rows } = await q;
    const mapped: SeoIssueRow[] = (rows || []).map((r: any) => {
      const words = (r.body_markdown || "").split(/\s+/).filter(Boolean).length;
      return {
        id: r.id, url_path: r.url_path, title: r.title, template_type: r.template_type,
        words, has_meta: !!r.seo_description, updated_at: r.updated_at,
      };
    });
    let filtered = mapped;
    const slugFromPath = (p: string | null) => (p || "").replace(/^\/p\//, "").replace(/-/g, " ").trim().toLowerCase();
    const titleEqualsSlug = (r: SeoIssueRow) => {
      const t = (r.title || "").trim().toLowerCase();
      return !!t && t === slugFromPath(r.url_path);
    };
    if (data.kind === "thin") filtered = mapped.filter((r) => r.words > 0 && r.words < 500);
    else if (data.kind === "empty") filtered = mapped.filter((r) => r.words === 0);
    else if (data.kind === "missing_meta") filtered = mapped.filter((r) => !r.has_meta);
    else if (data.kind === "title_is_slug") filtered = mapped.filter(titleEqualsSlug);
    return { rows: filtered.slice(0, data.limit) };
  });

export type LeadRow = {
  id: string; name: string; email: string; phone: string | null;
  company: string | null; website: string | null; city: string | null;
  state_code: string | null; message: string | null; source_path: string | null;
  status: string; created_at: string;
};

export const listLeads = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      status: z.enum(["all", "new", "contacted", "closed"]).default("all"),
      limit: z.number().int().min(1).max(500).default(100),
    }).parse(d ?? {}),
  )
  .handler(async ({ data, context }): Promise<{ rows: LeadRow[] }> => {
    await assertAdmin((context as any).userId);
    let q = (supabaseAdmin as any).from("provider_leads").select("*").order("created_at", { ascending: false }).limit(data.limit);
    if (data.status !== "all") q = q.eq("status", data.status);
    const { data: rows } = await q;
    return { rows: (rows || []) as LeadRow[] };
  });

export const updateLeadStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), status: z.enum(["new", "contacted", "closed"]) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const { error } = await (supabaseAdmin as any).from("provider_leads").update({ status: data.status }).eq("id", data.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

export type ContentPageRow = {
  id: string; url_path: string | null; title: string | null;
  template_type: string | null; status: string; words: number; updated_at: string;
};

export const listContentPages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      q: z.string().max(200).default(""),
      status: z.enum(["all", "published", "pending", "draft", "scraped"]).default("all"),
      template: z.string().max(80).default(""),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(10).max(1000).default(50),
    }).parse(d ?? {}),
  )
  .handler(async ({ data, context }): Promise<{ rows: ContentPageRow[]; total: number }> => {
    await assertAdmin((context as any).userId);
    let base: any = (supabaseAdmin as any).from("content_pages").select("id, url_path, title, template_type, status, body_markdown, updated_at", { count: "exact" }).like("url_path", "/p/%");
    if (data.status !== "all") base = base.eq("status", data.status);
    if (data.template) base = base.eq("template_type", data.template);
    if (data.q) base = base.or(`url_path.ilike.%${data.q}%,title.ilike.%${data.q}%`);
    const from = (data.page - 1) * data.pageSize;
    const to = from + data.pageSize - 1;
    const { data: rows, count } = await base.order("updated_at", { ascending: false }).range(from, to);
    const mapped: ContentPageRow[] = (rows || []).map((r: any) => ({
      id: r.id, url_path: r.url_path, title: r.title, template_type: r.template_type,
      status: r.status, words: (r.body_markdown || "").split(/\s+/).filter(Boolean).length, updated_at: r.updated_at,
    }));
    return { rows: mapped, total: count || 0 };
  });

export const bulkUpdateContentPages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      ids: z.array(z.string().uuid()).min(1).max(500),
      action: z.enum(["publish", "unpublish", "delete"]),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    if (data.action === "delete") {
      const { error } = await (supabaseAdmin as any).from("content_pages").delete().in("id", data.ids);
      return error ? { ok: false, error: error.message } : { ok: true, count: data.ids.length, skipped: 0, skippedSlugs: [] as string[] };
    }
    if (data.action === "publish") {
      // Thin-content guard: only publish pages with >= 300 words. Thin pages stay as draft.
      const MIN_WORDS = 300;
      const { data: rows, error: fetchErr } = await (supabaseAdmin as any)
        .from("content_pages")
        .select("id, slug, body_markdown")
        .in("id", data.ids);
      if (fetchErr) return { ok: false, error: fetchErr.message };
      const eligible: string[] = [];
      const skipped: string[] = [];
      for (const r of rows || []) {
        const wc = String(r.body_markdown || "").split(/\s+/).filter(Boolean).length;
        if (wc >= MIN_WORDS) eligible.push(r.id);
        else skipped.push(r.slug || r.id);
      }
      if (eligible.length === 0) {
        return { ok: true, count: 0, skipped: skipped.length, skippedSlugs: skipped, reason: `All selected pages have fewer than ${MIN_WORDS} words and were kept as draft.` };
      }
      const { error } = await (supabaseAdmin as any).from("content_pages").update({ status: "published", updated_at: new Date().toISOString() }).in("id", eligible);
      if (error) return { ok: false, error: error.message };
      return { ok: true, count: eligible.length, skipped: skipped.length, skippedSlugs: skipped };
    }
    // unpublish → set status to draft (was 'pending'; "draft" matches the user's mental model and the editor option)
    const { error } = await (supabaseAdmin as any).from("content_pages").update({ status: "draft", updated_at: new Date().toISOString() }).in("id", data.ids);
    return error ? { ok: false, error: error.message } : { ok: true, count: data.ids.length, skipped: 0, skippedSlugs: [] as string[] };
  });

export type IndexingStats = {
  totalPublished: number;
  byTemplate: Array<{ template_type: string | null; count: number }>;
  recent404s: Array<{ id: string; url_path: string; hit_count: number; last_seen_at: string }>;
  unresolved404s: number;
  recentlyPublished: number;
};

export const getIndexingStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<IndexingStats> => {
    await assertAdmin((context as any).userId);
    const sb = supabaseAdmin as any;
    const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [{ count: totalPub }, { data: tpl }, { data: r404 }, { count: unres }, { count: recent }] = await Promise.all([
      sb.from("content_pages").select("*", { count: "exact", head: true }).eq("status", "published").like("url_path", "/p/%"),
      sb.from("content_pages").select("template_type, status").eq("status", "published").like("url_path", "/p/%").limit(5000),
      sb.from("content_404_log").select("id, url_path, hit_count, last_seen_at").is("resolved_at", null).order("hit_count", { ascending: false }).limit(20),
      sb.from("content_404_log").select("*", { count: "exact", head: true }).is("resolved_at", null),
      sb.from("content_pages").select("*", { count: "exact", head: true }).eq("status", "published").like("url_path", "/p/%").gte("updated_at", day),
    ]);
    const tplMap = new Map<string, number>();
    for (const r of tpl || []) {
      const k = (r as any).template_type || "(none)";
      tplMap.set(k, (tplMap.get(k) || 0) + 1);
    }
    return {
      totalPublished: totalPub || 0,
      byTemplate: Array.from(tplMap.entries()).map(([template_type, count]) => ({ template_type, count })).sort((a, b) => b.count - a.count),
      recent404s: r404 || [],
      unresolved404s: unres || 0,
      recentlyPublished: recent || 0,
    };
  });

// ============================================================================
// SEO fix actions: AI-powered repair for thin/empty/missing-meta/title-is-slug
// ============================================================================

const SEO_SYSTEM = `
You write SEO + brand content for Pool Rental Near Me (PRNM), a marketplace where homeowners rent out private pools by the hour.
Differentiators (mention naturally): 10% flat host fee (vs Swimply's 15%+), $2M liability insurance included.
Voice: confident, friendly, host-first. Short paragraphs. Real, useful copy. No filler. Sentence case headings. No em dashes.
Format: Markdown only. Use ## and ### headings. Include 3-5 internal links from this set where relevant:
  /s, /p/hosting, /p/all-locations, /p/earnings-calculator, /p/how-it-works
List Your Pool CTA URL: /l/draft/00000000-0000-0000-0000-000000000000/new/details
Always end with a short CTA paragraph linking to the List Your Pool URL or /s.
Return your answer ONLY by calling the write_page tool.
`.trim();

const SEO_TOOL = {
  type: "function" as const,
  function: {
    name: "write_page",
    description: "Return the repaired page content.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Human-readable H1 title (case-correct, no slug-style)" },
        seo_title: { type: "string", description: "<=60 chars" },
        seo_description: { type: "string", description: "<=155 chars, compelling meta description" },
        body_markdown: { type: "string", description: "Full markdown body, 800-1200 words, no frontmatter" },
      },
      required: ["title", "seo_title", "seo_description", "body_markdown"],
      additionalProperties: false,
    },
  },
};

function humanizeSlug(slug: string): string {
  return slug.replace(/^\/p\//, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function runSeoFix(pageId: string, mode: "full" | "meta_only" | "title_only"): Promise<
  { ok: true; newWords: number; newTitle: string } | { ok: false; error: string }
> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) return { ok: false, error: "LOVABLE_API_KEY not configured" };

  const { data: page, error: pErr } = await (supabaseAdmin as any)
    .from("content_pages")
    .select("id, url_path, slug, title, seo_title, seo_description, body_markdown, template_type, category")
    .eq("id", pageId)
    .maybeSingle();
  if (pErr || !page) return { ok: false, error: "Page not found" };

  const topic = humanizeSlug(page.url_path || page.slug || "");
  const currentBody = page.body_markdown || "";
  const wordCount = currentBody.split(/\s+/).filter(Boolean).length;

  let userPrompt = "";
  if (mode === "meta_only" || mode === "title_only") {
    userPrompt = `Generate ONLY a clean human-readable title and SEO title/description for this existing page.

URL: ${page.url_path}
Topic (derived from slug): ${topic}
Existing title: ${page.title || "(none)"}
Existing body excerpt (first 800 chars): ${currentBody.slice(0, 800)}

Produce:
- title: proper sentence-case H1 (NOT the slug)
- seo_title: <=60 chars, includes primary keyword
- seo_description: <=155 chars, compelling and specific

For body_markdown, return the EXISTING body unchanged.`;
  } else {
    const reason =
      wordCount === 0 ? "Page body is EMPTY — write fresh content." :
      wordCount < 500 ? `Page body is THIN (${wordCount} words) — expand to 800-1200 words while keeping any existing facts.` :
      "Improve the existing page.";
    userPrompt = `Repair this content page.

URL: ${page.url_path}
Topic (derived from slug): ${topic}
Existing title: ${page.title || "(none)"}
Issue: ${reason}
${currentBody ? `Existing body to expand/improve:\n---\n${currentBody.slice(0, 3000)}\n---` : ""}

Length: 800-1200 words. Use ## sections and ### sub-points. Strong opening, no fluff.`;
  }

  const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [{ role: "system", content: SEO_SYSTEM }, { role: "user", content: userPrompt }],
      tools: [SEO_TOOL],
      tool_choice: { type: "function", function: { name: "write_page" } },
    }),
  });
  if (resp.status === 402) return { ok: false, error: "AI credits exhausted" };
  if (resp.status === 429) return { ok: false, error: "Rate limited — slow down" };
  if (!resp.ok) return { ok: false, error: `AI gateway ${resp.status}: ${(await resp.text()).slice(0, 200)}` };

  const json = await resp.json();
  const tc = json?.choices?.[0]?.message?.tool_calls?.[0];
  if (!tc?.function?.arguments) return { ok: false, error: "AI returned no tool call" };
  const gen = JSON.parse(tc.function.arguments) as {
    title: string; seo_title: string; seo_description: string; body_markdown: string;
  };

  const update: any = {
    title: gen.title || page.title,
    seo_title: (gen.seo_title || page.seo_title || gen.title || "").slice(0, 70),
    seo_description: (gen.seo_description || page.seo_description || "").slice(0, 160),
    updated_at: new Date().toISOString(),
  };
  if (mode === "full" && gen.body_markdown && gen.body_markdown.length > 300) {
    update.body_markdown = gen.body_markdown;
    // Auto-promote scraped/pending rows to published once they have a real
    // body. Without this, /p/{slug} keeps 404'ing because lookupContentPage
    // only renders status='published'. This is what unblocks GSC validation
    // for "Crawled - currently not indexed" / "Soft 404" / "Not found 404".
    if (gen.body_markdown.length >= 1000) {
      update.status = "published";
      update.in_sitemap = true;
    }
  }

  const { error: uErr } = await (supabaseAdmin as any).from("content_pages").update(update).eq("id", pageId);
  if (uErr) return { ok: false, error: uErr.message };
  return {
    ok: true,
    newWords: (update.body_markdown || currentBody).split(/\s+/).filter(Boolean).length,
    newTitle: update.title,
  };
}

export const aiFixContentPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.string().uuid(),
      mode: z.enum(["full", "meta_only", "title_only"]).default("full"),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    return runSeoFix(data.id, data.mode);
  });

// ============================================================================
// Background job queue: enqueue / status / cancel
// ============================================================================

export type SeoJobRow = {
  id: string;
  page_id: string;
  mode: "full" | "meta_only" | "title_only";
  status: "queued" | "processing" | "done" | "failed" | "cancelled";
  attempts: number;
  result: any;
  error: string | null;
  batch_id: string | null;
  created_at: string;
  finished_at: string | null;
};

export const enqueueSeoFixJobs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      pageIds: z.array(z.string().uuid()).min(1).max(500),
      mode: z.enum(["full", "meta_only", "title_only"]).default("full"),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const userId = (context as any).userId as string;
    await assertAdmin(userId);
    const sb = supabaseAdmin as any;
    const batchId = crypto.randomUUID();
    const rows = data.pageIds.map((pid) => ({
      page_id: pid, mode: data.mode, status: "queued", batch_id: batchId, enqueued_by: userId,
    }));
    const { error } = await sb.from("seo_fix_jobs").insert(rows);
    if (error) return { ok: false, error: error.message };
    return { ok: true, batchId, count: rows.length };
  });

export const getSeoJobStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      batchId: z.string().uuid().optional(),
      pageIds: z.array(z.string().uuid()).max(500).optional(),
    }).parse(d ?? {}),
  )
  .handler(async ({ data, context }): Promise<{ jobs: SeoJobRow[]; summary: { queued: number; processing: number; done: number; failed: number; cancelled: number } }> => {
    await assertAdmin((context as any).userId);
    const sb = supabaseAdmin as any;
    let q = sb.from("seo_fix_jobs").select("id, page_id, mode, status, attempts, result, error, batch_id, created_at, finished_at").order("created_at", { ascending: false }).limit(500);
    if (data.batchId) q = q.eq("batch_id", data.batchId);
    if (data.pageIds && data.pageIds.length) q = q.in("page_id", data.pageIds);
    const { data: jobs } = await q;
    const summary = { queued: 0, processing: 0, done: 0, failed: 0, cancelled: 0 };
    // For each page, only count the most recent job
    const seen = new Set<string>();
    const latest: SeoJobRow[] = [];
    for (const j of (jobs || []) as SeoJobRow[]) {
      if (seen.has(j.page_id)) continue;
      seen.add(j.page_id);
      latest.push(j);
      (summary as any)[j.status] = ((summary as any)[j.status] || 0) + 1;
    }
    return { jobs: latest, summary };
  });

export const processSeoFixQueue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      batchId: z.string().uuid().optional(),
      max: z.number().int().min(1).max(25).default(10),
    }).parse(d ?? {}),
  )
  .handler(async ({ data, context }): Promise<{ processed: number; results: Array<{ id: string; ok: boolean; error?: string }> }> => {
    await assertAdmin((context as any).userId);
    const sb = supabaseAdmin as any;
    let q = sb
      .from("seo_fix_jobs")
      .select("id, page_id, mode, attempts, max_attempts, batch_id")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(data.max);
    if (data.batchId) q = q.eq("batch_id", data.batchId);
    const { data: jobs } = await q;
    const list = (jobs || []) as Array<{ id: string; page_id: string; mode: "full" | "meta_only" | "title_only"; attempts: number; max_attempts: number }>;
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const job of list) {
      const { data: claimed } = await sb
        .from("seo_fix_jobs")
        .update({ status: "processing", started_at: new Date().toISOString(), attempts: job.attempts + 1 })
        .eq("id", job.id)
        .eq("status", "queued")
        .select("id")
        .maybeSingle();
      if (!claimed) continue;
      try {
        const res = await runSeoFix(job.page_id, job.mode);
        if (res.ok) {
          await sb.from("seo_fix_jobs").update({ status: "done", result: res, finished_at: new Date().toISOString(), error: null }).eq("id", job.id);
          results.push({ id: job.id, ok: true });
        } else {
          const giveUp = job.attempts + 1 >= job.max_attempts;
          await sb.from("seo_fix_jobs").update({
            status: giveUp ? "failed" : "queued",
            error: res.error,
            finished_at: giveUp ? new Date().toISOString() : null,
          }).eq("id", job.id);
          results.push({ id: job.id, ok: false, error: res.error });
        }
      } catch (e: any) {
        const giveUp = job.attempts + 1 >= job.max_attempts;
        await sb.from("seo_fix_jobs").update({
          status: giveUp ? "failed" : "queued",
          error: e?.message || "Worker exception",
          finished_at: giveUp ? new Date().toISOString() : null,
        }).eq("id", job.id);
        results.push({ id: job.id, ok: false, error: e?.message });
      }
    }
    return { processed: results.length, results };
  });

export const cancelQueuedSeoJobs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ batchId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const { error, count } = await (supabaseAdmin as any)
      .from("seo_fix_jobs")
      .update({ status: "cancelled", finished_at: new Date().toISOString() }, { count: "exact" })
      .eq("batch_id", data.batchId)
      .eq("status", "queued");
    if (error) return { ok: false, error: error.message };
    return { ok: true, cancelled: count || 0 };
  });

// ============================================================================
// Single-page editor: fetch full row, save manual edits, append AI section
// ============================================================================

export type ContentPageFull = {
  id: string;
  url_path: string | null;
  slug: string | null;
  title: string | null;
  seo_title: string | null;
  seo_description: string | null;
  og_title: string | null;
  og_description: string | null;
  focus_keyword: string | null;
  canonical_override: string | null;
  hero_image_url: string | null;
  body_markdown: string | null;
  template_type: string | null;
  status: string;
  updated_at: string;
  created_at: string;
};

const PAGE_SELECT =
  "id, url_path, slug, title, seo_title, seo_description, og_title, og_description, focus_keyword, canonical_override, hero_image_url, body_markdown, template_type, status, updated_at, created_at";

export const getContentPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true; page: ContentPageFull } | { ok: false; error: string }> => {
    await assertAdmin((context as any).userId);
    const { data: row, error } = await (supabaseAdmin as any)
      .from("content_pages")
      .select(PAGE_SELECT)
      .eq("id", data.id)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!row) return { ok: false, error: "Not found" };
    return { ok: true, page: row as ContentPageFull };
  });

export const updateContentPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.string().uuid(),
      title: z.string().max(300).optional(),
      seo_title: z.string().max(200).optional(),
      seo_description: z.string().max(400).optional(),
      og_title: z.string().max(200).optional().nullable(),
      og_description: z.string().max(400).optional().nullable(),
      focus_keyword: z.string().max(120).optional().nullable(),
      canonical_override: z.string().max(500).optional().nullable(),
      hero_image_url: z.string().max(2000).optional().nullable(),
      body_markdown: z.string().max(200000).optional(),
      status: z.enum(["draft", "pending", "published"]).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin((context as any).userId);
    const { id, ...rest } = data;
    const update: any = { ...rest, updated_at: new Date().toISOString() };
    // Normalize empty strings to null for optional fields
    for (const k of ["og_title", "og_description", "focus_keyword", "canonical_override", "hero_image_url"]) {
      if (typeof update[k] === "string" && update[k].trim() === "") update[k] = null;
    }
    if (update.status === "published") update.in_sitemap = true;
    const { error } = await (supabaseAdmin as any).from("content_pages").update(update).eq("id", id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

export const appendAiContentToPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.string().uuid(),
      prompt: z.string().min(3).max(2000),
      append: z.boolean().default(true),
    }).parse(d),
  )
  .handler(async ({ data, context }): Promise<{ ok: true; body_markdown: string; added: string } | { ok: false; error: string }> => {
    await assertAdmin((context as any).userId);
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) return { ok: false, error: "LOVABLE_API_KEY not configured" };

    const { data: page } = await (supabaseAdmin as any)
      .from("content_pages")
      .select("id, url_path, title, body_markdown")
      .eq("id", data.id)
      .maybeSingle();
    if (!page) return { ok: false, error: "Page not found" };

    const sys = `${SEO_SYSTEM}\n\nYou are ADDING a new section to an existing page. Match the page topic and existing tone. Output Markdown only, starting with a ## heading. 200-600 words. No frontmatter, no preamble.`;
    const user = `Page URL: ${page.url_path}
Page title: ${page.title || "(none)"}
Existing body excerpt (first 1500 chars):
---
${(page.body_markdown || "").slice(0, 1500)}
---

User request for the new section:
${data.prompt}

Write the new section now.`;

    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      }),
    });
    if (resp.status === 402) return { ok: false, error: "AI credits exhausted" };
    if (resp.status === 429) return { ok: false, error: "Rate limited — try again shortly" };
    if (!resp.ok) return { ok: false, error: `AI gateway ${resp.status}` };
    const json = await resp.json();
    const added = (json?.choices?.[0]?.message?.content || "").trim();
    if (!added) return { ok: false, error: "AI returned empty content" };

    const newBody = data.append
      ? `${(page.body_markdown || "").trimEnd()}\n\n${added}\n`
      : added;
    const { error: uErr } = await (supabaseAdmin as any)
      .from("content_pages")
      .update({ body_markdown: newBody, updated_at: new Date().toISOString() })
      .eq("id", data.id);
    if (uErr) return { ok: false, error: uErr.message };
    return { ok: true, body_markdown: newBody, added };
  });

// ============================================================================
// AI generate / improve / SEO meta / section presets — preview-then-save model
// ============================================================================

const BRAND_VOICE = `
Brand voice rules (apply to ALL output):
- Sentence case headings (no Title Case).
- Second person ("you", "your pool").
- No em dashes; use commas, periods, or restructure.
- Banned words: leverage, utilize, seamlessly, robust, dive into, elevate, game-changer, unlock, journey, landscape, bustling, thriving, vibrant, state-of-the-art, cutting-edge.
- Banned phrases: "in this article", "in conclusion", "it's worth noting", "thousands of hosts", "proven track record", "Pool Rental Near Me is the leading".
- Numbers under 10 spelled out, 10+ as numerals.
- Dollar amounts as $X/hour, not "$X per hour".
- Real numbers only. Typical hourly rates $40-150/hr. Never invent statistics.
- Differentiators (mention naturally where relevant): 10% flat host fee (vs Swimply's 15%+), $2M liability insurance included, 5,100+ city pages indexed.
- Internal links to use where relevant: /s, /p/hosting, /p/all-locations, /p/earnings-calculator, /p/how-it-works
- List Your Pool CTA URL: /l/draft/00000000-0000-0000-0000-000000000000/new/details
`.trim();

async function callAi(opts: {
  system: string;
  user: string;
  model?: string;
  json?: boolean;
}): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) return { ok: false, error: "LOVABLE_API_KEY not configured" };
  const body: any = {
    model: opts.model ?? "google/gemini-2.5-pro",
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  };
  if (opts.json) body.response_format = { type: "json_object" };
  const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (resp.status === 402) return { ok: false, error: "AI credits exhausted" };
  if (resp.status === 429) return { ok: false, error: "Rate limited — try again shortly" };
  if (!resp.ok) return { ok: false, error: `AI gateway ${resp.status}` };
  const json = await resp.json();
  const content = (json?.choices?.[0]?.message?.content || "").trim();
  if (!content) return { ok: false, error: "AI returned empty content" };
  return { ok: true, content };
}

async function loadPageForAi(id: string) {
  const { data: page } = await (supabaseAdmin as any)
    .from("content_pages")
    .select("id, url_path, slug, title, seo_title, seo_description, focus_keyword, template_type, body_markdown")
    .eq("id", id)
    .maybeSingle();
  return page as null | {
    id: string;
    url_path: string | null;
    slug: string | null;
    title: string | null;
    seo_title: string | null;
    seo_description: string | null;
    focus_keyword: string | null;
    template_type: string | null;
    body_markdown: string | null;
  };
}

function pageContext(p: NonNullable<Awaited<ReturnType<typeof loadPageForAi>>>): string {
  return `Page URL: ${p.url_path ?? "(none)"}
Slug: ${p.slug ?? "(none)"}
Template: ${p.template_type ?? "(generic)"}
H1 title: ${p.title ?? "(none)"}
Current SEO title: ${p.seo_title ?? "(none)"}
Current SEO description: ${p.seo_description ?? "(none)"}
Focus keyword: ${p.focus_keyword ?? "(none)"}`;
}

// Generate a complete page body. Returns proposed markdown — does NOT save.
export const generateFullPageContent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true; body_markdown: string } | { ok: false; error: string }> => {
    await assertAdmin((context as any).userId);
    const p = await loadPageForAi(data.id);
    if (!p) return { ok: false, error: "Page not found" };
    const sys = `You write SEO + brand content for Pool Rental Near Me (PRNM).
${BRAND_VOICE}
Output ONLY Markdown body (no frontmatter, no preamble, no closing remark). Use ## and ### headings. 800-1200 words. Include 3-5 internal links from the allowed set. End with a short CTA paragraph linking to the List Your Pool URL or /s.`;
    const user = `Write the FULL page body from scratch for this page.

${pageContext(p)}

Structure suggestions by template:
- host_acq_city / host_advocacy_state: intro, why host here, local demand signals, regulations summary, earnings range, getting started CTA.
- event_guide: intro, what to expect, planning checklist, local venue tips, FAQ, CTA.
- resource: intro, problem, step-by-step, common mistakes, FAQ, CTA.
- generic: intro, 3-5 H2 sections relevant to the title, FAQ, CTA.`;
    const r = await callAi({ system: sys, user });
    if (!r.ok) return r;
    return { ok: true, body_markdown: r.content };
  });

// Improve existing body: tighten copy, fix banned words, expand thin sections.
// Returns proposed markdown — does NOT save.
export const improvePageContent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true; body_markdown: string } | { ok: false; error: string }> => {
    await assertAdmin((context as any).userId);
    const p = await loadPageForAi(data.id);
    if (!p) return { ok: false, error: "Page not found" };
    if (!p.body_markdown || p.body_markdown.trim().length < 50) {
      return { ok: false, error: "Body is too short to improve. Use Generate full page instead." };
    }
    const sys = `You are an editor improving an existing PRNM content page.
${BRAND_VOICE}
Tasks:
1. Remove banned words and phrases. 2. Replace em dashes. 3. Tighten verbose sentences.
4. Convert any Title Case headings to sentence case. 5. Ensure focus keyword (if given) appears in the H1 area, first paragraph, and at least one ## heading.
6. Expand any section with fewer than 3 sentences. 7. Keep total length within 10% of original. 8. Preserve all existing internal links unless they are in the banned set.
Output ONLY the rewritten Markdown body. No preamble, no commentary, no diff markers.`;
    const user = `${pageContext(p)}

Current body:
---
${p.body_markdown}
---

Rewrite it now.`;
    const r = await callAi({ system: sys, user });
    if (!r.ok) return r;
    return { ok: true, body_markdown: r.content };
  });

// Generate SEO meta (title/description + OG) from current body. Does NOT save.
export const generateSeoMeta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<
    | { ok: true; seo_title: string; seo_description: string; og_title: string; og_description: string }
    | { ok: false; error: string }
  > => {
    await assertAdmin((context as any).userId);
    const p = await loadPageForAi(data.id);
    if (!p) return { ok: false, error: "Page not found" };
    const sys = `You write SEO + social metadata for PRNM.
${BRAND_VOICE}
Return ONLY a JSON object with these exact keys: seo_title, seo_description, og_title, og_description.
- seo_title: 50-60 chars, includes focus keyword if given.
- seo_description: 140-155 chars, compelling click-through copy.
- og_title: 40-60 chars, punchier social headline (can be different from seo_title).
- og_description: 100-150 chars, social-share friendly.`;
    const user = `${pageContext(p)}

First 1500 chars of body:
---
${(p.body_markdown ?? "").slice(0, 1500)}
---

Return the JSON now.`;
    const r = await callAi({ system: sys, user, json: true });
    if (!r.ok) return r;
    try {
      const parsed = JSON.parse(r.content) as Record<string, unknown>;
      const s = (k: string) => (typeof parsed[k] === "string" ? (parsed[k] as string).trim() : "");
      const seo_title = s("seo_title");
      const seo_description = s("seo_description");
      const og_title = s("og_title") || seo_title;
      const og_description = s("og_description") || seo_description;
      if (!seo_title || !seo_description) return { ok: false, error: "AI returned incomplete metadata" };
      return { ok: true, seo_title, seo_description, og_title, og_description };
    } catch {
      return { ok: false, error: "AI returned invalid JSON" };
    }
  });

// Quick-add section presets. Returns proposed markdown block — does NOT save.
export const SECTION_PRESETS = [
  { key: "faq", label: "FAQ (5 questions)", prompt: "Write a 5-question FAQ section. Use ## FAQ as the heading and **bold** for each question. Tailor questions to this page's topic." },
  { key: "pricing_table", label: "Pricing table", prompt: "Add a pricing comparison section. Use a Markdown table with columns: Pool size, Typical hourly rate, Best for. Use realistic PRNM ranges ($40-150/hr)." },
  { key: "what_to_expect", label: "What to expect checklist", prompt: 'Add a "What to expect" section with a checklist of 6-8 items using `- [ ]` Markdown task list syntax, tailored to this page topic.' },
  { key: "landmarks", label: "Local landmarks (city pages)", prompt: "Add a 'Things to do nearby' section listing 5-7 well-known local landmarks, parks, or attractions for this city. Each as a bullet with a one-sentence note on why pool guests would care." },
  { key: "insurance", label: "Insurance & liability", prompt: "Add an 'Insurance and liability' section explaining PRNM's $2M liability coverage, what it covers, what it doesn't, and how it compares to Swimply." },
  { key: "host_tips", label: "Host tips & safety", prompt: "Add a 'Host tips and safety' section with 5 actionable tips a new pool host should follow before their first booking. Use a numbered list." },
  { key: "comparison", label: "PRNM vs Swimply", prompt: "Add a comparison section using a Markdown table with rows: Host fee, Liability insurance, Payout speed, Support, Listing approval time. Be factual and PRNM-favorable." },
  { key: "internal_links", label: "Related cities (auto)", prompt: "__INTERNAL_LINKS__" },
  { key: "testimonials", label: "Testimonials block", prompt: "Add a 'What hosts are saying' section with 3 short testimonial-style quotes (placeholder names like 'Sarah, host in [generic city]'). Mark clearly that they are placeholders so the admin can replace them." },
] as const;

export type SectionPresetKey = (typeof SECTION_PRESETS)[number]["key"];

async function buildInternalLinksMarkdown(slug: string | null): Promise<string> {
  if (!slug) return "";
  // Try nearby cities first if this slug matches a city page
  try {
    const { data: nearby } = await (supabaseAdmin as any)
      .rpc("nearby_cities_by_distance", { _slug: slug, _limit: 6 });
    const list = (nearby ?? []) as Array<{ out_slug: string; out_name: string; out_state_code: string }>;
    if (list.length >= 3) {
      const items = list.map((c) => `- [Pool rentals in ${c.out_name}, ${c.out_state_code}](/p/${c.out_slug})`).join("\n");
      return `## Nearby cities to explore\n\n${items}\n`;
    }
  } catch { /* fall through */ }
  // Fallback: random recent published pages
  const { data: rows } = await (supabaseAdmin as any)
    .from("content_pages")
    .select("slug, title, url_path")
    .eq("status", "published")
    .like("url_path", "/p/%")
    .neq("slug", slug)
    .order("updated_at", { ascending: false })
    .limit(6);
  const list = (rows ?? []) as Array<{ slug: string; title: string | null; url_path: string }>;
  if (!list.length) return "";
  const items = list.map((r) => `- [${r.title ?? r.slug}](${r.url_path})`).join("\n");
  return `## Related guides\n\n${items}\n`;
}

export const generateSectionPreset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.string().uuid(),
      preset_key: z.string().min(1).max(50),
    }).parse(d),
  )
  .handler(async ({ data, context }): Promise<{ ok: true; markdown: string } | { ok: false; error: string }> => {
    await assertAdmin((context as any).userId);
    const preset = SECTION_PRESETS.find((p) => p.key === data.preset_key);
    if (!preset) return { ok: false, error: "Unknown preset" };
    const p = await loadPageForAi(data.id);
    if (!p) return { ok: false, error: "Page not found" };

    // Special case: internal_links is purely deterministic, no AI call needed.
    if (preset.prompt === "__INTERNAL_LINKS__") {
      const md = await buildInternalLinksMarkdown(p.slug);
      if (!md) return { ok: false, error: "No related pages found to link to" };
      return { ok: true, markdown: md };
    }

    const sys = `You add a single new section to an existing PRNM page.
${BRAND_VOICE}
Output ONLY the Markdown for the new section. Start with a ## heading. 150-450 words. No preamble, no commentary, no closing remark.`;
    const user = `${pageContext(p)}

Existing body excerpt (first 1500 chars):
---
${(p.body_markdown ?? "").slice(0, 1500)}
---

Section to write:
${preset.prompt}`;
    const r = await callAi({ system: sys, user });
    if (!r.ok) return r;
    return { ok: true, markdown: r.content };
  });

// ─── Custom AI section presets (admin-managed) ───────────────────────────────
export type CustomSectionPreset = {
  id: string;
  label: string;
  prompt: string;
  sort_order: number;
  updated_at: string;
};

export const listSectionPresets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ rows: CustomSectionPreset[] }> => {
    await assertAdmin((context as any).userId);
    const { data } = await (supabaseAdmin as any)
      .from("admin_section_presets")
      .select("id, label, prompt, sort_order, updated_at")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    return { rows: (data ?? []) as CustomSectionPreset[] };
  });

export const saveSectionPreset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      id: z.string().uuid().optional(),
      label: z.string().min(1).max(80),
      prompt: z.string().min(5).max(4000),
      sort_order: z.number().int().min(0).max(9999).default(0),
    }).parse(d),
  )
  .handler(async ({ data, context }): Promise<{ ok: true; id: string } | { ok: false; error: string }> => {
    const userId = (context as any).userId as string;
    await assertAdmin(userId);
    if (data.id) {
      const { error } = await (supabaseAdmin as any)
        .from("admin_section_presets")
        .update({ label: data.label, prompt: data.prompt, sort_order: data.sort_order, updated_at: new Date().toISOString() })
        .eq("id", data.id);
      if (error) return { ok: false, error: error.message };
      return { ok: true, id: data.id };
    }
    const { data: row, error } = await (supabaseAdmin as any)
      .from("admin_section_presets")
      .insert({ label: data.label, prompt: data.prompt, sort_order: data.sort_order, created_by: userId })
      .select("id")
      .single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: row.id };
  });

export const deleteSectionPreset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true } | { ok: false; error: string }> => {
    await assertAdmin((context as any).userId);
    const { error } = await (supabaseAdmin as any).from("admin_section_presets").delete().eq("id", data.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

// Run a saved custom prompt (returns proposed markdown — does NOT save).
export const generateCustomSection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), preset_id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }): Promise<{ ok: true; markdown: string; label: string } | { ok: false; error: string }> => {
    await assertAdmin((context as any).userId);
    const { data: preset } = await (supabaseAdmin as any)
      .from("admin_section_presets")
      .select("label, prompt")
      .eq("id", data.preset_id)
      .maybeSingle();
    if (!preset) return { ok: false, error: "Preset not found" };
    const p = await loadPageForAi(data.id);
    if (!p) return { ok: false, error: "Page not found" };
    const sys = `You add a single new section to an existing PRNM page.
${BRAND_VOICE}
Output ONLY the Markdown for the new section. Start with a ## heading. 150-450 words. No preamble, no commentary, no closing remark.`;
    const user = `${pageContext(p)}

Existing body excerpt (first 1500 chars):
---
${(p.body_markdown ?? "").slice(0, 1500)}
---

Section to write:
${preset.prompt}`;
    const r = await callAi({ system: sys, user });
    if (!r.ok) return r;
    return { ok: true, markdown: r.content, label: preset.label };
  });

// ─── Auto-fix SEO: one-click "make all checks green" ─────────────────────────
// Generates focus_keyword (if missing), perfect-length seo_title/description,
// og_*, and (if needed) rewrites/expands the body so it has 800+ words, the
// focus keyword in the first 800 chars, and at least 3 internal links.
export const autoFixSeo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<
    | { ok: true; page: NonNullable<Awaited<ReturnType<typeof loadPageForAi>>>; changed: string[] }
    | { ok: false; error: string }
  > => {
    await assertAdmin((context as any).userId);
    const p = await loadPageForAi(data.id);
    if (!p) return { ok: false, error: "Page not found" };

    const body = (p.body_markdown ?? "");
    const wordCount = body.split(/\s+/).filter(Boolean).length;
    const internalLinks = (body.match(/\]\(\/[^)]+\)/g) ?? []).length;
    const needsBodyRewrite = wordCount < 800 || internalLinks < 3;

    const sys = `You are an SEO specialist for Pool Rental Near Me (PRNM).
${BRAND_VOICE}

Your job: produce a JSON object that makes EVERY SEO check pass for this page.

Required checks (you MUST satisfy all):
- focus_keyword: 2-5 word phrase, lowercase, naturally describes the page topic.
- seo_title: 50-60 characters, includes focus_keyword near the start.
- seo_description: 140-155 characters, includes focus_keyword, compelling click copy.
- og_title: 40-60 characters.
- og_description: 100-150 characters.
${needsBodyRewrite ? `- body_markdown: rewritten/expanded to 850-1100 words. MUST contain at least 4 markdown links to internal /p/ or /s or /l/ paths from the allowed list. Focus keyword MUST appear in the first paragraph and at least one ## heading. Sentence-case headings only. End with a CTA paragraph.` : `- body_markdown: keep as-is (return null).`}

Return ONLY a JSON object with these exact keys:
{ "focus_keyword": string, "seo_title": string, "seo_description": string, "og_title": string, "og_description": string, "body_markdown": string | null }`;

    const user = `${pageContext(p)}

Word count: ${wordCount}
Internal link count: ${internalLinks}

${needsBodyRewrite ? `Current body to rewrite/expand:\n---\n${body || "(empty)"}\n---` : `(Body already meets length and link checks; return body_markdown: null.)`}

Return the JSON now.`;

    const r = await callAi({ system: sys, user, json: true });
    if (!r.ok) return r;

    let parsed: any;
    try { parsed = JSON.parse(r.content); } catch { return { ok: false, error: "AI returned invalid JSON" }; }

    const s = (k: string) => (typeof parsed?.[k] === "string" ? (parsed[k] as string).trim() : "");
    const focus_keyword = s("focus_keyword").toLowerCase();
    const seo_title = s("seo_title");
    const seo_description = s("seo_description");
    const og_title = s("og_title") || seo_title;
    const og_description = s("og_description") || seo_description;
    const newBody = typeof parsed?.body_markdown === "string" && parsed.body_markdown.trim().length > 200
      ? (parsed.body_markdown as string)
      : null;

    if (!seo_title || !seo_description || !focus_keyword) {
      return { ok: false, error: "AI returned incomplete SEO fields" };
    }

    const update: any = {
      focus_keyword,
      seo_title,
      seo_description,
      og_title,
      og_description,
      updated_at: new Date().toISOString(),
    };
    const changed = ["focus_keyword", "seo_title", "seo_description", "og_title", "og_description"];
    if (newBody) { update.body_markdown = newBody; changed.push("body_markdown"); }

    const { error } = await (supabaseAdmin as any).from("content_pages").update(update).eq("id", p.id);
    if (error) return { ok: false, error: error.message };

    const refreshed = await loadPageForAi(p.id);
    if (!refreshed) return { ok: false, error: "Failed to reload page" };
    return { ok: true, page: refreshed, changed };
  });
