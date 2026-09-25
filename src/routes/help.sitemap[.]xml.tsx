import { createFileRoute } from "@tanstack/react-router";
import { listAllPublishedArticleSlugs, listCategories } from "@/lib/help.server";
import { canonicalUrl } from "@/lib/canonical";

/** An ISO timestamp, or undefined when the value is missing or not a date. */
function isoOrUndefined(value: string | null | undefined): string | undefined {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function escapeXml(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
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
          // Real lastmod values (round-4 release review L8: they were always
          // "now", which teaches crawlers to ignore them): an article's own
          // updated_at; a category's newest article; /help's newest overall.
          // None known → no <lastmod> at all, which the protocol allows.
          const newestByCategory = new Map<string, string>();
          let newest: string | undefined;
          const articleUrls = articles.map((a) => {
            const lastmod = isoOrUndefined(a.updated_at);
            if (lastmod) {
              const cur = newestByCategory.get(a.category_slug);
              if (!cur || lastmod > cur) newestByCategory.set(a.category_slug, lastmod);
              if (!newest || lastmod > newest) newest = lastmod;
            }
            return { loc: canonicalUrl(`/help/${a.category_slug}/${a.slug}`), lastmod };
          });
          const urls = [
            { loc: canonicalUrl("/help"), lastmod: newest },
            ...categories.map((c) => ({
              loc: canonicalUrl(`/help/${c.slug}`),
              lastmod: newestByCategory.get(c.slug),
            })),
            ...articleUrls,
          ];
          const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${escapeXml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`).join("\n")}
</urlset>`;
          return new Response(xml, {
            headers: { "Content-Type": "application/xml; charset=utf-8" },
          });
        } catch (e) {
          console.error("[help] sitemap", e);
          return new Response(
            '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>',
            {
              headers: { "Content-Type": "application/xml; charset=utf-8" },
            },
          );
        }
      },
    },
  },
});
