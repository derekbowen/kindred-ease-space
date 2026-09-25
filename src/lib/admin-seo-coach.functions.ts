import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertWorkspaceMember, workspaceIdSchema } from "./admin-helpers.functions";
import type { AiDb } from "@/lib/ai/spend.server";
import type { OpenAiTransport } from "@/lib/ai/openai.server";

const sb = () => supabaseAdmin as any;

async function buildSnapshot(workspaceId: string): Promise<string> {
  const week = new Date(Date.now() - 7 * 86400_000).toISOString();
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };

  const [pages, missing, gsc, thin, noMeta] = await Promise.all([
    safe(
      async () => {
        const [
          { count: tenantPub },
          { count: tenantDraft },
          { count: contentTotal },
          { count: contentPub },
          { count: contentPending },
        ] = await Promise.all([
          sb()
            .from("tenant_pages")
            .select("*", { count: "exact", head: true })
            .eq("workspace_id", workspaceId)
            .eq("status", "published"),
          sb()
            .from("tenant_pages")
            .select("*", { count: "exact", head: true })
            .eq("workspace_id", workspaceId)
            .eq("status", "draft"),
          sb()
            .from("content_pages")
            .select("*", { count: "exact", head: true })
            .eq("workspace_id", workspaceId),
          sb()
            .from("content_pages")
            .select("*", { count: "exact", head: true })
            .eq("workspace_id", workspaceId)
            .eq("status", "published"),
          sb()
            .from("content_pages")
            .select("*", { count: "exact", head: true })
            .eq("workspace_id", workspaceId)
            .eq("status", "pending"),
        ]);
        const { fetchPublishedPages } = await import("@/lib/page-data.helpers.server");
        const recent = await fetchPublishedPages(workspaceId, { limit: 5000 });
        const publishedLast7d = recent.filter((p) => p.updated_at >= week).length;
        const published = (tenantPub ?? 0) + (contentPub ?? 0);
        return {
          total:
            published +
            (contentPending ?? 0) +
            (tenantDraft ?? 0) +
            Math.max(0, (contentTotal ?? 0) - (contentPub ?? 0) - (contentPending ?? 0)),
          published,
          pending: (contentPending ?? 0) + (tenantDraft ?? 0),
          publishedLast7d,
          tenantPublished: tenantPub ?? 0,
        };
      },
      { total: 0, published: 0, pending: 0, publishedLast7d: 0, tenantPublished: 0 },
    ),

    safe(async () => {
      const { count } = await sb()
        .from("content_404_log")
        .select("*", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .is("resolved_at", null);
      return count ?? 0;
    }, 0),

    safe(
      async () => {
        const { data } = await sb()
          .from("gsc_query_data")
          .select("url_path, clicks, impressions, position, captured_at")
          .eq("workspace_id", workspaceId)
          .gte("captured_at", week)
          .limit(5000);
        const rows = data || [];
        const clicks = rows.reduce((a: number, r: any) => a + (r.clicks || 0), 0);
        const impr = rows.reduce((a: number, r: any) => a + (r.impressions || 0), 0);
        const byPage: Record<string, number> = {};
        rows.forEach((r: any) => {
          byPage[r.url_path] = (byPage[r.url_path] || 0) + (r.clicks || 0);
        });
        const top = Object.entries(byPage)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);
        const lastCaptured = rows.length
          ? rows
              .map((r: any) => r.captured_at)
              .sort()
              .pop()
          : null;
        return { clicks, impr, top, lastCaptured };
      },
      {
        clicks: 0,
        impr: 0,
        top: [] as Array<[string, number]>,
        lastCaptured: null as string | null,
      },
    ),

    safe(
      async () => {
        const { fetchPublishedPages } = await import("@/lib/page-data.helpers.server");
        const all = await fetchPublishedPages(workspaceId, { limit: 2000 });
        let thinCount = 0,
          empty = 0;
        for (const r of all) {
          const w = (r.body_markdown || "").split(/\s+/).filter(Boolean).length;
          if (w === 0) empty++;
          else if (w < 500) thinCount++;
        }
        return { thin: thinCount, empty };
      },
      { thin: 0, empty: 0 },
    ),

    safe(async () => {
      const { fetchPublishedPages } = await import("@/lib/page-data.helpers.server");
      const all = await fetchPublishedPages(workspaceId, { limit: 2000 });
      return all.filter((p) => !p.meta_description?.trim()).length;
    }, 0),
  ]);

  return `LIVE SEO SNAPSHOT (as of ${new Date().toISOString()}):
- Live pages: ${pages.published} published (${(pages as any).tenantPublished ?? 0} tenant_pages at /a/*), ${pages.pending} drafts/pending, ${pages.publishedLast7d} updated in last 7d
- Unresolved 404s: ${missing}
- Published quality: ${thin.empty} empty (0 words), ${thin.thin} thin (<500 words), ${noMeta} missing meta description
- GSC last 7d: ${gsc.clicks} clicks, ${gsc.impr} impressions (last sync: ${gsc.lastCaptured || "never"})
- Top pages by clicks (7d): ${gsc.top.map(([p, c]) => `${p}=${c}`).join(", ") || "no data"}

ADMIN TOOLS YOU CAN RECOMMEND (route → purpose):
- /app/seo/missing-pages → triage & redirect 404s
- /app/seo/page-auditor → audit + rewrite a single URL
- /app/seo/keyword-opportunities → import GSC queries, find easy wins
- /app/seo/internal-links → recommend internal linking
- /app/content/bulk-editor → triage published pages (tenant + legacy)
- /app/content/quick-page-builder → spin up a new /a/{slug} page in 30s
- /app/pages → manual page editor with live preview
- /app/seo/gsc-import → re-sync Search Console data
- /app/seo/competitor-tracker → scrape competitor pages
- /app/seo/link-checker → find broken internal links`;
}

const SYSTEM_PROMPT = `You are the SEO Coach embedded inside the founders.click admin panel.

Your job: walk the user through fixing real SEO problems on their site, ONE step at a time, like a Socratic mentor.

HARD RULES:
1. Ask ONE yes/no question per turn. Format every question on its own line as: **Q: <yes/no question>** then a "Why I'm asking:" sentence right under it explaining your reasoning.
2. Use the LIVE SEO SNAPSHOT to ground every suggestion in real numbers. Quote the actual count when you say something is broken.
3. Always recommend the EXACT admin route (e.g. "/app/seo/missing-pages") when telling the user where to fix something. Never invent routes — only use the ones in the snapshot's tool list.
4. After the user answers Yes or No, briefly confirm what they should do next (1-3 sentences max), then ask the NEXT yes/no question. Keep momentum.
5. If user says "just tell me what to do", give them a numbered 3-step action plan with the exact tool routes, then resume yes/no flow.
6. Prioritize impact: 404s & indexing > thin/empty published pages > meta issues > new content. Don't bury the lead.
7. Be terse, direct, founder-to-founder. No fluff, no "great question!", no banned filler words (leverage, robust, dive into, unlock, journey, seamlessly).
8. If the user is vague, ask a yes/no clarifier instead of guessing.

Your first message in a NEW chat: greet briefly, name the single most urgent issue from the snapshot with its number, then ask the first yes/no question.`;

/**
 * The conversation sent to the model: the most recent turns that fit in
 * SEO_COACH_MAX_CHARS, oldest dropped first. The schema allows 40 turns of
 * 8000 characters; the model never needs all of that, and the spend hold is
 * sized on what is actually sent.
 */
export const SEO_COACH_MAX_CHARS = 24_000;
export function trimConversation<T extends { content: string }>(
  messages: T[],
  maxChars = SEO_COACH_MAX_CHARS,
): T[] {
  const kept: T[] = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (kept.length > 0 && total + m.content.length > maxChars) break;
    kept.unshift(m);
    total += m.content.length;
  }
  return kept;
}

export const SeoCoachInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().min(1).max(8000),
          })
          .strict(),
      )
      .min(1)
      .max(40),
    completedRoutes: z.array(z.string().max(120)).max(40).optional(),
  })
  // A body carrying a model, a token count or any other key is refused.
  .strict();

export type SeoCoachInput = z.infer<typeof SeoCoachInputSchema>;
export type SeoCoachResult = { ok: true; reply: string } | { ok: false; error: string };
/** Test seams for the database and the provider transport. Production passes nothing. */
export type SeoCoachDeps = { db?: AiDb; transport?: OpenAiTransport };

/**
 * The SEO Coach is not part of launch (`launch: false` in app-nav, no launch
 * UI), so the server serves it only to a workspace holding the founder /
 * internal unlimited entitlement — hiding the link is not a gate (round-4
 * correctness M2 / security L1).
 */
export const SEO_COACH_UNAVAILABLE_MESSAGE = "The SEO Coach is not available for this workspace yet.";

/**
 * One SEO-coach turn through the one spend flow (route seo_coach: 1200
 * output tokens, 60 s, gpt-5-nano). Membership is checked first, then the
 * availability gate (internal workspaces only), both before the key is read
 * or anything is reserved; every refusal and failure comes back as
 * { ok: false, error } with a fixed customer sentence; provider and database
 * text only reach the server log.
 */
export async function runSeoCoachTurn(
  data: SeoCoachInput,
  userId: string,
  deps: SeoCoachDeps = {},
): Promise<SeoCoachResult> {
  try {
    await assertWorkspaceMember(data.workspaceId, userId);
    const { isInternalUnlimitedOrFalse } = await import("@/lib/entitlement-grants.server");
    if (!(await isInternalUnlimitedOrFalse(data.workspaceId, deps.db))) {
      return { ok: false, error: SEO_COACH_UNAVAILABLE_MESSAGE };
    }
    const { resolveAiKey, billingClassFor, runMeteredAiCall } =
      await import("@/lib/ai/spend.server");
    const key = await resolveAiKey(data.workspaceId, deps.db);

    const snapshot = await buildSnapshot(data.workspaceId);
    const completedNote = data.completedRoutes?.length
      ? `STEPS THE USER HAS ALREADY COMPLETED THIS SESSION (do NOT recommend them again — move to the next priority): ${data.completedRoutes.join(", ")}`
      : "No steps completed yet this session.";

    const res = await runMeteredAiCall({
      workspaceId: data.workspaceId,
      userId,
      requestId: crypto.randomUUID(),
      route: "seo_coach",
      source: "seo_coach",
      key,
      billingClass: billingClassFor(key, { route: "seo_coach" }),
      instructions: [SYSTEM_PROMPT, snapshot, completedNote].join("\n\n"),
      input: trimConversation(data.messages).map((m) => ({ role: m.role, content: m.content })),
      deps,
    });
    return { ok: true, reply: res.output.text.trim() };
  } catch (e) {
    const { customerMessage, AI_MESSAGES } = await import("@/lib/ai/customer-error");
    return { ok: false, error: customerMessage(e, AI_MESSAGES.unavailable) };
  }
}

export const seoCoachChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => SeoCoachInputSchema.parse(d))
  .handler(
    async ({ data, context }): Promise<SeoCoachResult> => runSeoCoachTurn(data, context.userId),
  );
