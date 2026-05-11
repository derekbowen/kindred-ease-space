import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";
import { getCityClickReport, type CityClickReport } from "@/server/click-report.functions";

export const Route = createFileRoute("/admin/click-report")({
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: "/auth" as never });
    }
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  component: ClickReportPage,
  head: () => ({ meta: [{ title: "Nearby-city click report — Admin" }] }),
});

function ClickReportPage() {
  const [days, setDays] = useState(30);
  const [limit, setLimit] = useState(50);
  const [report, setReport] = useState<CityClickReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const out = await getCityClickReport({ data: { days, limit } });
      setReport(out);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function downloadCsv() {
    if (!report) return;
    const header = "rank,to_city_slug,city_name,state_code,total_clicks,unique_visitors,last_clicked_at\n";
    const body = report.rows
      .map((r, i) =>
        [
          i + 1,
          r.to_city_slug,
          JSON.stringify(r.city_name ?? ""),
          r.state_code ?? "",
          r.total_clicks,
          r.unique_visitors,
          r.last_clicked_at,
        ].join(","),
      )
      .join("\n");
    const blob = new Blob([header + body + "\n"], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nearby-city-clicks-top${report.rows.length}-${report.windowDays}d.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <AdminLayout>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Top destinations from nearby-city links
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Aggregates clicks on the "Nearby pool rentals" links across every city
          page. Admin only.
        </p>

        <div className="mt-6 flex flex-wrap items-end gap-4 rounded-2xl border border-border bg-card p-4">
          <label className="text-sm">
            <span className="mr-2 text-muted-foreground">Window (days)</span>
            <input
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => setDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)))}
              className="w-24 rounded-md border border-input bg-background px-2 py-1 text-foreground"
            />
          </label>
          <label className="text-sm">
            <span className="mr-2 text-muted-foreground">Limit</span>
            <input
              type="number"
              min={1}
              max={500}
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
              className="w-24 rounded-md border border-input bg-background px-2 py-1 text-foreground"
            />
          </label>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary-glow disabled:opacity-50"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button
            onClick={downloadCsv}
            disabled={!report || report.rows.length === 0}
            className="inline-flex h-9 items-center rounded-full border border-border bg-background px-4 text-sm font-semibold text-foreground hover:bg-secondary disabled:opacity-50"
          >
            Download CSV
          </button>
          {report && (
            <span className="ml-auto text-xs text-muted-foreground">
              Generated {new Date(report.generatedAt).toLocaleString()}
            </span>
          )}
        </div>

        {err && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {err}
          </div>
        )}

        <div className="mt-6 overflow-x-auto rounded-2xl border border-border bg-card">
          <table className="min-w-full text-sm">
            <thead className="bg-secondary/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">City</th>
                <th className="px-4 py-3">Slug</th>
                <th className="px-4 py-3 text-right">Clicks</th>
                <th className="px-4 py-3 text-right">Unique visitors</th>
                <th className="px-4 py-3">Last click</th>
              </tr>
            </thead>
            <tbody>
              {(report?.rows ?? []).map((r, i) => (
                <tr key={r.to_city_slug} className="border-t border-border">
                  <td className="px-4 py-2 text-muted-foreground">{i + 1}</td>
                  <td className="px-4 py-2 font-medium text-foreground">
                    {r.city_name ? `${r.city_name}, ${r.state_code ?? ""}` : "—"}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    <a
                      href={`/s?address=${encodeURIComponent(r.to_city_slug)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-primary hover:underline"
                    >
                      {r.to_city_slug}
                    </a>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-foreground">{r.total_clicks}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-foreground">{r.unique_visitors}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {new Date(r.last_clicked_at).toLocaleString()}
                  </td>
                </tr>
              ))}
              {report && report.rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No clicks recorded in this window yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </AdminLayout>
  );
}
