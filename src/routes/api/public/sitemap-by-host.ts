import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { tenantSitemapXml } from "@/lib/sitemap.server";
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
        const xml = await tenantSitemapXml(parsed.data.hostname);
        if (xml === null) return new Response("not found", { status: 404 });
        return new Response(xml, {
          headers: {
            "Content-Type": "application/xml; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
