import * as React from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import {
  list404s,
  resolve404,
  redirect404,
  createPageFor404,
  type Content404Row,
} from "@/server/content-404-log.functions";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";

export const Route = createFileRoute("/admin/missing-pages")({
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({
        to: "/auth",
        search: { redirect: "/admin/missing-pages", mode: "signin" },
      });
    }
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({
    meta: [
      { title: "Missing /p/* pages — Admin" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: AdminMissingPages,
});

function AdminMissingPages() {
  const [rows, setRows] = React.useState<Content404Row[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [unresolvedOnly, setUnresolvedOnly] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await list404s({ data: { unresolvedOnly, limit: 200 } });
      setRows(res.rows);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [unresolvedOnly]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = React.useState(false);
  const [bulkProgress, setBulkProgress] = React.useState<{ done: number; total: number; current: string } | null>(null);

  const openRows = React.useMemo(() => rows.filter((r) => !r.resolved_at), [rows]);
  const allSelected = openRows.length > 0 && openRows.every((r) => selected.has(r.id));

  const toggleOne = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(openRows.map((r) => r.id)));

  const dismiss = async (id: string) => {
    if (!confirm("Dismiss this 404? It just hides the row — the URL will still 404 for visitors.")) return;
    setBusyId(id);
    try { await resolve404({ data: { id, notes: "dismissed by admin" } }); await load(); }
    finally { setBusyId(null); }
  };

  const doRedirect = async (id: string, currentPath: string) => {
    const target = prompt(`Redirect ${currentPath} to which path? (e.g. /p/hosting)`, "/p/all-locations");
    if (!target) return;
    setBusyId(id);
    try {
      const r: any = await redirect404({ data: { id, target } });
      if (!r.ok) alert(r.error || "Redirect failed"); else alert(`Redirect saved: ${currentPath} → ${r.target}`);
      await load();
    } finally { setBusyId(null); }
  };

  const doCreate = async (id: string, currentPath: string) => {
    if (!confirm(`Generate a real page at ${currentPath} with AI? This takes ~30s and will publish to the live site.`)) return;
    setBusyId(id);
    try {
      const r: any = await createPageFor404({ data: { id } });
      if (!r.ok) alert(r.error || "Create failed");
      else if (r.alreadyExists) alert("A page already exists at that URL — marked resolved.");
      else alert(`Created /p/${r.slug} (${r.words} words). It's live now.`);
      await load();
    } finally { setBusyId(null); }
  };

  const bulkCreate = async () => {
    const ids = openRows.filter((r) => selected.has(r.id));
    if (ids.length === 0) return;
    if (!confirm(`Generate ${ids.length} pages with AI sequentially? Roughly ~30s each. They will publish live as they finish.`)) return;
    setBulkRunning(true);
    let ok = 0, skipped = 0, failed = 0;
    for (let i = 0; i < ids.length; i++) {
      const row = ids[i];
      setBulkProgress({ done: i, total: ids.length, current: row.url_path });
      try {
        const r: any = await createPageFor404({ data: { id: row.id } });
        if (!r.ok) failed++;
        else if (r.alreadyExists) skipped++;
        else ok++;
      } catch { failed++; }
    }
    setBulkProgress(null);
    setBulkRunning(false);
    setSelected(new Set());
    alert(`Bulk create finished — ${ok} created, ${skipped} already existed, ${failed} failed.`);
    await load();
  };

  const bulkRedirect = async () => {
    const ids = openRows.filter((r) => selected.has(r.id));
    if (ids.length === 0) return;
    const target = prompt(`Redirect ${ids.length} URLs to which path? (e.g. /p/all-locations)`, "/p/all-locations");
    if (!target) return;
    setBulkRunning(true);
    let ok = 0, failed = 0;
    for (let i = 0; i < ids.length; i++) {
      const row = ids[i];
      setBulkProgress({ done: i, total: ids.length, current: row.url_path });
      try {
        const r: any = await redirect404({ data: { id: row.id, target } });
        if (r.ok) ok++; else failed++;
      } catch { failed++; }
    }
    setBulkProgress(null);
    setBulkRunning(false);
    setSelected(new Set());
    alert(`Bulk redirect finished — ${ok} saved, ${failed} failed (→ ${target}).`);
    await load();
  };

  const bulkDismiss = async () => {
    const ids = openRows.filter((r) => selected.has(r.id));
    if (ids.length === 0) return;
    if (!confirm(`Dismiss ${ids.length} rows? This only hides them — URLs still 404 for visitors.`)) return;
    setBulkRunning(true);
    for (let i = 0; i < ids.length; i++) {
      const row = ids[i];
      setBulkProgress({ done: i, total: ids.length, current: row.url_path });
      try { await resolve404({ data: { id: row.id, notes: "bulk dismissed" } }); } catch {}
    }
    setBulkProgress(null);
    setBulkRunning(false);
    setSelected(new Set());
    await load();
  };

  const totalHits = rows.reduce((acc, r) => acc + (r.hit_count ?? 0), 0);
  const selectedCount = selected.size;

  return (
    <AdminLayout>
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              Missing /p/* pages
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {rows.length} unique URL{rows.length === 1 ? "" : "s"} ·{" "}
              {totalHits} total 404 hit{totalHits === 1 ? "" : "s"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={unresolvedOnly}
                onChange={(e) => setUnresolvedOnly(e.target.checked)}
              />
              Unresolved only
            </label>
            <button
              onClick={load}
              className="rounded-full border border-border px-4 py-2 text-sm font-semibold hover:bg-muted"
            >
              Refresh
            </button>
          </div>
        </header>

        {error && (
          <div className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {(selectedCount > 0 || bulkRunning) && (
          <div className="sticky top-2 z-10 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/40 bg-primary/5 px-4 py-3 text-sm">
            <div className="font-medium">
              {bulkRunning && bulkProgress
                ? `Working ${bulkProgress.done + 1} / ${bulkProgress.total} — ${bulkProgress.current}`
                : `${selectedCount} selected`}
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={bulkCreate} disabled={bulkRunning || selectedCount === 0}
                className="rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
                ✨ Create {selectedCount} page{selectedCount === 1 ? "" : "s"}
              </button>
              <button onClick={bulkRedirect} disabled={bulkRunning || selectedCount === 0}
                className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-semibold hover:bg-muted disabled:opacity-50">
                ↪ Redirect {selectedCount} to…
              </button>
              <button onClick={bulkDismiss} disabled={bulkRunning || selectedCount === 0}
                className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted disabled:opacity-50">
                Dismiss {selectedCount}
              </button>
              <button onClick={() => setSelected(new Set())} disabled={bulkRunning}
                className="rounded-full px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted disabled:opacity-50">
                Clear
              </button>
            </div>
          </div>
        )}

        <div className="mt-6 overflow-x-auto rounded-2xl border border-border">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-3 w-8">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll}
                    aria-label="Select all open rows" disabled={openRows.length === 0 || bulkRunning} />
                </th>
                <th className="px-4 py-3">URL</th>
                <th className="px-4 py-3">Hits</th>
                <th className="px-4 py-3">Last seen</th>
                <th className="px-4 py-3">Referrer</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-background">
              {loading && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-muted-foreground">
                    No 404s logged. Nice.
                  </td>
                </tr>
              )}
              {!loading &&
                rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="px-3 py-3">
                      {!r.resolved_at && (
                        <input type="checkbox" checked={selected.has(r.id)}
                          onChange={() => toggleOne(r.id)}
                          disabled={bulkRunning}
                          aria-label={`Select ${r.url_path}`} />
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      <a
                        href={r.url_path}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        {r.url_path}
                      </a>
                    </td>
                    <td className="px-4 py-3 font-semibold">{r.hit_count}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {new Date(r.last_seen_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground break-all">
                      {r.referrer || "—"}
                    </td>
                    <td className="px-4 py-3">
                      {r.resolved_at ? (
                        <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                          Resolved
                        </span>
                      ) : (
                        <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                          Open
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {!r.resolved_at && (
                        <div className="inline-flex flex-wrap justify-end gap-1.5">
                          <button onClick={() => doCreate(r.id, r.url_path)} disabled={busyId === r.id}
                            className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
                            title="Generate a real page with AI and publish it">
                            ✨ Create page
                          </button>
                          <button onClick={() => doRedirect(r.id, r.url_path)} disabled={busyId === r.id}
                            className="rounded-full border border-border px-3 py-1 text-xs font-semibold hover:bg-muted disabled:opacity-50"
                            title="Send this URL to an existing page (301 redirect)">
                            ↪ Redirect
                          </button>
                          <button onClick={() => dismiss(r.id)} disabled={busyId === r.id}
                            className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-muted-foreground hover:bg-muted disabled:opacity-50"
                            title="Just hide this row — does NOT fix the 404">
                            Dismiss
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </AdminLayout>
  );
}
