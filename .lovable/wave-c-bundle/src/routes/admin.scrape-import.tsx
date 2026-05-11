import * as React from "react";
import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { adminScrapeProviderUrl, adminListScrapeJobs } from "@/server/directory.functions";
import { AdminLayout } from "@/components/admin-layout";

export const Route = createFileRoute("/admin/scrape-import")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth", search: { redirect: "/admin/scrape-import", mode: "signin" } });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({ meta: [{ title: "Scrape directory URLs — Admin" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: ScrapeImport,
});

function ScrapeImport() {
  const [urls, setUrls] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState<{ done: number; total: number; last?: string }>({ done: 0, total: 0 });
  const [results, setResults] = React.useState<Array<{ url: string; ok: boolean; error?: string; providerId?: string | null; count?: number }>>([]);
  const [jobs, setJobs] = React.useState<any[]>([]);

  const refresh = React.useCallback(async () => {
    const r = await adminListScrapeJobs();
    setJobs(r.jobs);
  }, []);
  React.useEffect(() => { void refresh(); }, [refresh]);

  async function run() {
    const list = urls.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
    if (!list.length) { alert("Paste one or more URLs"); return; }
    setRunning(true);
    setProgress({ done: 0, total: list.length });
    const out: typeof results = [];
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      setProgress({ done: i, total: list.length, last: u });
      try {
        const res: any = await adminScrapeProviderUrl({ data: { url: u, autoCreate: true } });
        out.push({ url: u, ok: true, providerId: res.providerId, count: res.count ?? (res.providerId ? 1 : 0) });
      } catch (e: any) {
        out.push({ url: u, ok: false, error: e?.message || String(e) });
      }
      setResults([...out]);
    }
    setProgress({ done: list.length, total: list.length });
    setRunning(false);
    void refresh();
  }

  return (
    <AdminLayout>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Scrape directory URLs</h1>
            <p className="text-sm text-muted-foreground">Paste Yelp, Google Maps, BBB, Angi, Houzz, Thumbtack listing URLs. Each becomes a pending provider.</p>
          </div>
          <Link to="/admin/directory" className="text-sm text-primary hover:underline">← Directory</Link>
        </div>

        <div className="mt-6 rounded-2xl border border-border bg-card p-5">
          <textarea
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            placeholder={"https://www.yelp.com/biz/example\nhttps://www.google.com/maps/place/..."}
            rows={8}
            className="w-full rounded-lg border border-border bg-background p-3 font-mono text-xs"
          />
          <div className="mt-3 flex items-center gap-3">
            <button onClick={run} disabled={running}
              className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">
              {running ? `Scraping ${progress.done}/${progress.total}…` : "Scrape & create pending providers"}
            </button>
            {progress.last && running && <span className="truncate text-xs text-muted-foreground">{progress.last}</span>}
          </div>
        </div>

        {results.length > 0 && (
          <section className="mt-6">
            <h2 className="text-lg font-semibold">Run results</h2>
            <ul className="mt-3 space-y-1.5 text-sm">
              {results.map((r) => (
                <li key={r.url} className="flex items-start gap-2">
                  <span className={r.ok ? "text-green-600" : "text-red-600"}>{r.ok ? "✓" : "✗"}</span>
                  <span className="truncate">{r.url}</span>
                  {r.ok && <span className="text-xs text-muted-foreground">— {r.count ?? 0} provider{(r.count ?? 0) === 1 ? "" : "s"}</span>}
                  {r.error && <span className="text-xs text-red-600">— {r.error}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mt-8">
          <h2 className="text-lg font-semibold">Recent scrape jobs</h2>
          <ul className="mt-3 divide-y divide-border rounded-2xl border border-border bg-card">
            {jobs.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center gap-3 p-3 text-xs">
                <span className={`rounded-full px-2 py-0.5 font-bold uppercase ${j.status === "success" ? "bg-green-500/15 text-green-700" : j.status === "failed" ? "bg-red-500/15 text-red-700" : "bg-yellow-500/15 text-yellow-700"}`}>{j.status}</span>
                <span className="text-muted-foreground">{j.source_type}</span>
                <span className="truncate flex-1">{j.source_url}</span>
                <span className="text-muted-foreground">{new Date(j.created_at).toLocaleString()}</span>
                {j.error && <span className="basis-full text-red-600">{j.error}</span>}
              </li>
            ))}
            {jobs.length === 0 && <li className="p-4 text-sm text-muted-foreground">No jobs yet.</li>}
          </ul>
        </section>
      </AdminLayout>
  );
}
