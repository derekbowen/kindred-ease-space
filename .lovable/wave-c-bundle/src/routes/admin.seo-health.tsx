import * as React from "react";
import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";
import {
  listSeoIssues, aiFixContentPage, enqueueSeoFixJobs, getSeoJobStatus, cancelQueuedSeoJobs,
  type SeoIssueRow, type SeoJobRow,
} from "@/server/admin-tools.functions";

export const Route = createFileRoute("/admin/seo-health")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth", search: { redirect: "/admin/seo-health", mode: "signin" } });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({ meta: [{ title: "SEO Health — Admin" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: SeoHealth,
});

const KINDS = [
  { id: "thin", label: "Thin pages (<500 words)", fixMode: "full" as const, fixLabel: "Expand body" },
  { id: "empty", label: "Empty body", fixMode: "full" as const, fixLabel: "Generate body" },
  { id: "missing_meta", label: "Missing meta description", fixMode: "meta_only" as const, fixLabel: "Generate meta" },
  { id: "title_is_slug", label: "Title is just slug", fixMode: "title_only" as const, fixLabel: "Rewrite title" },
] as const;

type FixResult = { id: string; ok: boolean; error?: string; newWords?: number; ms: number };

function SeoHealth() {
  const [kindId, setKindId] = React.useState<typeof KINDS[number]["id"]>("thin");
  const kind = KINDS.find((k) => k.id === kindId)!;
  const [rows, setRows] = React.useState<SeoIssueRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [results, setResults] = React.useState<Record<string, FixResult>>({});
  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState({ done: 0, total: 0, current: "" });
  const abortRef = React.useRef(false);

  // Background queue state
  const [batchId, setBatchId] = React.useState<string | null>(null);
  const [jobs, setJobs] = React.useState<Record<string, SeoJobRow>>({}); // page_id -> job
  const [summary, setSummary] = React.useState({ queued: 0, processing: 0, done: 0, failed: 0, cancelled: 0 });

  const load = React.useCallback(async () => {
    setLoading(true);
    try { const r = await listSeoIssues({ data: { kind: kindId, limit: 200 } }); setRows(r.rows); setSelected(new Set()); }
    finally { setLoading(false); }
  }, [kindId]);
  React.useEffect(() => { void load(); }, [load]);

  // Poll job status while there is anything queued/processing for visible rows
  React.useEffect(() => {
    if (!batchId && rows.length === 0) return;
    let cancelled = false;
    let timer: any;
    const tick = async () => {
      const pageIds = rows.map((r) => r.id);
      try {
        const r = await getSeoJobStatus({ data: batchId ? { batchId } : { pageIds } });
        if (cancelled) return;
        const map: Record<string, SeoJobRow> = {};
        for (const j of r.jobs) map[j.page_id] = j;
        setJobs(map);
        setSummary(r.summary);
      } catch {/* ignore polling errors */}
      const stillRunning = Object.values(jobs).some((j) => j.status === "queued" || j.status === "processing");
      timer = setTimeout(tick, stillRunning || batchId ? 3000 : 8000);
    };
    void tick();
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId, rows.length]);

  function toggle(id: string) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSelected((s) => s.size === rows.length ? new Set() : new Set(rows.map((r) => r.id)));
  }

  async function fixOne(row: SeoIssueRow): Promise<FixResult> {
    const t0 = Date.now();
    try {
      const res = await aiFixContentPage({ data: { id: row.id, mode: kind.fixMode } });
      return { id: row.id, ok: !!res.ok, error: (res as any).error, newWords: (res as any).newWords, ms: Date.now() - t0 };
    } catch (e: any) {
      return { id: row.id, ok: false, error: e?.message || "Failed", ms: Date.now() - t0 };
    }
  }

  async function enqueueBatch(targets: SeoIssueRow[]) {
    if (!targets.length) return;
    const res = await enqueueSeoFixJobs({ data: { pageIds: targets.map((t) => t.id), mode: kind.fixMode } });
    if (res.ok) {
      setBatchId(res.batchId);
      // optimistic: mark visible targets as queued
      setJobs((prev) => {
        const next = { ...prev };
        for (const t of targets) {
          next[t.id] = {
            id: "pending", page_id: t.id, mode: kind.fixMode, status: "queued",
            attempts: 0, result: null, error: null, batch_id: res.batchId,
            created_at: new Date().toISOString(), finished_at: null,
          };
        }
        return next;
      });
    }
  }

  async function cancelBatch() {
    if (!batchId) return;
    await cancelQueuedSeoJobs({ data: { batchId } });
    setBatchId(null);
  }

  return (
    <AdminLayout title="SEO Health">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">SEO Health</h1>
          <p className="text-sm text-muted-foreground">Drill into published /p/* pages with quality issues, then fix them with AI.</p>
        </div>
        <Link to="/admin/generate-content" className="shrink-0 text-xs font-semibold text-primary hover:underline">Open Generate content →</Link>
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        {KINDS.map((k) => (
          <button key={k.id} onClick={() => setKindId(k.id)} disabled={running}
            className={`rounded-full border px-3 py-1.5 text-sm ${kindId === k.id ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-muted"} disabled:opacity-50`}>
            {k.label}
          </button>
        ))}
      </div>

      {/* Action bar */}
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={rows.length > 0 && selected.size === rows.length} onChange={toggleAll} />
          Select all ({rows.length})
        </label>
        <span className="text-sm text-muted-foreground">· {selected.size} selected</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <button
            onClick={() => enqueueBatch(rows.filter((r) => selected.has(r.id)))}
            disabled={selected.size === 0}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">
            ⚡ Queue {kind.fixLabel} ({selected.size})
          </button>
          <button
            onClick={() => enqueueBatch(rows.slice(0, 10))}
            disabled={rows.length === 0}
            className="rounded-md border border-primary px-3 py-1.5 text-sm font-semibold text-primary disabled:opacity-50">
            Queue first 10
          </button>
          {summary.failed > 0 && (
            <button
              onClick={() => {
                const failedPageIds = new Set(Object.values(jobs).filter((j) => j.status === "failed").map((j) => j.page_id));
                void enqueueBatch(rows.filter((r) => failedPageIds.has(r.id)));
              }}
              className="rounded-md border border-yellow-500 px-3 py-1.5 text-sm font-semibold text-yellow-700 dark:text-yellow-300">
              Retry failed ({summary.failed})
            </button>
          )}
          {batchId && (summary.queued > 0 || summary.processing > 0) && (
            <button onClick={cancelBatch} className="rounded-md border border-red-500 px-3 py-1.5 text-sm font-semibold text-red-600">
              Cancel queue
            </button>
          )}
        </div>
      </div>

      {/* Background queue progress */}
      {(summary.queued + summary.processing + summary.done + summary.failed) > 0 && (
        <div className="mt-3 rounded-lg border border-border bg-card p-3">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="font-semibold">Background queue</span>
            <span className="rounded bg-muted px-2 py-0.5">⏳ Queued {summary.queued}</span>
            <span className="rounded bg-blue-500/20 px-2 py-0.5 text-blue-700 dark:text-blue-300">⚙ Processing {summary.processing}</span>
            <span className="rounded bg-green-500/20 px-2 py-0.5 text-green-700 dark:text-green-300">✓ Done {summary.done}</span>
            {summary.failed > 0 && <span className="rounded bg-red-500/20 px-2 py-0.5 text-red-700 dark:text-red-300">✗ Failed {summary.failed}</span>}
            <span className="ml-auto text-muted-foreground">Worker runs every minute. UI auto-refreshes.</span>
          </div>
          {(() => {
            const total = summary.queued + summary.processing + summary.done + summary.failed;
            const done = summary.done + summary.failed;
            const pct = total ? Math.round((done / total) * 100) : 0;
            return (
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
              </div>
            );
          })()}
        </div>
      )}

      {/* Single-row inline progress */}
      {running && (
        <div className="mt-3 rounded-lg border border-border bg-card p-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Fixing {progress.current}…</span>
            <span>{progress.done} / {progress.total}</span>
          </div>
        </div>
      )}

      <div className="mt-3 overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase">
            <tr>
              <th className="w-8 px-3 py-2"></th>
              <th className="px-3 py-2">URL</th>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Template</th>
              <th className="px-3 py-2 text-right">Words</th>
              <th className="px-3 py-2">Result</th>
              <th className="px-3 py-2 text-right"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const res = results[r.id];
              const job = jobs[r.id];
              return (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    <a href={r.url_path || "#"} target="_blank" rel="noreferrer" className="hover:underline">{r.url_path}</a>
                  </td>
                  <td className="px-3 py-2 max-w-xs truncate">{r.title || <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{r.template_type || "—"}</td>
                  <td className="px-3 py-2 text-right">{r.words.toLocaleString()}</td>
                  <td className="px-3 py-2 text-xs">
                    {job ? (
                      job.status === "queued" ? <span className="rounded bg-muted px-1.5 py-0.5 font-bold">⏳ Queued</span> :
                      job.status === "processing" ? <span className="rounded bg-blue-500/20 px-1.5 py-0.5 font-bold text-blue-700 dark:text-blue-300">⚙ Processing</span> :
                      job.status === "done" ? <span className="rounded bg-green-500/20 px-1.5 py-0.5 font-bold text-green-700 dark:text-green-300">✓ {job.result?.newWords ? `${job.result.newWords}w` : "ok"}</span> :
                      job.status === "failed" ? <span className="rounded bg-red-500/20 px-1.5 py-0.5 font-bold text-red-700 dark:text-red-300" title={job.error || ""}>✗ {(job.error || "").slice(0, 40)}</span> :
                      <span className="rounded bg-muted px-1.5 py-0.5">Cancelled</span>
                    ) : !res ? <span className="text-muted-foreground">—</span> :
                      res.ok ? <span className="rounded bg-green-500/20 px-1.5 py-0.5 font-bold text-green-700 dark:text-green-300">✓ {res.newWords ? `${res.newWords}w` : "ok"}</span> :
                      <span className="rounded bg-red-500/20 px-1.5 py-0.5 font-bold text-red-700 dark:text-red-300" title={res.error}>✗ {(res.error || "").slice(0, 40)}</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      disabled={running}
                      onClick={async () => {
                        setRunning(true);
                        setProgress({ done: 0, total: 1, current: r.url_path || "" });
                        const out = await fixOne(r);
                        setResults((prev) => ({ ...prev, [r.id]: out }));
                        setProgress({ done: 1, total: 1, current: r.url_path || "" });
                        setRunning(false);
                        void load();
                      }}
                      className="rounded border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50">
                      ✨ Fix now
                    </button>
                  </td>
                </tr>
              );
            })}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">No issues 🎉</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </AdminLayout>
  );
}
