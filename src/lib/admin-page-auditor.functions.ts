import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "./admin-helpers.functions";

const sb = () => supabaseAdmin as any;

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
  p = p.replace(/^https?:\/\/[^/]+/i, "").replace(/[?#].*$/, "");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  if (!p.startsWith("/")) p = "/" + p;
  return p;
}

export const auditPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      workspaceId: workspaceIdSchema,
      url_path: z.string().min(1).max(300),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    const lovKey = process.env.LOVABLE_API_KEY;
    if (!lovKey) return { ok: false as const, error: "LOVABLE_API_KEY not configured" };

    const path = normalizeAuditPath(data.url_path);

    const { data: page } = await sb()
      .from("content_pages")
      .select("url_path, title, seo_description, body_markdown")
      .eq("workspace_id", data.workspaceId)
      .eq("url_path", path)
      .maybeSingle();

    if (!page) {
      const rawNeedle = path.replace(/^\//, "").split("/").pop() || path;
      // Strip PostgREST metacharacters to prevent .or() filter injection.
      const needle = rawNeedle.replace(/[%_,()*]/g, "");
      const { data: similar } = await sb()
        .from("content_pages")
        .select("url_path, title, status")
        .eq("workspace_id", data.workspaceId)
        .or(`url_path.ilike.%${needle}%,title.ilike.%${needle}%`)
        .limit(8);
      return {
        ok: false as const,
        error: `Page not found for "${path}".`,
        suggestions: (similar || []).map((r: any) => ({ url_path: r.url_path, title: r.title, status: r.status })),
      };
    }

    const { data: comps } = await sb()
      .from("competitor_pages")
      .select("url, title, word_count, headings")
      .eq("workspace_id", data.workspaceId)
      .order("word_count", { ascending: false })
      .limit(3);

    const ourBody = (page.body_markdown || "").slice(0, 8000);
    const compSummary = (comps || []).map((c: any) =>
      `- ${c.url} (${c.word_count} words): ${(c.headings || []).slice(0, 8).map((h: any) => h.text).join(" | ")}`,
    ).join("\n") || "No competitor data scraped yet.";

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
      body: JSON.stringify({ model: "google/gemini-2.5-flash", messages: [{ role: "user", content: prompt }] }),
    });
    if (aiResp.status === 402) return { ok: false as const, error: "AI credits exhausted." };
    if (!aiResp.ok) return { ok: false as const, error: `AI ${aiResp.status}: ${(await aiResp.text()).slice(0, 200)}` };
    const aiJson = await aiResp.json();
    const content: string = aiJson?.choices?.[0]?.message?.content || "";
    const cleaned = content.replace(/```json\s*/i, "").replace(/```\s*$/i, "").trim();
    let parsed: any;
    try { parsed = JSON.parse(cleaned); } catch {
      return { ok: false as const, error: "AI returned non-JSON", raw: content.slice(0, 300) };
    }

    const { data: row, error } = await sb().from("page_audits").insert({
      workspace_id: data.workspaceId,
      url_path: page.url_path || path,
      score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
      summary: String(parsed.summary || "").slice(0, 1000),
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 20) : [],
      weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses.slice(0, 20) : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.slice(0, 20) : [],
    }).select("*").maybeSingle();
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, audit: row as PageAuditRow };
  });

export const listRecentAudits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      workspaceId: workspaceIdSchema,
      limit: z.number().int().min(10).max(200).default(50),
      url_path: z.string().max(300).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }): Promise<{ rows: PageAuditRow[] }> => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    let q = sb().from("page_audits")
      .select("*")
      .eq("workspace_id", data.workspaceId)
      .order("audited_at", { ascending: false })
      .limit(data.limit);
    if (data.url_path) q = q.eq("url_path", data.url_path);
    const { data: rows } = await q;
    return { rows: (rows || []) as PageAuditRow[] };
  });
