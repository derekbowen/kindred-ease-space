import * as React from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import {
  listCompetitorPages,
  scrapeCompetitorUrl,
  compareCompetitorToPage,
  deleteCompetitor,
  type CompetitorRow,
} from "@/server/admin-seo-tools.functions";
import { AdminLayout } from "@/components/admin-layout";
import { Loader2, Plus, Trash2, GitCompare, ExternalLink } from "lucide-react";

export const Route = createFileRoute("/admin/competitors")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth", search: { redirect: "/admin/competitors", mode: "signin" } });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({ meta: [{ title: "Competitors — Admin" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: Competitors,
});

function Competitors() {
  const [rows, setRows] = React.useState<CompetitorRow[]>([]);
  const [url, setUrl] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [compareFor, setCompareFor] = React.useState<{ id: string; ourPath: string } | null>(null);
  const [compareResult, setCompareResult] = React.useState<any>(null);
  const [comparing, setComparing] = React.useState(false);

  const load = React.useCallback(async () => {
    const r = await listCompetitorPages({ data: { q, limit: 200 } });
    setRows(r.rows);
  }, [q]);

  React.useEffect(() => { load(); }, [load]);

  async function add() {
    if (!url.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const r: any = await scrapeCompetitorUrl({ data: { url: url.trim() } });
      if (r.ok) { setMsg(`Scraped: ${r.word_count} words`); setUrl(""); await load(); }
      else setMsg(`Error: ${r.error}`);
    } catch (e: any) { setMsg(`Error: ${e?.message || "failed"}`); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!confirm("Delete this competitor page?")) return;
    await deleteCompetitor({ data: { id } });
    await load();
  }

  async function runCompare() {
    if (!compareFor) return;
    setComparing(true);
    setCompareResult(null);
    try {
      const r: any = await compareCompetitorToPage({ data: { competitor_id: compareFor.id, our_url_path: compareFor.ourPath } });
      setCompareResult(r);
    } finally { setComparing(false); }
  }

  return (
    <AdminLayout title="Competitor tracker">
      <div className="mb-4">
        <h1 className="text-2xl font-bold sm:text-3xl">Competitor tracker</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Scrape competitor pages (Swimply, Giggster, Peerspace) and compare them to your pages. See word gaps and missing sections.
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <label className="block text-xs font-medium text-muted-foreground">Add competitor URL</label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://swimply.com/pooldetails/123 or https://poolrentalnearme.com/l/your-listing/abc"
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm" />
          <button onClick={add} disabled={busy || !url.trim()}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Scrape
          </button>
        </div>
        {msg && <p className="mt-2 text-xs text-muted-foreground">{msg}</p>}
      </div>

      <div className="mt-4">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search competitors…"
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm sm:max-w-md" />
      </div>

      <div className="mt-3 space-y-2">
        {rows.length === 0 && (
          <p className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No competitor pages yet. Add one above.
          </p>
        )}
        {rows.map((r) => (
          <div key={r.id} className="rounded-2xl border border-border bg-card p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {r.domain && <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium">{r.domain}</span>}
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium">{r.word_count} words</span>
                </div>
                <a href={r.url} target="_blank" rel="noreferrer noopener"
                  className="mt-1 inline-flex items-center gap-1 break-all text-sm font-medium text-primary hover:underline">
                  {r.url} <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
                {r.title && <p className="mt-1 text-sm font-semibold">{r.title}</p>}
                {r.meta_description && <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{r.meta_description}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button onClick={() => { setCompareFor({ id: r.id, ourPath: "" }); setCompareResult(null); }}
                  className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-xs font-semibold">
                  <GitCompare className="h-3.5 w-3.5" /> Compare
                </button>
                <button onClick={() => remove(r.id)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-destructive">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {compareFor && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onClick={() => setCompareFor(null)}>
          <div className="w-full max-w-2xl rounded-t-2xl bg-card p-5 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold">Compare to your page</h2>
            <label className="mt-3 block text-xs text-muted-foreground">Your page URL path (e.g. /p/los-angeles-ca)</label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input value={compareFor.ourPath} onChange={(e) => setCompareFor((p) => p && { ...p, ourPath: e.target.value })}
                placeholder="/p/los-angeles-ca"
                className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono" />
              <button onClick={runCompare} disabled={comparing || !compareFor.ourPath}
                className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">
                {comparing ? "Comparing…" : "Compare"}
              </button>
            </div>
            {compareResult?.ok && (
              <div className="mt-4 space-y-3 text-sm">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs font-semibold uppercase text-muted-foreground">Yours</p>
                    <p className="mt-1 font-mono text-xs">{compareResult.our.url_path}</p>
                    <p className="mt-1">{compareResult.our.word_count} words · {compareResult.our.headings} headings</p>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs font-semibold uppercase text-muted-foreground">Competitor</p>
                    <p className="mt-1 break-all text-xs">{compareResult.competitor.url}</p>
                    <p className="mt-1">{compareResult.competitor.word_count} words · {compareResult.competitor.headings} headings</p>
                  </div>
                </div>
                <div className={`rounded-lg p-3 text-sm ${compareResult.word_gap > 0 ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"}`}>
                  Word gap: {compareResult.word_gap > 0 ? `you're ${compareResult.word_gap} words behind` : `you're ahead by ${Math.abs(compareResult.word_gap)} words`}
                </div>
                {compareResult.missing_sections?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase text-muted-foreground">Sections you don't cover ({compareResult.missing_sections.length})</p>
                    <ul className="mt-2 space-y-1">
                      {compareResult.missing_sections.map((s: any, i: number) => (
                        <li key={i} className="rounded bg-muted px-2 py-1 text-xs">
                          {"#".repeat(s.level)} {s.text}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {compareResult?.error && <p className="mt-3 text-sm text-destructive">{compareResult.error}</p>}
            <button onClick={() => setCompareFor(null)} className="mt-4 w-full rounded-full bg-secondary px-4 py-2 text-sm font-semibold">Close</button>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
