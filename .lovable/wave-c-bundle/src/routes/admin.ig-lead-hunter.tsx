import * as React from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import {
  listIgLeads, runIgLeadHuntNow, setIgLeadContacted, updateIgLeadNotes, deleteIgLead,
  bulkSetIgLeadsContacted,
  type IgLeadRow,
} from "@/server/ig-lead-hunter.functions";
import { AdminLayout } from "@/components/admin-layout";
import { Loader2, RefreshCw, ExternalLink, Trash2, Instagram, Search, CheckSquare, Square } from "lucide-react";

export const Route = createFileRoute("/admin/ig-lead-hunter")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth", search: { redirect: "/admin/ig-lead-hunter", mode: "signin" } });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({ meta: [{ title: "IG Lead Hunter — Admin" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: IgLeadHunter,
});

function IgLeadHunter() {
  const [rows, setRows] = React.useState<IgLeadRow[]>([]);
  const [filter, setFilter] = React.useState<"new" | "contacted" | "all">("new");
  const [loading, setLoading] = React.useState(true);
  const [running, setRunning] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulking, setBulking] = React.useState(false);

  async function load() {
    setLoading(true);
    try {
      const r: any = await listIgLeads({ data: { filter, limit: 300 } });
      if (r.ok) setRows(r.rows);
      else setMsg(r.error || "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => { load(); }, [filter]);

  async function runHunt() {
    setRunning(true); setMsg(null);
    try {
      const r: any = await runIgLeadHuntNow();
      setMsg(`Scanned ${r.results_seen} results, added ${r.inserted} new leads, refreshed ${r.refreshed}.`);
      await load();
    } catch (e: any) {
      setMsg(`Failed: ${e?.message || "unknown"}`);
    } finally {
      setRunning(false);
    }
  }

  async function toggle(row: IgLeadRow) {
    const next = !row.contacted;
    setRows((r) => r.map((x) => x.id === row.id ? { ...x, contacted: next } : x));
    await setIgLeadContacted({ data: { id: row.id, contacted: next } });
    if (filter !== "all") load();
  }

  async function remove(row: IgLeadRow) {
    if (!confirm(`Delete @${row.profile_handle}?`)) return;
    await deleteIgLead({ data: { id: row.id } });
    setRows((r) => r.filter((x) => x.id !== row.id));
  }

  async function saveNotes(row: IgLeadRow, notes: string) {
    setRows((r) => r.map((x) => x.id === row.id ? { ...x, notes } : x));
    await updateIgLeadNotes({ data: { id: row.id, notes } });
  }

  const filtered = search.trim()
    ? rows.filter((r) =>
        (r.profile_handle || "").toLowerCase().includes(search.toLowerCase()) ||
        (r.profile_name || "").toLowerCase().includes(search.toLowerCase()) ||
        (r.snippet || "").toLowerCase().includes(search.toLowerCase()))
    : rows;

  const totalNew = rows.filter((r) => !r.contacted).length;
  const visibleIds = filtered.map((r) => r.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someVisibleSelected = visibleIds.some((id) => selected.has(id));

  function toggleSelect(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function toggleSelectAllVisible() {
    setSelected((s) => {
      const n = new Set(s);
      if (allVisibleSelected) visibleIds.forEach((id) => n.delete(id));
      else visibleIds.forEach((id) => n.add(id));
      return n;
    });
  }
  function clearSelection() { setSelected(new Set()); }

  async function bulkMark(contacted: boolean) {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setBulking(true); setMsg(null);
    try {
      const r: any = await bulkSetIgLeadsContacted({ data: { ids, contacted } });
      if (r.ok) {
        const nowIso = new Date().toISOString();
        setRows((rs) => rs.map((x) => ids.includes(x.id)
          ? { ...x, contacted, contacted_at: contacted ? nowIso : null }
          : x));
        setMsg(`Marked ${r.updated} lead${r.updated === 1 ? "" : "s"} as ${contacted ? "contacted" : "not contacted"}.`);
        clearSelection();
        if (filter !== "all") load();
      } else {
        setMsg(r.error || "Bulk update failed");
      }
    } finally {
      setBulking(false);
    }
  }

  return (
    <AdminLayout>
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <Instagram className="h-6 w-6" /> IG Lead Hunter
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Daily Google search across <code>site:instagram.com</code> for pool-rental keywords. Click each profile to DM the owner.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={runHunt}
              disabled={running}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
            >
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Run hunt now
            </button>
          </div>
        </header>

        {msg && (
          <div className="rounded-md border bg-muted/50 px-3 py-2 text-sm">{msg}</div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-md border p-1">
            {(["new", "contacted", "all"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded px-3 py-1 text-sm capitalize ${filter === f ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              >
                {f}{f === "new" ? ` (${totalNew})` : ""}
              </button>
            ))}
          </div>
          <div className="relative ml-auto">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by handle, name, snippet…"
              className="w-72 rounded-md border bg-background py-2 pl-8 pr-3 text-sm"
            />
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading leads…</div>
        ) : filtered.length === 0 ? (
          <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
            No leads {filter !== "all" ? `in "${filter}"` : ""}. Click <strong>Run hunt now</strong> to fetch fresh results from Google.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <button
                onClick={toggleSelectAllVisible}
                className="inline-flex items-center gap-2 hover:text-primary"
                title={allVisibleSelected ? "Deselect all visible" : "Select all visible"}
              >
                {allVisibleSelected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                {allVisibleSelected ? "Deselect all" : "Select all"} ({filtered.length})
              </button>
              <span className="text-muted-foreground">{selected.size} selected</span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => bulkMark(true)}
                  disabled={selected.size === 0 || bulking}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {bulking ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckSquare className="h-4 w-4" />}
                  Mark contacted
                </button>
                <button
                  onClick={() => bulkMark(false)}
                  disabled={selected.size === 0 || bulking}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                >
                  Mark not contacted
                </button>
                {selected.size > 0 && (
                  <button onClick={clearSelection} className="text-xs text-muted-foreground hover:underline">Clear</button>
                )}
              </div>
            </div>
            <ul className="divide-y rounded-md border">
            {filtered.map((row) => (
              <li key={row.id} className={`flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:gap-4 ${selected.has(row.id) ? "bg-primary/5" : ""}`}>
                <div className="flex shrink-0 items-center gap-3 pt-1">
                  <input
                    type="checkbox"
                    checked={selected.has(row.id)}
                    onChange={() => toggleSelect(row.id)}
                    className="h-4 w-4 cursor-pointer accent-primary"
                    title="Select for bulk action"
                  />
                  <label className="flex items-center gap-1 text-xs text-muted-foreground" title="Contacted">
                    <input
                      type="checkbox"
                      checked={row.contacted}
                      onChange={() => toggle(row)}
                      className="h-4 w-4 cursor-pointer accent-primary"
                    />
                    <span className="sm:hidden">Contacted</span>
                  </label>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <a
                      href={row.source_url || row.instagram_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                      title={row.source_url ? "Open the exact post" : "Open the profile"}
                    >
                      @{row.profile_handle}
                      {row.source_url && /\/(p|reel|reels|tv)\//.test(row.source_url) && (
                        <span className="rounded bg-primary/10 px-1 text-[10px] font-semibold uppercase tracking-wide text-primary">post</span>
                      )}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    {row.source_url && row.source_url !== row.instagram_url && (
                      <a
                        href={row.instagram_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-muted-foreground hover:underline"
                      >
                        profile
                      </a>
                    )}
                    {row.profile_name && row.profile_name !== row.profile_handle && (
                      <span className="text-sm text-muted-foreground">{row.profile_name}</span>
                    )}
                    {row.contacted && row.contacted_at && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        Contacted {new Date(row.contacted_at).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  {row.snippet && (
                    <p className="mt-1 text-sm text-muted-foreground line-clamp-3">{row.snippet}</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {row.query && <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{row.query}</span>}
                    <span>seen {new Date(row.last_seen_at).toLocaleDateString()}</span>
                  </div>
                  <textarea
                    defaultValue={row.notes || ""}
                    onBlur={(e) => {
                      if (e.target.value !== (row.notes || "")) saveNotes(row, e.target.value);
                    }}
                    placeholder="Outreach notes…"
                    className="mt-2 w-full rounded border bg-background px-2 py-1 text-xs"
                    rows={1}
                  />
                </div>
                <button
                  onClick={() => remove(row)}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title="Delete lead"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
          </>
        )}
      </div>
    </AdminLayout>
  );
}
