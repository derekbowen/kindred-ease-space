import { createFileRoute } from "@tanstack/react-router";
import { tenantSitemapResponse } from "@/lib/sitemap.server";

// The tenant sitemap, under the /a/ prefix. On a connected customer domain the
// Founders edge controls only /a/* — the customer's own site keeps its
// /sitemap.xml and robots.txt — so this is the URL an owner references from
// their robots.txt or submits in Search Console:
// https://<their verified hostname>/a/sitemap.xml
//
// Served only on the exact verified hostname (www. is a different host); any
// other host, the platform's included, gets 404. Above one file's limits it is
// a sitemap index of /a/sitemap.xml?page=N; a page that does not exist is 404.
// Cached for five minutes (see SITEMAP_CACHE_SECONDS); a read that failed is a
// 503, never a shorter sitemap.
export const Route = createFileRoute("/a/sitemap.xml")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "";
        const r = await tenantSitemapResponse(host, request.url);
        return new Response(r.body, { status: r.status, headers: r.headers });
      },
    },
  },
});
