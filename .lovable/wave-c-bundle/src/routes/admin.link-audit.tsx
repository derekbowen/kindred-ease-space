import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AdminLayout } from "@/components/admin-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  getLinkAuditDashboard,
  type AuditDashboard,
  type AuditLinkRow,
} from "@/server/link-audit-dashboard.functions";

export const Route = createFileRoute("/admin/link-audit")({
  component: LinkAuditPage,
});

type RunPhase = "idle" | "crawling" | "refreshing";
type LastRun = { checked: number; brokenCount: number; durationMs: number; at: number } | null;

function secondsAgo(at: number) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function LinkAuditPage() {
  const [data, setData] = React.useState<AuditDashboard | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [klass, setKlass] = React.useState<"all" | "broken" | "redirected">("all");
  const [templateType, setTemplateType] = React.useState<string>("");
  const [runs, setRuns] = React.useState<number>(10);
  const [limit, setLimit] = React.useState<number>(100);
  const [maxToCheck, setMaxToCheck] = React.useState<number>(60);

  const [phase, setPhase] = React.useState<RunPhase>("idle");
  const [elapsed, setElapsed] = React.useState(0);
  const [lastRun, setLastRun] = React.useState<LastRun>(null);
  const [autoRefresh, setAutoRefresh] = React.useState(false);
  const [, forceTick] = React.useReducer((x) => x + 1, 0);

  const load = React.useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await getLinkAuditDashboard({
        data: { limit, runs, klass, templateType: templateType || undefined },
      });
      setData(res);
    } catch (e: any) {
      if (!silent) toast.error(e.message ?? "Failed to load audit");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [klass, templateType, runs, limit]);

  React.useEffect(() => { void load(); }, [load]);

  // Live elapsed counter while crawling
  React.useEffect(() => {
    if (phase !== "crawling") return;
    const start = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Math.round((Date.now() - start) / 100) / 10), 100);
    return () => clearInterval(id);
  }, [phase]);

  // Re-tick "X ago" label every 5s when there's a last run
  React.useEffect(() => {
    if (!lastRun) return;
    const id = setInterval(forceTick, 5_000);
    return () => clearInterval(id);
  }, [lastRun]);

  // Auto-refresh dashboard every 30s when enabled
  React.useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => { void load(true); }, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  async function runCheck() {
    setPhase("crawling");
    try {
      const r = await fetch(`/api/public/link-health?persist=1&source=manual&max=${maxToCheck}`, { method: "POST" });
      const j = await r.json();
      const at = Date.now();
      setLastRun({ checked: j.checked, brokenCount: j.brokenCount, durationMs: j.durationMs, at });
      toast.success(`Checked ${j.checked} URLs · ${j.brokenCount} broken · ${(j.durationMs / 1000).toFixed(1)}s`);
      setPhase("refreshing");
      await load(true);
    } catch (e: any) {
      toast.error(e?.message || "Check failed");
    } finally {
      setPhase("idle");
    }
  }

  const phaseLabel =
    phase === "crawling" ? `Crawling… ${elapsed.toFixed(1)}s · up to ${maxToCheck} URLs`
    : phase === "refreshing" ? "Refreshing results…"
    : lastRun ? `Last run ${secondsAgo(lastRun.at)} ago · ${lastRun.checked} checked · ${lastRun.brokenCount} broken · ${(lastRun.durationMs / 1000).toFixed(1)}s`
    : "Idle — click Run check now to start a crawl";

  return (
    <AdminLayout title="Link Audit">
      <style>{`@keyframes la_progress { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }`}</style>

      <div className="mb-6 grid gap-4 md:grid-cols-[1fr_1fr_auto_auto_auto_auto]">
        <div>
          <label className="text-xs text-muted-foreground">Status</label>
          <select
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={klass}
            onChange={(e) => setKlass(e.target.value as any)}
          >
            <option value="all">All</option>
            <option value="broken">Broken (4xx/5xx/timeout)</option>
            <option value="redirected">Redirected (3xx)</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Page type (template_type)</label>
          <select
            className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={templateType}
            onChange={(e) => setTemplateType(e.target.value)}
          >
            <option value="">All page types</option>
            {(data?.templateTypes || []).map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Runs</label>
          <input type="number" min={1} max={50}
            className="mt-1 h-10 w-20 rounded-md border border-input bg-background px-3 text-sm"
            value={runs} onChange={(e) => setRuns(Number(e.target.value) || 10)} />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Limit</label>
          <input type="number" min={10} max={500}
            className="mt-1 h-10 w-20 rounded-md border border-input bg-background px-3 text-sm"
            value={limit} onChange={(e) => setLimit(Number(e.target.value) || 100)} />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Crawl max</label>
          <input type="number" min={10} max={150}
            className="mt-1 h-10 w-20 rounded-md border border-input bg-background px-3 text-sm"
            value={maxToCheck} onChange={(e) => setMaxToCheck(Number(e.target.value) || 60)} />
        </div>
        <div className="flex items-end gap-2">
          <Button onClick={() => load()} disabled={loading || phase !== "idle"} variant="outline">
            {loading ? "Loading…" : "Refresh"}
          </Button>
          <Button onClick={runCheck} disabled={phase !== "idle"}>
            {phase === "crawling" ? `Crawling ${elapsed.toFixed(1)}s…` : phase === "refreshing" ? "Refreshing…" : "▶ Run check now"}
          </Button>
        </div>
      </div>

      <div className="mb-4 rounded-md border border-border bg-card p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm">
            <span className={`inline-block h-2 w-2 rounded-full ${
              phase === "crawling" ? "animate-pulse bg-amber-500"
              : phase === "refreshing" ? "animate-pulse bg-blue-500"
              : "bg-emerald-500"}`} />
            <span className="font-medium">{phaseLabel}</span>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto-refresh dashboard every 30s
          </label>
        </div>
        {phase !== "idle" && (
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/3 bg-primary" style={{ animation: "la_progress 1.2s ease-in-out infinite" }} />
          </div>
        )}
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Runs aggregated" value={data?.runsConsidered ?? "—"} />
        <StatCard label="Broken entries (raw)" value={data?.totalBrokenEntries ?? "—"} />
        <StatCard label="Distinct paths shown" value={data?.rows.length ?? "—"} />
      </div>

      <Card>
        <CardHeader><CardTitle>Top problem links</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-left">
                <Th>Status</Th>
                <Th>Path</Th>
                <Th className="text-right">Hits</Th>
                <Th>HTTP</Th>
                <Th>Reason</Th>
                <Th>Source pages</Th>
                <Th>{""}</Th>
              </tr>
            </thead>
            <tbody>
              {(data?.rows || []).map((r) => <Row key={r.path} row={r} />)}
              {!loading && data && data.rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    No problem links match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </AdminLayout>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground ${className ?? ""}`}>{children}</th>;
}

function StatCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}

function Row({ row }: { row: AuditLinkRow }) {
  const [recheck, setRecheck] = React.useState<{ status: number; ok: boolean; loading: boolean } | null>(null);
  const tone =
    row.klass === "broken" ? "destructive"
    : row.klass === "redirected" ? "secondary"
    : "outline";

  async function doRecheck() {
    setRecheck({ status: 0, ok: false, loading: true });
    try {
      const r2 = await fetch(
        `/api/public/link-health?seeds=${encodeURIComponent(row.path)}&max=1&persist=0`,
        { method: "POST" }
      );
      if (!r2.ok) throw new Error(`Health endpoint returned HTTP ${r2.status}`);
      const j = await r2.json();
      const entry = (j.broken || []).find((b: any) => b.path === row.path);
      const status = entry ? entry.status : 200;
      const ok = !entry;
      setRecheck({ status, ok, loading: false });
      toast[ok ? "success" : "error"](
        `${row.path}: ${ok ? "200 OK" : entry?.reason || `HTTP ${status}`}`
      );
    } catch (e: any) {
      setRecheck({ status: 0, ok: false, loading: false });
      toast.error(e?.message || "Recheck failed");
    }
  }

  return (
    <tr className="border-t border-border align-top">
      <td className="px-3 py-2">
        <Badge variant={tone as any}>{row.klass}</Badge>
        {recheck && !recheck.loading && (
          <Badge variant={recheck.ok ? "secondary" : "destructive"} className="ml-1 text-[10px]">
            now: {recheck.ok ? "200" : recheck.status || "fail"}
          </Badge>
        )}
      </td>
      <td className="px-3 py-2 font-mono text-xs break-all">
        <a href={"https://www.poolrentalnearme.com" + row.path} target="_blank" rel="noreferrer" className="hover:underline">{row.path}</a>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{row.hits}</td>
      <td className="px-3 py-2 tabular-nums">{row.status ?? "—"}</td>
      <td className="px-3 py-2 text-xs text-muted-foreground max-w-[280px] break-words">{row.reason || "—"}</td>
      <td className="px-3 py-2 text-xs">
        {row.sources.length === 0 ? (
          <span className="text-muted-foreground">(seed)</span>
        ) : (
          <ul className="space-y-1">
            {row.sources.slice(0, 8).map((s) => (
              <li key={s.path} className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono">{s.path}</span>
                {s.templateType && <Badge variant="outline" className="text-[10px]">{s.templateType}</Badge>}
              </li>
            ))}
            {row.sources.length > 8 && (
              <li className="text-muted-foreground">+{row.sources.length - 8} more</li>
            )}
          </ul>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <Button size="sm" variant="outline" onClick={doRecheck} disabled={recheck?.loading}>
          {recheck?.loading ? "…" : "Recheck"}
        </Button>
      </td>
    </tr>
  );
}
