import * as React from "react";
import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";
import { getIndexingStats, type IndexingStats } from "@/server/admin-tools.functions";

export const Route = createFileRoute("/admin/indexing")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth", search: { redirect: "/admin/indexing", mode: "signin" } });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({ meta: [{ title: "Sitemap & Indexing — Admin" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: Indexing,
});

const SITEMAPS = [
  "/sitemap.xml", "/sitemap-index.xml", "/sitemap-default.xml", "/sitemap-static.xml",
  "/sitemap-recent-pages.xml", "/sitemap-pages-cities.xml", "/sitemap-pages-articles.xml",
  "/sitemap-pages-comparisons.xml", "/sitemap-pages-academy.xml", "/sitemap-pages-money.xml",
  "/sitemap-pages-host-acquisition.xml", "/sitemap-pages-event-guides.xml",
  "/sitemap-pages-swim-instructor.xml", "/sitemap-pages-spanish.xml",
  "/sitemap-pages-advocacy.xml", "/sitemap-directory.xml", "/sitemap-hub.xml",
];

function Indexing() {
  const [s, setS] = React.useState<IndexingStats | null>(null);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => { (async () => { try { setS(await getIndexingStats()); } finally { setLoading(false); } })(); }, []);

  return (
    <AdminLayout title="Sitemap & Indexing">
      <h1 className="text-3xl font-bold">Sitemap & Indexing</h1>
      <p className="text-sm text-muted-foreground">Sitemap inventory, recent indexing activity, and unresolved 404s.</p>

      {loading && <div className="mt-8 text-center text-muted-foreground">Loading…</div>}

      {s && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-border p-4"><div className="text-xs uppercase text-muted-foreground">Published /p/*</div><div className="mt-1 text-2xl font-bold">{s.totalPublished.toLocaleString()}</div></div>
            <div className="rounded-xl border border-border p-4"><div className="text-xs uppercase text-muted-foreground">Published last 24h</div><div className="mt-1 text-2xl font-bold">{s.recentlyPublished.toLocaleString()}</div></div>
            <div className="rounded-xl border border-border p-4"><div className="text-xs uppercase text-muted-foreground">Unresolved 404s</div><div className="mt-1 text-2xl font-bold text-red-600">{s.unresolved404s.toLocaleString()}</div></div>
            <div className="rounded-xl border border-border p-4"><div className="text-xs uppercase text-muted-foreground">Sitemap files</div><div className="mt-1 text-2xl font-bold">{SITEMAPS.length}</div></div>
          </div>

          <section className="mt-8">
            <h2 className="text-xl font-semibold">Sitemaps</h2>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {SITEMAPS.map((path) => (
                <a key={path} href={path} target="_blank" rel="noreferrer"
                  className="flex items-center justify-between rounded-lg border border-border bg-card p-3 text-sm hover:bg-muted">
                  <code className="text-xs">{path}</code>
                  <span className="text-xs text-muted-foreground">Open ↗</span>
                </a>
              ))}
            </div>
          </section>

          <section className="mt-8">
            <h2 className="text-xl font-semibold">Top template types (published)</h2>
            <div className="mt-3 overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase"><tr><th className="px-3 py-2">Template</th><th className="px-3 py-2 text-right">Pages</th></tr></thead>
                <tbody>
                  {s.byTemplate.map((t) => (
                    <tr key={t.template_type || "(none)"} className="border-t border-border">
                      <td className="px-3 py-2 font-mono text-xs">{t.template_type || "(none)"}</td>
                      <td className="px-3 py-2 text-right">{t.count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-8">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">Top unresolved 404s</h2>
              <Link to="/admin/missing-pages" className="text-xs font-semibold text-primary hover:underline">Manage all 404s →</Link>
            </div>
            <div className="mt-3 overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase">
                  <tr><th className="px-3 py-2">URL</th><th className="px-3 py-2 text-right">Hits</th><th className="px-3 py-2 text-right">Last seen</th></tr>
                </thead>
                <tbody>
                  {s.recent404s.map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-3 py-2 font-mono text-xs">{r.url_path}</td>
                      <td className="px-3 py-2 text-right font-bold">{r.hit_count}</td>
                      <td className="px-3 py-2 text-right text-xs text-muted-foreground">{new Date(r.last_seen_at).toLocaleString()}</td>
                    </tr>
                  ))}
                  {s.recent404s.length === 0 && <tr><td colSpan={3} className="px-3 py-6 text-center text-muted-foreground">No unresolved 404s.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </AdminLayout>
  );
}
