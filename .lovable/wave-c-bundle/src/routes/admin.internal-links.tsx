import * as React from "react";
import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import {
  generateLinkSuggestions,
  listLinkSuggestions,
  updateLinkSuggestionStatus,
  applyLinkSuggestion,
  applyLinkSuggestionsBulk,
  type LinkSuggestionRow,
} from "@/server/admin-seo-tools.functions";
import { AdminLayout } from "@/components/admin-layout";
import { Loader2, Sparkles, Check, X, ArrowRight, LinkIcon } from "lucide-react";

export const Route = createFileRoute("/admin/internal-links")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth", search: { redirect: "/admin/internal-links", mode: "signin" } });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({ meta: [{ title: "Internal links — Admin" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: InternalLinks,
});

function InternalLinks() {
  const [rows, setRows] = React.useState<LinkSuggestionRow[]>([]);
  const [status, setStatus] = React.useState<"pending" | "applied" | "dismissed" | "all">("pending");
  const [q, setQ] = React.useState("");
  const [generating, setGenerating] = React.useState(false);
  const [genMsg, setGenMsg] = React.useState<string | null>(null);
  const [busyIds, setBusyIds] = React.useState<Set<string>>(new Set());
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const load = React.useCallback(async () => {
    const r = await listLinkSuggestions({ data: { status, q, limit: 300 } });
    setRows(r.rows);
    setSelected(new Set());
  }, [status, q]);

  React.useEffect(() => { load(); }, [load]);

  async function generate() {
    setGenerating(true);
    setGenMsg(null);
    try {
      const r: any = await generateLinkSuggestions({ data: { sampleSize: 500, minScore: 0.18, perPage: 5 } });
      setGenMsg(r.ok ? `Generated ${r.count} suggestions` : `Error: ${r.error}`);
      await load();
    } finally { setGenerating(false); }
  }

  async function apply(id: string) {
    setBusyIds((s) => new Set(s).add(id));
    try {
      const r: any = await applyLinkSuggestion({ data: { id } });
      if (!r.ok) alert(r.error || "Failed");
      await load();
    } finally {
      setBusyIds((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }

  async function bulkUpdate(newStatus: "applied" | "dismissed") {
    if (!selected.size) return;
    await updateLinkSuggestionStatus({ data: { ids: Array.from(selected), status: newStatus } });
    await load();
  }

  const [bulkApplying, setBulkApplying] = React.useState(false);
  async function bulkApply(ids: string[]) {
    if (!ids.length) return;
    if (!confirm(`Insert ${ids.length} link${ids.length === 1 ? "" : "s"} into the page bodies? This edits content_pages.`)) return;
    setBulkApplying(true);
    try {
      const r: any = await applyLinkSuggestionsBulk({ data: { ids } });
      if (!r.ok) alert(r.error || "Bulk apply failed");
      else setGenMsg(`Inserted ${r.applied} new links, ${r.skipped} already linked, ${r.failed} failed (of ${r.total}).`);
      await load();
    } finally { setBulkApplying(false); }
  }

  function toggleSelect(id: string) {
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  const visiblePendingIds = React.useMemo(() => rows.filter(r => r.status === "pending").map(r => r.id), [rows]);
  const allVisibleSelected = visiblePendingIds.length > 0 && visiblePendingIds.every(id => selected.has(id));
  function toggleSelectAllVisible() {
    setSelected((s) => {
      const n = new Set(s);
      if (allVisibleSelected) visiblePendingIds.forEach(id => n.delete(id));
      else visiblePendingIds.forEach(id => n.add(id));
      return n;
    });
  }

  return (
    <AdminLayout title="Internal links">
      <div className="mb-4">
        <h1 className="text-2xl font-bold sm:text-3xl">Internal link recommender</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Finds pages that should link to each other based on topic overlap. One-click apply to add the link to your page body.
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold">Generate fresh suggestions</p>
            <p className="text-xs text-muted-foreground">Analyzes your latest 500 published pages.</p>
          </div>
          <button onClick={generate} disabled={generating}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">
            {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {generating ? "Analyzing…" : "Generate"}
          </button>
        </div>
        {genMsg && <p className="mt-2 text-xs text-muted-foreground">{genMsg}</p>}
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex flex-wrap gap-1.5">
          {(["pending", "applied", "dismissed", "all"] as const).map((s) => (
            <button key={s} onClick={() => setStatus(s)}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${status === s ? "bg-primary text-primary-foreground" : "bg-secondary"}`}>
              {s}
            </button>
          ))}
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by URL or anchor…"
          className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm sm:max-w-sm" />
      </div>

      {visiblePendingIds.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-2">
          <label className="inline-flex items-center gap-2 text-xs font-semibold">
            <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAllVisible} className="h-4 w-4" />
            Select all {visiblePendingIds.length} pending
          </label>
          <button onClick={() => bulkApply(visiblePendingIds)} disabled={bulkApplying}
            className="ml-auto inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50">
            {bulkApplying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            Apply all {visiblePendingIds.length}
          </button>
        </div>
      )}

      {selected.size > 0 && (
        <div className="sticky top-12 z-20 mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-2 shadow lg:top-28">
          <span className="text-xs font-semibold">{selected.size} selected</span>
          <button onClick={() => bulkUpdate("dismissed")}
            className="ml-auto inline-flex items-center gap-1 rounded-full bg-secondary px-3 py-1 text-xs font-semibold">
            <X className="h-3 w-3" /> Dismiss
          </button>
          <button onClick={() => bulkApply(Array.from(selected))} disabled={bulkApplying}
            className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50">
            {bulkApplying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            Apply {selected.size}
          </button>
        </div>
      )}

      <div className="mt-3 space-y-2">
        {rows.length === 0 && (
          <p className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No suggestions. Click "Generate" to create some.
          </p>
        )}
        {rows.map((r) => (
          <div key={r.id} className="rounded-2xl border border-border bg-card p-3">
            <div className="flex items-start gap-2">
              <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)}
                className="mt-1 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <Link to={r.from_url as any} className="rounded bg-muted px-1.5 py-0.5 font-mono hover:underline">{r.from_url}</Link>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  <Link to={r.to_url as any} className="rounded bg-muted px-1.5 py-0.5 font-mono hover:underline">{r.to_url}</Link>
                  <span className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 font-semibold text-primary">
                    {(r.score * 100).toFixed(0)}%
                  </span>
                </div>
                {r.anchor_text && (
                  <p className="mt-1.5 text-sm">
                    <LinkIcon className="mr-1 inline h-3 w-3 text-muted-foreground" />
                    Anchor: <span className="font-medium">{r.anchor_text}</span>
                  </p>
                )}
                {r.reason && <p className="text-xs text-muted-foreground">{r.reason}</p>}
              </div>
              <div className="flex shrink-0 flex-col gap-1.5 sm:flex-row">
                {r.status === "pending" && (
                  <>
                    <button onClick={() => apply(r.id)} disabled={busyIds.has(r.id)}
                      className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50">
                      {busyIds.has(r.id) ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      Apply
                    </button>
                    <button onClick={() => updateLinkSuggestionStatus({ data: { ids: [r.id], status: "dismissed" } }).then(load)}
                      className="inline-flex items-center gap-1 rounded-full bg-secondary px-3 py-1 text-xs font-semibold">
                      <X className="h-3 w-3" />
                    </button>
                  </>
                )}
                {r.status !== "pending" && (
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${r.status === "applied" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
                    {r.status}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </AdminLayout>
  );
}
