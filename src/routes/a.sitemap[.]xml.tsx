import { createFileRoute } from "@tanstack/react-router";
import { tenantSitemapXml } from "@/lib/sitemap.server";

// Tenant sitemap under the /a/ prefix. On a root-domain connection the
// Founders edge only controls /a/* — the customer's own site owns
// /sitemap.xml — so this is the sitemap URL customers submit to Search
// Console: https://customer.com/a/sitemap.xml
export const Route = createFileRoute("/a/sitemap.xml")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "";
        const tenant = await tenantSitemapXml(host);
        if (!tenant) {
          return new Response("not found", { status: 404 });
        }
        return new Response(tenant, {
          headers: {
            "Content-Type": "application/xml; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
