import * as React from "react";
import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import {
  importGscQueries,
  findKeywordOpportunities,
  getKeywordStats,
  type KeywordRow,
} from "@/server/admin-seo-tools.functions";
import { aiFixContentPage } from "@/server/admin-tools.functions";
import { AdminLayout } from "@/components/admin-layout";
import { Search, TrendingUp, Sparkles, Upload, Loader2 } from "lucide-react";

export const Route = createFileRoute("/admin/keyword-opportunities")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth", search: { redirect: "/admin/keyword-opportunities", mode: "signin" } });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({ meta: [{ title: "Keyword opportunities — Admin" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: KeywordOpportunities,
});

type ParsedRow = { url_path: string; query: string; clicks: number; impressions: number; ctr: number | null; position: number | null };

function parseGscCsv(csv: string): ParsedRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = lines[0].includes("\t") ? "\t" : ",";
  const header = lines[0].toLowerCase().split(sep).map((h) => h.trim().replace(/^"|"$/g, ""));
  const idx = {
    page: header.findIndex((h) => h === "page" || h === "url" || h.includes("landing page") || h.includes("top page")),
    query: header.findIndex((h) => h.includes("quer") || h.includes("search term") || h.includes("keyword")),
    impr: header.findIndex((h) => h.includes("impression")),
    clicks: header.findIndex((h) => h.includes("click")),
    pos: header.findIndex((h) => h.includes("position")),
    ctr: header.findIndex((h) => h.includes("ctr")),
  };
  if (idx.query < 0 || idx.impr < 0) return [];
  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(sep === "\t" ? "\t" : /,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.trim().replace(/^"|"$/g, ""));
    const rawUrl = idx.page >= 0 ? cells[idx.page] : "";
    let url_path = "";
    try {
      url_path = rawUrl.startsWith("http") ? new URL(rawUrl).pathname : rawUrl;
    } catch { url_path = rawUrl; }
    const query = cells[idx.query] || "";
    if (!query) continue;
    rows.push({
      url_path: url_path || "(unknown)",
      query,
      clicks: idx.clicks >= 0 ? Number(cells[idx.clicks]?.replace(/[,]/g, "")) || 0 : 0,
      impressions: Number(cells[idx.impr]?.replace(/[,]/g, "")) || 0,
      ctr: idx.ctr >= 0 ? (Number(cells[idx.ctr]?.replace(/[%,]/g, "")) || 0) / 100 : null,
      position: idx.pos >= 0 ? Number(cells[idx.pos]?.replace(/[,]/g, "")) || null : null,
    });
  }
  return rows;
}

function KeywordOpportunities() {
  const [csv, setCsv] = React.useState("");
  const [importing, setImporting] = React.useState(false);
  const [importResult, setImportResult] = React.useState<string | null>(null);
  const [stats, setStats] = React.useState<{ totalQueries: number; opportunities: number; top3: number } | null>(null);
  const [rows, setRows] = React.useState<KeywordRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [filters, setFilters] = React.useState({ minPosition: 5, maxPosition: 20, minImpressions: 50, pathLike: "" });
  const [fixing, setFixing] = React.useState<string | null>(null);
  const [fixResults, setFixResults] = React.useState<Record<string, string>>({});

  const loadStats = React.useCallback(async () => {
    try { setStats(await getKeywordStats()); } catch { /* noop */ }
  }, []);

  const loadRows = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await findKeywordOpportunities({ data: { ...filters, limit: 200 } });
      setRows(r.rows);
    } finally { setLoading(false); }
  }, [filters]);

  React.useEffect(() => { loadStats(); loadRows(); }, [loadStats, loadRows]);

  async function handleImport() {
    const parsed = parseGscCsv(csv);
    if (!parsed.length) { setImportResult("Could not parse CSV. Need a header row with at least Query and Impressions columns (Page, Clicks, Position, CTR optional)."); return; }
    const hasPage = parsed.some((r) => r.url_path && r.url_path !== "(unknown)");
    setImporting(true);
    try {
      const r = await importGscQueries({ data: { rows: parsed } });
      const pageWarn = hasPage ? "" : " ⚠️ No Page column detected — keywords imported but can't be mapped to pages. In GSC, export from Performance → Pages tab (or Queries with 'Page' filter applied) to enable AI rewrite.";
      setImportResult(r.ok ? `Imported ${r.upserted} of ${r.total} queries.${pageWarn}` : `Error: ${(r as any).error}`);
      await loadStats();
      await loadRows();
    } catch (e: any) {
      setImportResult(`Error: ${e?.message || "import failed"}`);
    } finally { setImporting(false); }
  }

  async function handleAiFix(pageId: string) {
    setFixing(pageId);
    try {
      const r: any = await aiFixContentPage({ data: { id: pageId, mode: "full" } });
      setFixResults((p) => ({ ...p, [pageId]: r.ok ? `✓ Rewritten (${r.newWords} words)` : `Error: ${r.error}` }));
    } catch (e: any) {
      setFixResults((p) => ({ ...p, [pageId]: `Error: ${e?.message || "failed"}` }));
    } finally { setFixing(null); }
  }

  // Group rows by url_path for the optimization view
  const grouped = React.useMemo(() => {
    const map = new Map<string, KeywordRow[]>();
    for (const r of rows) {
      if (!map.has(r.url_path)) map.set(r.url_path, []);
      map.get(r.url_path)!.push(r);
    }
    return Array.from(map.entries())
      .map(([url_path, queries]) => ({
        url_path,
        queries: queries.sort((a, b) => b.impressions - a.impressions),
        totalImpressions: queries.reduce((s, q) => s + q.impressions, 0),
        totalClicks: queries.reduce((s, q) => s + q.clicks, 0),
        avgPosition: queries.reduce((s, q) => s + (q.position || 0), 0) / queries.length,
      }))
      .sort((a, b) => b.totalImpressions - a.totalImpressions);
  }, [rows]);

  return (
    <AdminLayout title="Keyword opportunities">
      <div className="mb-4">
        <h1 className="text-2xl font-bold sm:text-3xl">Keyword opportunities</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Find queries where you rank on page 2 (positions 5-20) — these are quick wins. Import GSC queries, then one-click rewrite the page with AI.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Total queries tracked" value={stats?.totalQueries ?? "—"} icon={Search} />
        <StatCard label="Opportunities (pos 5-20)" value={stats?.opportunities ?? "—"} icon={TrendingUp} highlight />
        <StatCard label="Already in top 3" value={stats?.top3 ?? "—"} icon={Sparkles} />
      </div>

      <details open className="mt-6 rounded-2xl border border-border bg-card p-4">
        <summary className="cursor-pointer text-sm font-semibold">
          <Upload className="mr-2 inline h-4 w-4" /> Import GSC queries (Performance → Queries → Export → CSV)
        </summary>
        <div className="mt-3 space-y-3">
          <div className="rounded-lg border-2 border-dashed border-border bg-muted/30 p-4 text-center">
            <input
              id="gsc-csv-file"
              type="file"
              accept=".csv,.tsv,text/csv,text/tab-separated-values,text/plain"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const text = await file.text();
                setCsv(text);
                setImportResult(`Loaded ${file.name} (${(file.size / 1024).toFixed(1)} KB) — click Import to upload.`);
                e.target.value = "";
              }}
            />
            <label htmlFor="gsc-csv-file"
              className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-secondary px-5 py-2 text-sm font-semibold hover:bg-secondary/80">
              <Upload className="h-4 w-4" /> Choose CSV file
            </label>
            <p className="mt-2 text-xs text-muted-foreground">
              Or paste CSV/TSV content into the box below. Accepts the GSC "Queries" export with columns
              <span className="mx-1 font-mono">Page, Query, Clicks, Impressions, CTR, Position</span>.
            </p>
          </div>
          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder="Page,Query,Clicks,Impressions,CTR,Position"
            rows={6}
            className="w-full rounded-lg border border-border bg-background p-3 font-mono text-xs"
          />
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={handleImport} disabled={importing || !csv.trim()}
              className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">
              {importing && <Loader2 className="h-4 w-4 animate-spin" />}
              {importing ? "Importing…" : "Import"}
            </button>
            {csv.trim() && (
              <button onClick={() => { setCsv(""); setImportResult(null); }}
                className="rounded-full border border-border px-4 py-2 text-xs">Clear</button>
            )}
            {importResult && <span className="text-xs text-muted-foreground">{importResult}</span>}
          </div>
        </div>
      </details>

      <div className="mt-6 grid gap-3 rounded-2xl border border-border bg-card p-4 sm:grid-cols-4">
        <FilterInput label="Min position" type="number" value={filters.minPosition}
          onChange={(v) => setFilters((f) => ({ ...f, minPosition: Number(v) || 5 }))} />
        <FilterInput label="Max position" type="number" value={filters.maxPosition}
          onChange={(v) => setFilters((f) => ({ ...f, maxPosition: Number(v) || 20 }))} />
        <FilterInput label="Min impressions" type="number" value={filters.minImpressions}
          onChange={(v) => setFilters((f) => ({ ...f, minImpressions: Number(v) || 0 }))} />
        <FilterInput label="URL contains" type="text" value={filters.pathLike}
          onChange={(v) => setFilters((f) => ({ ...f, pathLike: v }))} placeholder="/p/los-angeles" />
        <button onClick={loadRows} className="col-span-full rounded-lg bg-secondary px-4 py-2 text-sm font-semibold sm:col-span-1 sm:col-start-4">
          Apply filters
        </button>
      </div>

      <div className="mt-4 space-y-3">
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!loading && grouped.length === 0 && (
          <p className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No opportunities found. Import GSC query data first.
          </p>
        )}
        {grouped.map((g) => (
          <PageOpportunityCard
            key={g.url_path}
            urlPath={g.url_path}
            queries={g.queries}
            totalImpressions={g.totalImpressions}
            totalClicks={g.totalClicks}
            avgPosition={g.avgPosition}
            onFix={handleAiFix}
            fixing={fixing}
            fixResult={fixResults[g.url_path]}
          />
        ))}
      </div>
    </AdminLayout>
  );
}

function StatCard({ label, value, icon: Icon, highlight }: { label: string; value: React.ReactNode; icon: React.ComponentType<{ className?: string }>; highlight?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 ${highlight ? "border-primary/40 bg-primary/5" : "border-border bg-card"}`}>
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}

function FilterInput({ label, value, onChange, type, placeholder }: { label: string; value: string | number; onChange: (v: string) => void; type: string; placeholder?: string }) {
  return (
    <label className="text-xs">
      <span className="block text-muted-foreground">{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
    </label>
  );
}

function PageOpportunityCard({ urlPath, queries, totalImpressions, totalClicks, avgPosition, onFix, fixing, fixResult }: {
  urlPath: string; queries: KeywordRow[]; totalImpressions: number; totalClicks: number; avgPosition: number;
  onFix: (urlPath: string) => void; fixing: string | null; fixResult?: string;
}) {
  const [pageId, setPageId] = React.useState<string | null>(null);
  const [loadingId, setLoadingId] = React.useState(false);

  async function loadAndFix() {
    setLoadingId(true);
    try {
      const { data } = await supabase.from("content_pages").select("id").eq("url_path", urlPath).maybeSingle();
      if (data?.id) { setPageId(data.id); onFix(data.id); }
    } finally { setLoadingId(false); }
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={urlPath as any} className="font-mono text-sm font-semibold text-primary hover:underline">{urlPath}</Link>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium">avg pos {avgPosition.toFixed(1)}</span>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium">{totalImpressions.toLocaleString()} impr</span>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium">{totalClicks} clicks</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadAndFix} disabled={loadingId || fixing === pageId}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50">
            {(loadingId || fixing === pageId) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            AI rewrite
          </button>
        </div>
      </div>
      {fixResult && pageId && <p className="mt-2 text-xs text-muted-foreground">{fixResult}</p>}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1.5 pr-2 font-medium">Query</th>
              <th className="py-1.5 px-2 text-right font-medium">Pos</th>
              <th className="py-1.5 px-2 text-right font-medium">Impr</th>
              <th className="py-1.5 px-2 text-right font-medium">Clicks</th>
              <th className="py-1.5 pl-2 text-right font-medium">CTR</th>
            </tr>
          </thead>
          <tbody>
            {queries.slice(0, 10).map((q) => (
              <tr key={q.id} className="border-t border-border/60">
                <td className="py-1.5 pr-2">{q.query}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{q.position?.toFixed(1) ?? "—"}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{q.impressions.toLocaleString()}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">{q.clicks}</td>
                <td className="py-1.5 pl-2 text-right tabular-nums">{q.ctr ? `${(q.ctr * 100).toFixed(1)}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {queries.length > 10 && <p className="mt-1 text-xs text-muted-foreground">…and {queries.length - 10} more queries</p>}
      </div>
    </div>
  );
}
