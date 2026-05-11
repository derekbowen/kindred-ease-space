import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const sb = () => supabaseAdmin as any;

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );
}

function emptySitemapResponse(status = 200): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;
  return new Response(xml, {
    status,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

export const Route = createFileRoute("/api/public/sitemap-by-host")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const raw = (url.searchParams.get("hostname") || "").toLowerCase().trim();
        const hostname = raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
        if (!hostname || !hostname.includes(".")) {
          return new Response("hostname required", { status: 400 });
        }

        const { data: domain } = await sb()
          .from("workspace_domains")
          .select("workspace_id")
          .eq("hostname", hostname)
          .eq("verified", true)
          .maybeSingle();
        if (!domain) return new Response("not found", { status: 404 });

        const { data: pages } = await sb()
          .from("content_pages")
          .select("slug, updated_at")
          .eq("workspace_id", domain.workspace_id)
          .eq("status", "published")
          .eq("in_sitemap", true)
          .order("updated_at", { ascending: false })
          .limit(50_000);

        const rows = pages || [];
        if (rows.length === 0) return emptySitemapResponse();

        const urls = rows
          .map((p: any) => {
            const slug = String(p.slug || "").replace(/^\/+/, "");
            const loc = `https://${hostname}/p/${escapeXml(slug)}`;
            const lastmod = p.updated_at ? new Date(p.updated_at).toISOString() : new Date().toISOString();
            return `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod></url>`;
          })
          .join("\n");

        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
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
