import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { tenantSitemapResponse } from "@/lib/sitemap.server";
import { clientIp, rateLimit } from "@/lib/public-rate-limit";

const Query = z.object({
  hostname: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(253)
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/),
});

// The tenant sitemap for ?hostname=, answered exactly as that host's own
// /a/sitemap.xml would be (same generator, same exact-host rule, same ?page=
// handling, same cache headers): unknown hosts 404, failed reads 503.
export const Route = createFileRoute("/api/public/sitemap-by-host")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!rateLimit("sitemap-by-host", clientIp(request), 120)) {
          return new Response("rate limited", { status: 429 });
        }
        const url = new URL(request.url);
        const parsed = Query.safeParse({ hostname: url.searchParams.get("hostname") || "" });
        if (!parsed.success) {
          return new Response("hostname required", { status: 400 });
        }
        const r = await tenantSitemapResponse(parsed.data.hostname, request.url);
        return new Response(r.body, { status: r.status, headers: r.headers });
      },
    },
  },
});
