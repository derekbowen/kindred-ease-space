/**
 * Public cron hook for the canonical-URL audit. Called by pg_cron once a day.
 *
 * Auth: requires `Authorization: Bearer <CRON_SECRET>` (also accepts the legacy
 * `apikey`/`x-cron-secret` headers for migration convenience). The previous
 * implementation accepted SUPABASE_ANON_KEY, which is embedded in the public
 * client bundle — anyone could trigger up to 200 outbound fetches per call.
 */
import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";
import { runFullAudit } from "@/lib/admin-canonical-audit.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const Route = createFileRoute("/api/public/hooks/canonical-audit")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.CRON_SECRET;
        const authHeader = request.headers.get("authorization") ?? "";
        const bearer = authHeader.toLowerCase().startsWith("bearer ")
          ? authHeader.slice(7).trim()
          : "";
        const provided =
          bearer ||
          request.headers.get("x-cron-secret") ||
          request.headers.get("apikey") ||
          "";
        if (!expected || !provided || !safeEqual(provided, expected)) {
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
