import * as React from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import {
  listTrackedKeywords, addTrackedKeyword, deleteTrackedKeyword, runSerpCheck,
  type TrackedKeywordRow,
} from "@/server/admin-weapons.functions";
import { AdminLayout } from "@/components/admin-layout";
import { Loader2, Plus, Trash2, RefreshCw, TrendingUp, TrendingDown, Minus } from "lucide-react";

export const Route = createFileRoute("/admin/rank-tracker")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth", search: { redirect: "/admin/rank-tracker", mode: "signin" } });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({ meta: [{ title: "Rank Tracker — Admin" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: RankTracker,
});

function RankTracker() {
  const [rows, setRows] = React.useState<TrackedKeywordRow[]>([]);
  const [kw, setKw] = React.useState("");
  const [target, setTarget] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const r = await listTrackedKeywords();
    setRows(r.rows);
  }, []);
  React.useEffect(() => { load(); }, [load]);

  async function add() {
    if (!kw.trim()) return;
    const r: any = await addTrackedKeyword({ data: { keyword: kw.trim(), target_url_path: target.trim() || undefined } });
    if (r.ok) { setKw(""); setTarget(""); await load(); }
    else setMsg(r.error);
  }

  async function checkAll() {
    setBusy("all"); setMsg(null);
    try {
      const r: any = await runSerpCheck({ data: { limit: 20 } });
      if (r?.ok === false) { setMsg(`Error: ${r.error}`); return; }
      const found = (r.results || []).filter((x: any) => x.position != null).length;
      const errs = (r.results || []).filter((x: any) => x.error).slice(0, 2).map((x: any) => `${x.keyword}: ${x.error}`).join(" | ");
      setMsg(`Checked ${r.results?.length ?? 0} keywords, ${found} ranked.${errs ? " " + errs : ""}`);
      await load();
    } finally { setBusy(null); }
  }

  async function checkOne(id: string) {
    setBusy(id);
    try { await runSerpCheck({ data: { id } }); await load(); }
    finally { setBusy(null); }
  }

  async function remove(id: string) {
    if (!confirm("Stop tracking this keyword?")) return;
    await deleteTrackedKeyword({ data: { id } });
    await load();
  }

  function deltaIcon(curr: number | null, prev: number | null) {
    if (curr == null || prev == null) return <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
    if (curr < prev) return <TrendingUp className="h-3.5 w-3.5 text-emerald-600" />;
    if (curr > prev) return <TrendingDown className="h-3.5 w-3.5 text-destructive" />;
    return <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
  }

  return (
    <AdminLayout title="Rank Tracker">
      <div className="mb-4">
        <h1 className="flex items-center gap-2 text-2xl font-bold sm:text-3xl">
          <TrendingUp className="h-6 w-6 text-primary" /> SERP Rank Tracker
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Daily Google position checks for your priority keywords. Win/loss arrows show movement since the last check.
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <p className="text-sm font-semibold">Track a new keyword</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="pool rental austin"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm sm:col-span-2" />
          <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="/p/austin-tx (optional)"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono" />
          <button onClick={add} className="inline-flex items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground sm:col-span-3">
            <Plus className="h-4 w-4" /> Add keyword
          </button>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <h2 className="text-lg font-bold">Tracked keywords ({rows.length})</h2>
        <button onClick={checkAll} disabled={busy === "all"}
          className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">
          {busy === "all" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Check 20 oldest
        </button>
      </div>
      {msg && <p className="mt-2 text-xs text-muted-foreground">{msg}</p>}

      <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Keyword</th>
              <th className="px-3 py-2 text-left">Target</th>
              <th className="px-3 py-2 text-center">Now</th>
              <th className="px-3 py-2 text-center">Prev</th>
              <th className="px-3 py-2 text-left">Last check</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2 font-medium">{r.keyword}</td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{r.target_url_path || "—"}</td>
                <td className="px-3 py-2 text-center">
                  <div className="inline-flex items-center gap-1.5">
                    {deltaIcon(r.last_position, r.previous_position)}
                    <span className={`font-bold ${r.last_position == null ? "text-muted-foreground" : r.last_position <= 3 ? "text-emerald-600" : r.last_position <= 10 ? "text-foreground" : "text-muted-foreground"}`}>
                      {r.last_position ?? "—"}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 text-center text-xs text-muted-foreground">{r.previous_position ?? "—"}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {r.last_checked_at ? new Date(r.last_checked_at).toLocaleString() : "never"}
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1.5">
                    <button onClick={() => checkOne(r.id)} disabled={busy === r.id}
                      className="rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold disabled:opacity-50">
                      {busy === r.id ? "…" : "Recheck"}
                    </button>
                    <button onClick={() => remove(r.id)} className="rounded-full border border-border p-1.5 text-destructive">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="p-8 text-center text-sm text-muted-foreground">No keywords tracked yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </AdminLayout>
  );
}
