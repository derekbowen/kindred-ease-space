import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runFullAudit, type AuditRunSummary } from "./admin-canonical-audit.server";

// This tool crawls the live platform site (up to 200 outbound fetches) and reads
// a global, non-tenant audit table — so it's platform-admin only, not per-tenant.
async function assertAdmin(userId: string) {
  const { data, error } = await supabaseAdmin.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error || !data) throw new Error("Forbidden — platform admin only");
}

const EMPTY_SUMMARY: AuditRunSummary = {
  startedAt: new Date(0).toISOString(),
  finishedAt: new Date(0).toISOString(),
  totalPages: 0,
  pagesWithFailures: 0,
  pagesWithWarnings: 0,
  totals: { canonical: 0, apex: 0, preview: 0, external: 0 },
  pages: [],
};

/** Trigger a fresh audit. Stores the result and returns it. */
export const runCanonicalAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AuditRunSummary> => {
    await assertAdmin(context.userId);
    try {
      const summary = await runFullAudit();
      const { error } = await supabaseAdmin.from("canonical_audit_runs").insert({
        started_at: summary.startedAt,
        finished_at: summary.finishedAt,
        total_pages: summary.totalPages,
        pages_with_failures: summary.pagesWithFailures,
        pages_with_warnings: summary.pagesWithWarnings,
        totals: summary.totals,
        pages: summary.pages,
      });
      if (error) console.error("[canonical-audit] insert failed:", error.message);
      return summary;
    } catch (err) {
      console.error("[canonical-audit] run failed:", err);
      return { ...EMPTY_SUMMARY, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    }
  });

/** Most recent stored audit run, or an empty summary. */
export const getLatestCanonicalAudit = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AuditRunSummary> => {
    await assertAdmin(context.userId);
    try {
      const { data, error } = await supabaseAdmin
        .from("canonical_audit_runs")
        .select("started_at, finished_at, total_pages, pages_with_failures, pages_with_warnings, totals, pages")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        console.error("[canonical-audit] fetch failed:", error.message);
        return EMPTY_SUMMARY;
      }
      if (!data) return EMPTY_SUMMARY;
      return {
        startedAt: data.started_at as string,
        finishedAt: data.finished_at as string,
        totalPages: data.total_pages as number,
        pagesWithFailures: data.pages_with_failures as number,
        pagesWithWarnings: data.pages_with_warnings as number,
        totals: (data.totals as AuditRunSummary["totals"]) ?? EMPTY_SUMMARY.totals,
        pages: (data.pages as AuditRunSummary["pages"]) ?? [],
      };
    } catch (err) {
      console.error("[canonical-audit] fetch threw:", err);
      return EMPTY_SUMMARY;
    }
  });
