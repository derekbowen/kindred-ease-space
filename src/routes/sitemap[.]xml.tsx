import { createFileRoute } from "@tanstack/react-router";
import { canonicalUrl } from "@/lib/canonical";
import { BUILD_TIME } from "@/lib/build-info";
import { sitemapPageParam, tenantSitemapXml } from "@/lib/sitemap.server";

// Only public, indexable routes. Auth pages (/login, /signup, /reset-password)
// are intentionally excluded — they're Disallow'd in robots.txt.
const ROUTES = ["/", "/help", "/privacy", "/terms", "/beta"];

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Host-aware: on a verified tenant custom domain, /sitemap.xml serves that
        // tenant's published pSEO pages so Google (and Search Console) discovers
        // them on the customer's own domain. On the platform host it serves the
        // marketing sitemap.
        const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "";
        // A tenant's index (above 50,000 URLs) names /a/sitemap.xml?page=N;
        // the same pages answer here on hosts that route /sitemap.xml to us.
        const page = sitemapPageParam(request.url);
        const tenant = await tenantSitemapXml(host, { page: page ?? undefined });
        if (tenant) {
          return new Response(tenant, {
            headers: {
              "Content-Type": "application/xml; charset=utf-8",
              "Cache-Control": "public, max-age=3600",
            },
          });
        }

        // These pages change only when a new build ships, so their lastmod is
        // the build's date — not "today" on every fetch, which taught
        // crawlers to ignore it (round-4 release review L8). Dev builds have
        // no build time and fall back to today.
        const built = Date.parse(BUILD_TIME);
        const lastmod = (Number.isFinite(built) ? new Date(built) : new Date())
          .toISOString()
          .split("T")[0];
        const urls = ROUTES.map(
          (path) =>
            `  <url><loc>${canonicalUrl(path)}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>${path === "/" ? "1.0" : "0.5"}</priority></url>`,
        ).join("\n");
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
        return new Response(xml, {
          headers: { "Content-Type": "application/xml; charset=utf-8" },
        });
      },
    },
  },
});
