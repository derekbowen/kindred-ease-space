// Public cron hook that runs the Sharetribe sync.
//   * body {workspace_id} — sync that one workspace (a UUID, or 400). This is
//     what the pg_cron fan-out (enqueue_sharetribe_syncs) calls, once per
//     connected workspace, so each Worker request does one tenant's worth of
//     subrequests.
//   * no body — safety-net mode: sync at most SYNC_ALL_BATCH_LIMIT workspaces,
//     oldest last_sync_at first, and report which ran and how each ended.
//     Never the whole fleet; a single request has a bounded subrequest budget.
// Replies carry statuses and reason CODES only — never raw error text. A
// failed run answers 500 (and the bounded mode's `success` is false unless
// every run it started did not fail), so the fan-out's response log is honest.
// Auth: caller must present `Authorization: Bearer ${CRON_SECRET}`. The
// /api/public/* prefix already bypasses platform auth; the anon key is NOT
// a secret (it ships to every browser), so previously requiring `apikey:
// <anon>` let anyone trigger full-tenant syncs. Use a shared secret instead.

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  runSharetribeSyncBounded,
  runSharetribeSyncForWorkspace,
  SYNC_ALL_BATCH_LIMIT,
} from "@/lib/sharetribe-sync.server";
import { checkListingLinksIfNeverChecked } from "@/lib/marketplace/certification.server";
import { secretsMatch } from "@/lib/secret-compare";

const workspaceIdSchema = z.string().uuid();

export const Route = createFileRoute("/api/public/hooks/sync-sharetribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.CRON_SECRET;
        if (!expected) {
          console.error("[sync-sharetribe] CRON_SECRET not configured");
          return new Response("server misconfigured", { status: 500 });
        }
        const auth = request.headers.get("authorization") ?? "";
        const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const presented = bearer || request.headers.get("x-cron-secret") || "";
        // Constant time, digest-based (src/lib/secret-compare.ts).
        if (!secretsMatch(presented, expected)) {
          return new Response("unauthorized", { status: 401 });
        }

        // An empty body is the bounded mode; anything else must be a JSON object.
        let body: Record<string, unknown> = {};
        const text = await request.text().catch(() => "");
        if (text.trim()) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            return Response.json({ ok: false, error: "invalid_body" }, { status: 400 });
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return Response.json({ ok: false, error: "invalid_body" }, { status: 400 });
          }
          body = parsed as Record<string, unknown>;
        }

        try {
          if (body.workspace_id !== undefined) {
            const id = workspaceIdSchema.safeParse(body.workspace_id);
            if (!id.success) {
              return Response.json(
                { scope: "single", ok: false, error: "invalid_workspace_id" },
                { status: 400 },
              );
            }
            const r = await runSharetribeSyncForWorkspace(id.data);
            if (r.status === "success") await checkListingLinksIfNeverChecked(id.data);
            const failed = r.status === "failed";
            return Response.json(
              {
                scope: "single",
                workspace_id: id.data,
                ok: !failed && r.status !== "not_connected",
                status: r.status,
                reason: r.reason,
                upserted: r.upserted,
                removed: r.removed,
                listings_count: r.listingsCount,
                upstream_total: r.upstreamTotal,
              },
              { status: failed ? 500 : r.status === "not_connected" ? 404 : 200 },
            );
          }
          const r = await runSharetribeSyncBounded(SYNC_ALL_BATCH_LIMIT);
          const success = !r.readFailed && r.failed === 0;
          return Response.json(
            {
              scope: "all",
              success,
              ok: success,
              eligible: r.eligible,
              limit: r.limit,
              ran: r.ran,
              succeeded: r.succeeded,
              failed: r.failed,
              read_failed: r.readFailed,
            },
            { status: success ? 200 : 500 },
          );
        } catch (e) {
          console.error("[sync-sharetribe] failed", e instanceof Error ? e.message : e);
          return Response.json({ ok: false, error: "sync_failed" }, { status: 500 });
        }
      },
    },
  },
});
