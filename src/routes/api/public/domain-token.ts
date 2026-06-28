import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const sb = () => supabaseAdmin as any;

// Per-Worker-instance rate limit. NOTE: Cloudflare scales Workers
// horizontally, so each isolate keeps its own bucket — the effective limit
// at the edge is roughly `limit * <live isolate count>`. That's fine for
// dampening accidental loops and single-source enumeration of pending
// verification tokens; it is NOT a substitute for an abuse-grade limiter.
// For a hardened limit, move counters to a Durable Object or KV namespace
// keyed by IP. Until then, the 404-when-verified rule below is the real
// safety: tokens stop being readable as soon as DNS verifies.
const buckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(ip: string, limit = 120, windowMs = 60_000): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || b.resetAt < now) {
    buckets.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}


function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return request.headers.get("cf-connecting-ip") || "unknown";
}

const Query = z.object({ hostname: z.string().min(3).max(253) });

export const Route = createFileRoute("/api/public/domain-token")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const ip = clientIp(request);
        if (!rateLimit(ip)) {
          return new Response("rate_limited", { status: 429 });
        }

        const url = new URL(request.url);
        const parsed = Query.safeParse({ hostname: url.searchParams.get("hostname") ?? "" });
        if (!parsed.success) {
          return new Response("hostname required", { status: 400 });
        }
        const hostname = parsed.data.hostname
          .toLowerCase()
          .trim()
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
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex",
          },
        });
      },
    },
  },
});
