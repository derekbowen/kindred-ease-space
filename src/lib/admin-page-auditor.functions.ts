import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "./admin-helpers.functions";
import type { AiDb } from "@/lib/ai/spend.server";
import type { OpenAiTransport } from "@/lib/ai/openai.server";

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

const AuditResultSchema = z
  .object({
    score: z.number(),
    summary: z.string(),
    strengths: z.array(z.string()),
    weaknesses: z.array(z.string()),
    recommendations: z.array(z.string()),
  })
  .strict();
export type AuditResult = z.infer<typeof AuditResultSchema>;

/** The auditor's output, as Structured Outputs: the result shape page_audits stores. */
export const AUDIT_FORMAT = {
  name: "page_audit",
  schema: {
    type: "object",
    properties: {
      score: { type: "integer", description: "0-100, this page against top-ranking competitors" },
      summary: { type: "string", description: "One sentence" },
      strengths: { type: "array", items: { type: "string" } },
      weaknesses: { type: "array", items: { type: "string" } },
      recommendations: { type: "array", items: { type: "string" } },
    },
    required: ["score", "summary", "strengths", "weaknesses", "recommendations"],
    additionalProperties: false,
  },
  parse: (v: unknown): AuditResult | null => {
    const r = AuditResultSchema.safeParse(v);
    return r.success ? r.data : null;
  },
};

export const AuditPageInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    url_path: z.string().min(1).max(300),
  })
  // A body carrying a model, a token count or any other key is refused.
  .strict();

export type AuditPageInput = z.infer<typeof AuditPageInputSchema>;
export type AuditPageResult =
  | { ok: true; audit: PageAuditRow }
  | {
      ok: false;
      error: string;
      suggestions?: Array<{ url_path: string; title: string | null; status: string }>;
    };
/** Test seams for the database and the provider transport. Production passes nothing. */
export type AuditPageDeps = { db?: AiDb; transport?: OpenAiTransport };

export const PAGE_NOT_FOUND_MESSAGE =
  "That page was not found in this workspace. Check the address or pick one of the suggestions.";

/**
 * Audit one page through the one spend flow (route page_audit: 1500 output
 * tokens, 60 s, gpt-5-nano, Structured Outputs). Membership first, then the
 * page is found BEFORE anything is reserved, so an unknown URL costs
 * nothing. Every refusal and failure is { ok: false, error } with a fixed
 * customer sentence.
 */
export async function runPageAudit(
  data: AuditPageInput,
  userId: string,
  deps: AuditPageDeps = {},
): Promise<AuditPageResult> {
  const { customerMessage, AI_MESSAGES } = await import("@/lib/ai/customer-error");
  try {
    await assertWorkspaceMember(data.workspaceId, userId);

    const path = normalizeAuditPath(data.url_path);

    // Pages live at /a/{slug}; /p/{slug} is the legacy prefix.
    const slug = path.replace(/^\/(a|p)\//, "").replace(/^\//, "");
    let page: {
      url_path: string;
      title: string;
      seo_description: string | null;
      body_markdown: string | null;
    } | null = null;

    const { data: tenantPage } = await sb()
      .from("tenant_pages")
      .select("slug, title, meta_description, body_markdown, status")
      .eq("workspace_id", data.workspaceId)
      .eq("slug", slug)
      .eq("status", "published")
      .maybeSingle();
    if (tenantPage) {
      page = {
        url_path: `/a/${tenantPage.slug}`,
        title: tenantPage.title,
        seo_description: tenantPage.meta_description,
        body_markdown: tenantPage.body_markdown,
      };
    } else {
      const { data: legacy } = await sb()
        .from("content_pages")
        .select("url_path, title, seo_description, body_markdown")
        .eq("workspace_id", data.workspaceId)
        .eq("url_path", path)
        .maybeSingle();
      page = legacy;
    }

    if (!page) {
      const rawNeedle = slug || path.replace(/^\//, "");
      const needle = rawNeedle.replace(/[%_,()*]/g, "");
      const [{ data: tenantSimilar }, { data: legacySimilar }] = await Promise.all([
        sb()
          .from("tenant_pages")
          .select("slug, title, status")
          .eq("workspace_id", data.workspaceId)
          .or(`slug.ilike.%${needle}%,title.ilike.%${needle}%`)
          .limit(8),
        sb()
          .from("content_pages")
          .select("url_path, title, status")
          .eq("workspace_id", data.workspaceId)
          .or(`url_path.ilike.%${needle}%,title.ilike.%${needle}%`)
          .limit(8),
      ]);
      const suggestions = [
        ...(tenantSimilar || []).map((r: any) => ({
          url_path: `/a/${r.slug}`,
          title: r.title,
          status: r.status,
        })),
        ...(legacySimilar || []),
      ].slice(0, 8);
      return {
        ok: false as const,
        error: PAGE_NOT_FOUND_MESSAGE,
        suggestions,
      };
    }

    const { data: comps } = await sb()
      .from("competitor_pages")
      .select("url, title, word_count, headings")
      .eq("workspace_id", data.workspaceId)
      .order("word_count", { ascending: false })
      .limit(3);

    const ourBody = (page.body_markdown || "").slice(0, 8000);
    const compSummary =
      (comps || [])
        .map(
          (c: any) =>
            `- ${c.url} (${c.word_count} words): ${(c.headings || [])
              .slice(0, 8)
              .map((h: any) => h.text)
              .join(" | ")}`,
        )
        .join("\n") || "No competitor data scraped yet.";

    const prompt = `Page URL: ${page.url_path}
Title: ${page.title || "(none)"}
Description: ${page.seo_description || "(none)"}
Body (truncated):
${ourBody}

Competitor pages on similar topics:
${compSummary}`;

    const { resolveAiKey, billingClassFor, runMeteredAiCall } =
      await import("@/lib/ai/spend.server");
    const key = await resolveAiKey(data.workspaceId, deps.db);
    const res = await runMeteredAiCall({
      workspaceId: data.workspaceId,
      userId,
      requestId: crypto.randomUUID(),
      route: "page_audit",
      source: "page_audit",
      key,
      billingClass: billingClassFor(key, { route: "page_audit" }),
      instructions:
        "You are an SEO auditor. Score the page 0-100 against the top-ranking competitors, summarise in one sentence, and list concrete strengths, weaknesses and recommendations.",
      input: prompt,
      format: AUDIT_FORMAT,
      deps,
    });
    const audit = res.output.data!;

    const { data: row, error } = await sb()
      .from("page_audits")
      .insert({
        workspace_id: data.workspaceId,
        url_path: page.url_path || path,
        score: Math.max(0, Math.min(100, Math.round(Number(audit.score) || 0))),
        summary: String(audit.summary || "").slice(0, 1000),
        strengths: audit.strengths.slice(0, 20),
        weaknesses: audit.weaknesses.slice(0, 20),
        recommendations: audit.recommendations.slice(0, 20),
      })
      .select("*")
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { ok: true as const, audit: row as PageAuditRow };
  } catch (e) {
    return { ok: false as const, error: customerMessage(e, AI_MESSAGES.unavailable) };
  }
}

export const auditPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => AuditPageInputSchema.parse(d))
  .handler(
    async ({ data, context }): Promise<AuditPageResult> => runPageAudit(data, context.userId),
  );

export const listRecentAudits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: workspaceIdSchema,
        limit: z.number().int().min(10).max(200).default(50),
        url_path: z.string().max(300).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<{ rows: PageAuditRow[] }> => {
    await assertWorkspaceMember(data.workspaceId, context.userId);
    let q = sb()
      .from("page_audits")
      .select("*")
      .eq("workspace_id", data.workspaceId)
      .order("audited_at", { ascending: false })
      .limit(data.limit);
    if (data.url_path) q = q.eq("url_path", data.url_path);
    const { data: rows } = await q;
    return { rows: (rows || []) as PageAuditRow[] };
  });
