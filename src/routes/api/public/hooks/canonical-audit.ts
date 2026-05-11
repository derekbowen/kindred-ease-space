/**
 * Public cron hook for the canonical-URL audit. Called by pg_cron once a day.
 *
 * Auth: requires `apikey` header to match SUPABASE_ANON_KEY (the documented
 * pattern for `/api/public/*` endpoints). Returns a small JSON summary so
 * cron job_run_details stay readable.
 */
import { createFileRoute } from "@tanstack/react-router";
import { runFullAudit } from "@/lib/admin-canonical-audit.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/hooks/canonical-audit")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.SUPABASE_ANON_KEY;
        const provided = request.headers.get("apikey") ?? request.headers.get("x-anon-key");
        if (!expected || !provided || provided !== expected) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

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
            source: "cron",
          });
          if (error) console.error("[canonical-audit cron] insert failed:", error.message);
          if (summary.pagesWithFailures > 0) {
            console.error(
              `[canonical-audit cron] ${summary.pagesWithFailures} failing page(s) of ${summary.totalPages}`,
            );
          }
          return new Response(
            JSON.stringify({
              ok: true,
              totalPages: summary.totalPages,
              pagesWithFailures: summary.pagesWithFailures,
              pagesWithWarnings: summary.pagesWithWarnings,
              totals: summary.totals,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        } catch (err) {
          console.error("[canonical-audit cron] threw:", err);
          return new Response(
            JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      },
    },
  },
});
