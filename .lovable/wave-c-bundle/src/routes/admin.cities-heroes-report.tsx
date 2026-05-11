import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";
import {
  getHeroBackfillReport,
  type HeroReportRow,
} from "@/server/cities-hero-report.functions";

export const Route = createFileRoute("/admin/cities-heroes-report")({
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" as never });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  component: HeroReportPage,
  head: () => ({ meta: [{ title: "Hero backfill report — Admin" }] }),
});

type Filter = "all" | "failing" | "error" | "miss" | "skipped" | "missing_hero";

function HeroReportPage() {
  const [rows, setRows] = useState<HeroReportRow[]>([]);
  const [totals, setTotals] = useState<{
    cities: number; ok: number; miss: number; skipped: number; error: number;
    missingHero: number; lastFailing: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("failing");
  const [search, setSearch] = useState("");

  async function load() {
    setLoading(true);
    setErrMsg(null);
    try {
      const out = await getHeroBackfillReport();
      setRows(out.rows);
      setTotals(out.totals);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "error" && r.error === 0) return false;
      if (filter === "miss" && r.miss === 0) return false;
      if (filter === "skipped" && r.skipped === 0) return false;
      if (filter === "missing_hero" && r.has_hero) return false;
      if (filter === "failing" && r.last_status === "ok") return false;
      if (q) {
        const hay = `${r.city_slug} ${r.city_name ?? ""} ${r.state_code ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, filter, search]);

  function downloadCsv(scope: "visible" | "all_failing") {
    const list = scope === "visible"
      ? visible
      : rows.filter((r) => r.last_status && r.last_status !== "ok");
    const header = "city_slug,city_name,state_code,has_hero,last_status,ok,miss,skipped,error,last_source_url,last_error,last_ran_at\n";
    const csv = header + list.map((r) =>
      [
        r.city_slug,
        JSON.stringify(r.city_name ?? ""),
        r.state_code ?? "",
        r.has_hero ? "1" : "0",
        r.last_status ?? "",
        r.ok, r.miss, r.skipped, r.error,
        JSON.stringify(r.last_source_url ?? ""),
        JSON.stringify(r.last_error ?? ""),
        r.last_ran_at ?? "",
      ].join(","),
    ).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = scope === "visible" ? "hero-report-filtered.csv" : "hero-report-failing.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyFailingSlugs() {
    const slugs = rows
      .filter((r) => r.last_status && r.last_status !== "ok")
      .map((r) => r.city_slug);
    navigator.clipboard.writeText(slugs.join("\n"));
  }

  return (
    <AdminLayout>
      <div className="mb-6">
        <Link to="/admin/cities-heroes" className="text-sm text-muted-foreground hover:underline">
          ← Hero backfill
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          City hero backfill report
        </h1>
        <p className="mt-2 text-muted-foreground">
          Per-city counts of ok / miss / skipped / error from
          <code className="mx-1 rounded bg-secondary px-1">cities_hero_backfill_log</code>.
          Use the filters to find cities to reprocess.
        </p>
      </div>

      {errMsg && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {errMsg}
        </div>
      )}

      {totals && (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {[
            ["cities", totals.cities],
            ["ok", totals.ok],
            ["miss", totals.miss],
            ["skipped", totals.skipped],
            ["error", totals.error],
            ["missing hero", totals.missingHero],
            ["last run failing", totals.lastFailing],
          ].map(([k, v]) => (
            <div key={String(k)} className="rounded-lg border border-border bg-card p-3 text-center">
              <div className="text-xl font-bold">{v as number}</div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</div>
            </div>
          ))}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-sm"
        >
          <option value="failing">Last run failing</option>
          <option value="error">Has any error</option>
          <option value="miss">Has any miss</option>
          <option value="skipped">Has any skipped</option>
          <option value="missing_hero">Missing hero in DB</option>
          <option value="all">All cities</option>
        </select>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search slug, name, state…"
          className="min-w-[220px] flex-1 rounded-md border border-border bg-card px-3 py-1.5 text-sm"
        />
        <button
          onClick={load}
          disabled={loading}
          className="rounded-full border border-border bg-card px-4 py-1.5 text-sm font-medium hover:bg-secondary disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
        <button
          onClick={() => downloadCsv("visible")}
          className="rounded-full border border-border bg-card px-4 py-1.5 text-sm font-medium hover:bg-secondary"
        >
          Download filtered CSV
        </button>
        <button
          onClick={() => downloadCsv("all_failing")}
          className="rounded-full bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
        >
          Download all failing
        </button>
        <button
          onClick={copyFailingSlugs}
          className="rounded-full border border-border bg-card px-4 py-1.5 text-sm font-medium hover:bg-secondary"
        >
          Copy failing slugs
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-secondary/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">City</th>
              <th className="px-3 py-2">Last</th>
              <th className="px-3 py-2 text-right">ok</th>
              <th className="px-3 py-2 text-right">miss</th>
              <th className="px-3 py-2 text-right">skip</th>
              <th className="px-3 py-2 text-right">err</th>
              <th className="px-3 py-2">Hero</th>
              <th className="px-3 py-2">Last error / source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.map((r) => (
              <tr key={r.city_slug} className="align-top">
                <td className="px-3 py-2">
                  <div className="font-medium">{r.city_name ?? r.city_slug}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.city_slug}{r.state_code ? ` · ${r.state_code.toUpperCase()}` : ""}
                  </div>
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  <span className={
                    r.last_status === "ok" ? "text-emerald-600"
                    : r.last_status === "miss" ? "text-amber-600"
                    : "text-destructive"
                  }>
                    {r.last_status ?? "—"}
                  </span>
                  {r.last_ran_at && (
                    <div className="text-[10px] text-muted-foreground">
                      {new Date(r.last_ran_at).toLocaleString()}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{r.ok}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.miss}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.skipped}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.error}</td>
                <td className="px-3 py-2 text-xs">
                  {r.has_hero ? <span className="text-emerald-600">yes</span> : <span className="text-destructive">no</span>}
                </td>
                <td className="px-3 py-2 text-xs">
                  {r.last_error && (
                    <div className="text-destructive line-clamp-2">{r.last_error}</div>
                  )}
                  {r.last_source_url && (
                    <a href={r.last_source_url} target="_blank" rel="noreferrer"
                       className="break-all text-primary hover:underline">
                      {r.last_source_url.replace("https://www.", "")}
                    </a>
                  )}
                </td>
              </tr>
            ))}
            {!loading && visible.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-muted-foreground">
                No rows match this filter.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </AdminLayout>
  );
}
