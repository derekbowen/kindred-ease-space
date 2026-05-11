import * as React from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";
import {
  getEmailVerifyBalance,
  getEmailVerifyStats,
  verifyHostLeadBatch,
  listVerifiedLeads,
} from "@/server/admin-email-verify.functions";
import { Loader2, Mail, CheckCircle2, XCircle, RefreshCw, Play } from "lucide-react";

export const Route = createFileRoute("/admin/email-verify")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth", search: { redirect: "/admin/email-verify", mode: "signin" } });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({ meta: [{ title: "Email verify — Admin" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: EmailVerifyPage,
});

function EmailVerifyPage() {
  const [balance, setBalance] = React.useState<{ credits: number; status: string } | null>(null);
  const [stats, setStats] = React.useState<any>(null);
  const [rows, setRows] = React.useState<any[]>([]);
  const [filter, setFilter] = React.useState<"all" | "sendable" | "invalid" | "unverified">("unverified");
  const [batchSize, setBatchSize] = React.useState(25);
  const [running, setRunning] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [lastResults, setLastResults] = React.useState<any[]>([]);

  async function load() {
    const [b, s, l] = await Promise.all([
      getEmailVerifyBalance(),
      getEmailVerifyStats(),
      listVerifiedLeads({ data: { filter } }),
    ]);
    if ((b as any).ok) setBalance({ credits: (b as any).credits, status: (b as any).status });
    else setMsg((b as any).error || "Balance error");
    if ((s as any).ok) setStats(s);
    if ((l as any).ok) setRows((l as any).rows);
  }

  React.useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter]);

  async function runBatch() {
    setRunning(true); setMsg(null); setLastResults([]);
    try {
      const r: any = await verifyHostLeadBatch({ data: { limit: batchSize } });
      if (!r.ok) { setMsg(r.error); return; }
      setLastResults(r.results || []);
      setMsg(`Verified ${r.processed} email${r.processed === 1 ? "" : "s"}.${r.message ? " " + r.message : ""}`);
      await load();
    } finally { setRunning(false); }
  }

  return (
    <AdminLayout title="Email verify">
      <div className="space-y-6">
        {/* Top bar */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card label="API credits" value={balance ? balance.credits.toLocaleString() : "—"} icon={<Mail className="h-5 w-5" />} />
          <Card label="Total leads" value={stats?.total ?? "—"} />
          <Card label="Sendable" value={stats?.sendable ?? "—"} tone="good" icon={<CheckCircle2 className="h-5 w-5" />} />
          <Card label="Invalid / risky" value={stats?.invalid ?? "—"} tone="bad" icon={<XCircle className="h-5 w-5" />} />
        </div>

        {/* Action bar */}
        <div className="bg-card border rounded-lg p-4 flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium">Verify next</span>
          <select
            value={batchSize}
            onChange={(e) => setBatchSize(Number(e.target.value))}
            className="border rounded px-2 py-1.5 text-sm bg-background"
          >
            {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <span className="text-sm text-muted-foreground">unverified leads</span>
          <button
            onClick={runBatch}
            disabled={running || !balance || balance.credits < batchSize}
            className="ml-auto inline-flex items-center gap-2 px-4 py-2 rounded bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {running ? "Verifying..." : "Run batch"}
          </button>
          <button onClick={load} className="inline-flex items-center gap-2 px-3 py-2 rounded border text-sm">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        </div>

        {msg && <div className="text-sm bg-muted px-3 py-2 rounded">{msg}</div>}

        {/* Last batch breakdown */}
        {lastResults.length > 0 && (
          <div className="bg-card border rounded-lg p-4">
            <h3 className="font-semibold mb-2 text-sm">Last batch results</h3>
            <div className="space-y-1 text-xs font-mono max-h-60 overflow-auto">
              {lastResults.map((r) => (
                <div key={r.id} className="flex justify-between gap-2 border-b py-1">
                  <span className="truncate">{r.email}</span>
                  <span className={r.sendable ? "text-emerald-600" : "text-rose-600"}>
                    {r.status}{r.sub_status ? ` / ${r.sub_status}` : ""}{r.error ? ` — ${r.error}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Status breakdown */}
        {stats?.byStatus && Object.keys(stats.byStatus).length > 0 && (
          <div className="bg-card border rounded-lg p-4">
            <h3 className="font-semibold mb-2 text-sm">Verified breakdown</h3>
            <div className="flex flex-wrap gap-2">
              {Object.entries(stats.byStatus).map(([k, v]) => (
                <span key={k} className="text-xs bg-muted px-2 py-1 rounded">
                  {k}: <strong>{v as number}</strong>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Filter + table */}
        <div className="flex gap-2">
          {(["unverified", "sendable", "invalid", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-sm rounded border ${filter === f ? "bg-primary text-primary-foreground" : ""}`}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="bg-card border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted text-xs">
              <tr>
                <th className="text-left px-3 py-2">Email</th>
                <th className="text-left px-3 py-2">Name</th>
                <th className="text-left px-3 py-2">City</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Sendable</th>
                <th className="text-left px-3 py-2">Verified</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No leads</td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{r.email}</td>
                  <td className="px-3 py-2">{r.name}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.city || "—"}</td>
                  <td className="px-3 py-2">
                    {r.email_status ? (
                      <span className="text-xs">{r.email_status}{r.email_sub_status ? ` / ${r.email_sub_status}` : ""}</span>
                    ) : <span className="text-muted-foreground text-xs">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    {r.email_sendable === true && <span className="text-emerald-600 text-xs font-medium">✓ yes</span>}
                    {r.email_sendable === false && <span className="text-rose-600 text-xs font-medium">✗ no</span>}
                    {r.email_sendable === null && <span className="text-muted-foreground text-xs">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {r.email_verified_at ? new Date(r.email_verified_at).toLocaleDateString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-muted-foreground">
          Sendable = status "valid". "Risky", "unknown", "catch-all", and invalid are auto-excluded from any future email sends.
          Verified leads are skipped on subsequent batches.
        </p>
      </div>
    </AdminLayout>
  );
}

function Card({ label, value, icon, tone }: { label: string; value: any; icon?: React.ReactNode; tone?: "good" | "bad" }) {
  const toneCls = tone === "good" ? "text-emerald-600" : tone === "bad" ? "text-rose-600" : "";
  return (
    <div className="bg-card border rounded-lg p-4">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        {icon && <span className={toneCls}>{icon}</span>}
      </div>
      <div className={`text-2xl font-bold mt-1 ${toneCls}`}>{value}</div>
    </div>
  );
}
