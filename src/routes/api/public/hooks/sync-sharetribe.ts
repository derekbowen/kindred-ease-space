// Public cron hook that runs Sharetribe sync for all connected workspaces.
// Auth: caller must present `Authorization: Bearer ${CRON_SECRET}`. The
// /api/public/* prefix already bypasses platform auth; the anon key is NOT
// a secret (it ships to every browser), so previously requiring `apikey:
// <anon>` let anyone trigger full-tenant syncs. Use a shared secret instead.

import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";
import { runSharetribeSyncAll, runSharetribeSyncForWorkspace } from "@/lib/sharetribe-sync.server";

function safeEqual(a: string, b: string): boolean {
  // Pad both sides to the longer length to keep the compare timing-safe
  // regardless of input shape, then constant-time compare.
  const len = Math.max(a.length, b.length);
  const aBuf = Buffer.alloc(len);
  const bBuf = Buffer.alloc(len);
  aBuf.write(a);
  bBuf.write(b);
  return a.length === b.length && timingSafeEqual(aBuf, bBuf);
}

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
        const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!presented || !safeEqual(presented, expected)) {
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
