import { createFileRoute } from "@tanstack/react-router";
import { listAllPublishedArticleSlugs, listCategories } from "@/lib/help.server";
import { canonicalUrl } from "@/lib/canonical";

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );
}

export const Route = createFileRoute("/help/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const [articles, categories] = await Promise.all([
            listAllPublishedArticleSlugs(),
            listCategories(),
          ]);
          const urls = [
            { loc: canonicalUrl("/help"), lastmod: new Date().toISOString() },
            ...categories.map((c) => ({ loc: canonicalUrl(`/help/${c.slug}`), lastmod: new Date().toISOString() })),
            ...articles.map((a) => ({
              loc: canonicalUrl(`/help/${a.category_slug}/${a.slug}`),
              lastmod: new Date(a.updated_at).toISOString(),
            })),
          ];
          const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${escapeXml(u.loc)}</loc><lastmod>${u.lastmod}</lastmod></url>`).join("\n")}
</urlset>`;
          return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
        } catch (e) {
          console.error("[help] sitemap", e);
          return new Response('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>', {
            headers: { "Content-Type": "application/xml; charset=utf-8" },
          });
        }
      },
    },
  },
});
