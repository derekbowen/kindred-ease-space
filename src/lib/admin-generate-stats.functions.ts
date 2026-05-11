import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertWorkspaceMember, workspaceIdSchema } from "@/lib/admin-helpers.functions";

export type GenStats = {
  ok: boolean;
  totals: { generated: number; pending: number; paused: number; total: number };
  pendingByTier: Array<{ tier: string; n: number }>;
  pausedByTier: Array<{ tier: string; n: number }>;
  topPausedReasons: Array<{ reason: string; n: number }>;
  recentInserts: Array<{ slug: string; title: string | null; created_at: string }>;
  recentErrors: Array<{
    slug: string;
    tier: string | null;
    updated_at: string;
    error: string;
    status: string;
  }>;
  perDay: Array<{ day: string; n: number }>;
  error?: string;
};

const EMPTY: Omit<GenStats, "ok" | "error"> = {
  totals: { generated: 0, pending: 0, paused: 0, total: 0 },
  pendingByTier: [],
  pausedByTier: [],
  topPausedReasons: [],
  recentInserts: [],
  recentErrors: [],
  perDay: [],
};

function bucketReason(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("faq")) return "Missing required FAQ count";
  if (s.includes("section")) return "Missing required section";
  if (s.includes("too short") || s.includes("words, need")) return "Output too short";
  if (s.includes("internal links")) return "Missing internal links";
  if (s.includes("ai gateway") || s.includes("rate limit") || s.includes("429"))
    return "AI gateway error / rate limit";
  if (s.includes("timeout") || s.includes("aborted")) return "Timeout";
  if (s.includes("ai did not return")) return "Empty AI response";
  return "Other";
}

export const getGenerateStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: workspaceIdSchema }).parse(d),
  )
  .handler(async ({ data, context }): Promise<GenStats> => {
    const workspaceId = data.workspaceId;
    try {
      await assertWorkspaceMember(workspaceId, (context as any).userId);
    } catch (e) {
      return { ok: false, ...EMPTY, error: e instanceof Error ? e.message : "forbidden" };
    }

    try {
      const [genCount, pendCount, pausedCount, allPending, allPaused, recentPages, recentErr] =
        await Promise.all([
          supabaseAdmin.from("content_plan").select("*", { count: "exact", head: true })
            .eq("workspace_id", workspaceId).eq("status", "generated"),
          supabaseAdmin.from("content_plan").select("*", { count: "exact", head: true })
            .eq("workspace_id", workspaceId).eq("status", "pending"),
          supabaseAdmin.from("content_plan").select("*", { count: "exact", head: true })
            .eq("workspace_id", workspaceId).eq("status", "paused"),
          supabaseAdmin.from("content_plan").select("priority_tier")
            .eq("workspace_id", workspaceId).eq("status", "pending").limit(2000),
          supabaseAdmin.from("content_plan").select("priority_tier,last_error")
            .eq("workspace_id", workspaceId).eq("status", "paused").limit(2000),
          supabaseAdmin.from("content_pages").select("slug,title,created_at")
            .eq("workspace_id", workspaceId)
            .order("created_at", { ascending: false }).limit(20),
          supabaseAdmin.from("content_plan").select("slug,priority_tier,updated_at,last_error,status")
            .eq("workspace_id", workspaceId)
            .in("status", ["pending", "paused"])
            .not("last_error", "is", null)
            .order("updated_at", { ascending: false }).limit(15),
        ]);

      const tally = (rows: Array<Record<string, unknown>>, key: string, fallback: string) => {
        const m = new Map<string, number>();
        for (const r of rows) {
          const v = (r[key] as string | null) ?? fallback;
          m.set(v, (m.get(v) ?? 0) + 1);
        }
        return Array.from(m.entries())
          .map(([tier, n]) => ({ tier, n }))
          .sort((a, b) => b.n - a.n);
      };

      const pendingByTier = tally(allPending.data ?? [], "priority_tier", "untiered");
      const pausedByTier = tally(allPaused.data ?? [], "priority_tier", "untiered");

      const reasonMap = new Map<string, number>();
      for (const r of allPaused.data ?? []) {
        const raw = (r.last_error as string | null) ?? "";
        const bucket = raw ? bucketReason(raw) : "Unknown";
        reasonMap.set(bucket, (reasonMap.get(bucket) ?? 0) + 1);
      }
      const topPausedReasons = Array.from(reasonMap.entries())
        .map(([reason, n]) => ({ reason, n }))
        .sort((a, b) => b.n - a.n)
        .slice(0, 6);

      const since = new Date(Date.now() - 14 * 86400_000).toISOString();
      const { data: dayRows } = await supabaseAdmin
        .from("content_pages")
        .select("created_at")
        .eq("workspace_id", workspaceId)
        .gte("created_at", since)
        .limit(10000);
      const dayMap = new Map<string, number>();
      for (const r of dayRows ?? []) {
        const d = new Date(r.created_at as string).toISOString().slice(0, 10);
        dayMap.set(d, (dayMap.get(d) ?? 0) + 1);
      }
      const perDay = Array.from(dayMap.entries())
        .map(([day, n]) => ({ day, n }))
        .sort((a, b) => (a.day < b.day ? -1 : 1));

      const generated = genCount.count ?? 0;
      const pending = pendCount.count ?? 0;
      const paused = pausedCount.count ?? 0;

      return {
        ok: true,
        totals: { generated, pending, paused, total: generated + pending + paused },
        pendingByTier,
        pausedByTier,
        topPausedReasons,
        recentInserts: (recentPages.data ?? []).map((r) => ({
          slug: r.slug as string,
          title: (r.title as string | null) ?? null,
          created_at: r.created_at as string,
        })),
        recentErrors: (recentErr.data ?? []).map((r) => ({
          slug: r.slug as string,
          tier: (r.priority_tier as string | null) ?? null,
          updated_at: r.updated_at as string,
          error: ((r.last_error as string | null) ?? "").slice(0, 240),
          status: (r.status as string | null) ?? "pending",
        })),
        perDay,
      };
    } catch (e) {
      return { ok: false, ...EMPTY, error: e instanceof Error ? e.message : String(e) };
    }
  });
