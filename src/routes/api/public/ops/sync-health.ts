/**
 * SYNC HEALTH — did the scheduled Sharetribe sync actually run?
 *
 * The failure this exists to end: production's Worker had no CRON_SECRET, so
 * pg_cron's every-30-minute POST to /api/public/hooks/sync-sharetribe returned
 * `500 server misconfigured` and did nothing. Meanwhile the welcome email kept
 * telling customers their listings sync automatically every 30 minutes. The
 * sync writes a good durable record on every run, but only an authenticated
 * session could read it, so a run that never happened left no trace an
 * operator would ever see.
 *
 * ON THE GATE. Access is by OPS_PROBE_SECRET, the shared secret dedicated to
 * the ops probes (src/lib/ops-probe-auth.ts), deliberately NOT CRON_SECRET:
 * gating the diagnostic behind the very credential whose absence it reports
 * would make it useless in exactly the outage it is for. It is no longer
 * SEND_EMAIL_HOOK_SECRET either — that is the key Auth signs the send-email
 * hook with, and a signing key must never travel as a plaintext bearer token.
 * One ops credential opens both diagnostics, compared in constant time, with
 * byte-identical rejections so this cannot become an oracle for whether that
 * secret is set.
 *
 * Read-only. No sync is triggered, nothing is written, and no customer content
 * is returned — workspace ids, timestamps, counts and the sync's own recorded
 * error strings only.
 */
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { opsProbeAuthorised } from "@/lib/ops-probe-auth";
import { assessSyncHealth, type IntegrationRow } from "@/lib/sync-health";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/ops/sync-health")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!opsProbeAuthorised(request)) {
          // Identical for "no secret configured" and "wrong secret".
          return json({ error: "unauthorized" }, 401);
        }

        let rows: IntegrationRow[] = [];
        let readError: string | null = null;
        try {
          const { data, error } = await (supabaseAdmin as any)
            .from("tenant_integrations")
            .select(
              "workspace_id, status, last_sync_at, last_sync_status, last_sync_error, listings_count",
            )
            .eq("provider", "sharetribe");
          if (error) throw new Error(error.message);
          rows = (data ?? []) as IntegrationRow[];
        } catch (err) {
          readError = err instanceof Error ? err.message : String(err);
        }

        if (readError) {
          // A read failure is its own state. Reporting "0 workspaces, healthy"
          // because the query broke is the same class of lie this endpoint
          // exists to prevent.
          return json(
            {
              probe: "sync-health",
              verdict: "unknown",
              error: `Could not read tenant_integrations: ${readError}`,
              cronSecretConfigured: Boolean(process.env.CRON_SECRET),
            },
            503,
          );
        }

        const report = assessSyncHealth(rows, {
          now: new Date(),
          // Presence only — never the value.
          cronSecretConfigured: Boolean(process.env.CRON_SECRET),
        });

        return json({
          probe: "sync-health",
          ...report,
          hint:
            report.verdict === "healthy"
              ? undefined
              : "POST /api/public/hooks/sync-sharetribe with Authorization: Bearer <CRON_SECRET> " +
                "to run a sync by hand. A 500 there means the Worker has no CRON_SECRET.",
        });
      },
    },
  },
});
