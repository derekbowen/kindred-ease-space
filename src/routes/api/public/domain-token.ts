import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const sb = () => supabaseAdmin as any;

export const Route = createFileRoute("/api/public/domain-token")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const raw = (url.searchParams.get("hostname") || "").toLowerCase().trim();
        const hostname = raw
          .replace(/^https?:\/\//, "")
          .replace(/\/.*$/, "")
          .replace(/:\d+$/, "")
          .replace(/^www\./, "");
        if (!hostname || !hostname.includes(".")) {
          return new Response("hostname required", { status: 400 });
        }

        // Only return tokens for unverified domains. Verified domains have no
        // reason to expose their token — verification is one-shot.
        const { data: row } = await sb()
          .from("workspace_domains")
          .select("verification_token, verified")
          .eq("hostname", hostname)
          .maybeSingle();

        if (!row || row.verified) {
          return new Response("not found", { status: 404 });
        }

        return new Response(String(row.verification_token || ""), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "public, max-age=60",
            "X-Robots-Tag": "noindex",
          },
        });
      },
    },
  },
});
