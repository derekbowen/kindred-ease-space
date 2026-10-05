import { createFileRoute } from "@tanstack/react-router";
import { canonicalUrl } from "@/lib/canonical";
import { BUILD_TIME } from "@/lib/build-info";
import { STORE_TEMPLATES } from "@/lib/template-store";
import { SITEMAP_VARY, servesPlatformSitemap } from "@/lib/sitemap.server";

// Only public, indexable routes. Auth pages (/login, /signup, /reset-password)
// are intentionally excluded — they're Disallow'd in robots.txt.
const ROUTES = [
  "/",
  "/help",
  "/privacy",
  "/terms",
  "/beta",
  "/sharetribe-templates",
  "/magic-designs",
  ...STORE_TEMPLATES.map((t) => `/sharetribe-templates/${t.slug}`),
];

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // The platform sitemap, on the platform hosts only. A customer's
        // /sitemap.xml belongs to their own site (the edge never forwards it
        // here); the sitemap we generate for them lives at /a/sitemap.xml.
        // Any other host is a 404 — never the platform's URLs on a customer's
        // domain, never a customer's pages on /sitemap.xml.
        const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "";
        if (!servesPlatformSitemap(host)) {
          return new Response("not found", {
            status: 404,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
              Vary: SITEMAP_VARY,
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
          headers: { "Content-Type": "application/xml; charset=utf-8", Vary: SITEMAP_VARY },
        });
      },
    },
  },
});
