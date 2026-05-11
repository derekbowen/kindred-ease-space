// Public cron hook that runs Sharetribe sync for all connected workspaces.
// Auth: pg_cron passes the Supabase anon key in the `apikey` header. The
// /api/public/* prefix already bypasses platform auth; we re-check the
// header so external callers without it are rejected.

import { createFileRoute } from "@tanstack/react-router";
import { runSharetribeSyncAll, runSharetribeSyncForWorkspace } from "@/lib/sharetribe-sync.server";

export const Route = createFileRoute("/api/public/hooks/sync-sharetribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = request.headers.get("apikey");
        const expected = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
        if (!apiKey || !expected || apiKey !== expected) {
          return new Response("unauthorized", { status: 401 });
        }

        let body: { workspace_id?: string } = {};
        try {
          body = (await request.json()) as { workspace_id?: string };
        } catch {
          /* empty body OK */
        }

        try {
          if (body.workspace_id) {
            const r = await runSharetribeSyncForWorkspace(body.workspace_id);
            return Response.json({ scope: "single", ok: true, ...r });
          }
          const r = await runSharetribeSyncAll();
          return Response.json({ scope: "all", success: true, ...r });
        } catch (e) {
          console.error("[sync-sharetribe] failed", e);
          return Response.json(
            { ok: false, error: e instanceof Error ? e.message : "sync_failed" },
            { status: 500 },
          );
        }
      },
    },
  },
});
