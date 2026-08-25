import { createFileRoute } from "@tanstack/react-router";
import { tenantSitemapXml } from "@/lib/sitemap.server";

export const Route = createFileRoute("/api/public/sitemap-by-host")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const hostname = url.searchParams.get("hostname") || "";
        if (!hostname.includes(".")) {
          return new Response("hostname required", { status: 400 });
        }
        const xml = await tenantSitemapXml(hostname);
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
