import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";
import {
  scanContentHealth,
  type ContentHealthReport,
} from "@/server/content-health.functions";

export const Route = createFileRoute("/admin/content-health")({
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" as never });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  component: ContentHealthPage,
  head: () => ({ meta: [{ title: "Content health — Admin" }] }),
});

const PROD_ORIGIN = "https://www.poolrentalnearme.com";

function ContentHealthPage() {
  const [minLength, setMinLength] = useState(500);
  const [onlyInSitemap, setOnlyInSitemap] = useState(false);
  const [filter, setFilter] = useState<"all" | "missing" | "blank" | "thin">("all");
  const [report, setReport] = useState<ContentHealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const res = await scanContentHealth({
        data: { minLength, limit: 5000, onlyInSitemap },
      });
      setReport(res);
    } catch (e: any) {
      setErr(e?.message ?? "Scan failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => {
    if (!report) return [];
    return filter === "all" ? report.rows : report.rows.filter((r) => r.reason === filter);
  }, [report, filter]);

  const exportCsv = () => {
    if (!report) return;
    const header = ["url_path", "reason", "body_len", "locale", "template_type", "in_sitemap", "title"];
    const escape = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [header.join(",")];
    for (const r of visible) {
      lines.push(
        [r.url_path, r.reason, r.body_len, r.locale, r.template_type ?? "", r.in_sitemap, r.title ?? ""]
          .map(escape)
          .join(","),
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `content-health-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AdminLayout title="Content health">
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <header>
          <h1 className="text-2xl font-bold text-foreground">Content health</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Scans published <code className="rounded bg-muted px-1 py-0.5">content_pages</code> for
            missing, blank, or thin <code className="rounded bg-muted px-1 py-0.5">body_markdown</code>.
            Live URLs listed below render an empty body to real visitors.
          </p>
        </header>

        <div className="flex flex-wrap items-end gap-4 rounded-lg border border-border bg-card p-4">
          <label className="text-sm">
            <div className="mb-1 font-medium text-foreground">Thin threshold (chars)</div>
            <input
              type="number"
              min={0}
              max={10000}
              value={minLength}
              onChange={(e) => setMinLength(Number(e.target.value) || 0)}
              className="w-32 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={onlyInSitemap}
              onChange={(e) => setOnlyInSitemap(e.target.checked)}
            />
            Only pages in sitemap
          </label>
          <button
            onClick={load}
            disabled={loading}
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {loading ? "Scanning…" : "Re-scan"}
          </button>
          <button
            onClick={exportCsv}
            disabled={!report || visible.length === 0}
            className="rounded-md border border-border px-4 py-2 text-sm font-semibold text-foreground disabled:opacity-50"
          >
            Export CSV
          </button>
        </div>

        {err && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {err}
          </div>
        )}

        {report && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Published" value={report.totalPublished} />
              <Stat label="Affected" value={report.totalAffected} tone="warn" />
              <Stat label="Missing / blank" value={report.byReason.missing + report.byReason.blank} tone="bad" />
              <Stat label={`Thin (<${report.minLength})`} value={report.byReason.thin} />
            </div>

            <div className="flex gap-2">
              {(["all", "missing", "blank", "thin"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                    filter === f
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-foreground hover:bg-muted"
                  }`}
                >
                  {f}
                  {f !== "all" && (
                    <span className="ml-1 opacity-70">({report.byReason[f]})</span>
                  )}
                </button>
              ))}
            </div>

            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">URL</th>
                    <th className="px-3 py-2">Reason</th>
                    <th className="px-3 py-2">Body</th>
                    <th className="px-3 py-2">Locale</th>
                    <th className="px-3 py-2">Template</th>
                    <th className="px-3 py-2">Sitemap</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                        No affected pages.
                      </td>
                    </tr>
                  )}
                  {visible.map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-3 py-2">
                        <a
                          href={`${PROD_ORIGIN}${r.url_path}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline"
                        >
                          {r.url_path}
                        </a>
                        {r.title && (
                          <div className="truncate text-xs text-muted-foreground">{r.title}</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <ReasonPill reason={r.reason} />
                      </td>
                      <td className="px-3 py-2 tabular-nums">{r.body_len}</td>
                      <td className="px-3 py-2">{r.locale}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {r.template_type || "—"}
                      </td>
                      <td className="px-3 py-2 text-xs">{r.in_sitemap ? "yes" : "no"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-xs text-muted-foreground">
              Scanned at {new Date(report.ranAt).toLocaleString()} · showing {visible.length} of{" "}
              {report.totalAffected} affected
            </p>
          </>
        )}
      </div>
    </AdminLayout>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "warn" | "bad";
}) {
  const color =
    tone === "bad"
      ? "text-destructive"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${color}`}>{value.toLocaleString()}</div>
    </div>
  );
}

function ReasonPill({ reason }: { reason: "missing" | "blank" | "thin" }) {
  const styles =
    reason === "missing"
      ? "bg-destructive/15 text-destructive"
      : reason === "blank"
        ? "bg-destructive/15 text-destructive"
        : "bg-amber-500/15 text-amber-700 dark:text-amber-300";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>{reason}</span>;
}
