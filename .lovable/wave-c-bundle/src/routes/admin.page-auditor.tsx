import * as React from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { auditPage, listRecentAudits, type PageAuditRow } from "@/server/admin-weapons.functions";
import { AdminLayout } from "@/components/admin-layout";
import { Loader2, Sparkles, CheckCircle2, AlertTriangle, Lightbulb } from "lucide-react";

export const Route = createFileRoute("/admin/page-auditor")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth", search: { redirect: "/admin/page-auditor", mode: "signin" } });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({ meta: [{ title: "AI Page Auditor — Admin" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: PageAuditor,
});

function scoreColor(s: number | null) {
  if (s == null) return "text-muted-foreground";
  if (s >= 80) return "text-emerald-600";
  if (s >= 60) return "text-amber-600";
  return "text-destructive";
}

type Suggestion = { url_path: string; title: string | null; status: string };

function PageAuditor() {
  const [path, setPath] = React.useState("/p/");
  const [busy, setBusy] = React.useState(false);
  const [current, setCurrent] = React.useState<PageAuditRow | null>(null);
  const [history, setHistory] = React.useState<PageAuditRow[]>([]);
  const [err, setErr] = React.useState<string | null>(null);
  const [suggestions, setSuggestions] = React.useState<Suggestion[]>([]);

  const load = React.useCallback(async () => {
    const r = await listRecentAudits({ data: { limit: 30 } });
    setHistory(r.rows);
  }, []);
  React.useEffect(() => { load(); }, [load]);

  async function run(overridePath?: string) {
    const target = (overridePath ?? path).trim();
    if (!target.startsWith("/") && !/^https?:\/\//i.test(target)) {
      setErr("Path must start with / (or be a full URL)");
      return;
    }
    if (overridePath) setPath(overridePath);
    setBusy(true); setErr(null); setCurrent(null); setSuggestions([]);
    try {
      const r: any = await auditPage({ data: { url_path: target } });
      if (r.ok) { setCurrent(r.audit); await load(); }
      else {
        setErr(r.error || "audit failed");
        if (Array.isArray(r.suggestions)) setSuggestions(r.suggestions);
      }
    } catch (e: any) { setErr(e?.message || "failed"); }
    finally { setBusy(false); }
  }

  return (
    <AdminLayout title="AI Page Auditor">
      <div className="mb-4">
        <h1 className="flex items-center gap-2 text-2xl font-bold sm:text-3xl">
          <Sparkles className="h-6 w-6 text-primary" /> AI Page Auditor
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Score any /p/ page 0-100 against top-ranking competitors. Get strengths, weaknesses, and exact recommendations.
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <label className="block text-xs font-medium text-muted-foreground">Page URL path</label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/p/austin-tx"
            onKeyDown={(e) => { if (e.key === "Enter") run(); }}
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono" />
          <button onClick={() => run()} disabled={busy}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {busy ? "Auditing…" : "Audit page"}
          </button>
        </div>
        {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
        {suggestions.length > 0 && (
          <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Did you mean?</p>
            <ul className="space-y-1">
              {suggestions.map((s) => (
                <li key={s.url_path}>
                  <button onClick={() => run(s.url_path)}
                    className="group flex w-full items-center justify-between gap-3 rounded px-2 py-1 text-left text-xs hover:bg-muted">
                    <span className="font-mono group-hover:underline">{s.url_path}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{s.title || "—"} · {s.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {current && (
        <div className="mt-4 rounded-2xl border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-mono text-xs text-muted-foreground">{current.url_path}</p>
              <p className="mt-1 text-sm">{current.summary}</p>
            </div>
            <div className={`text-right ${scoreColor(current.score)}`}>
              <div className="text-4xl font-bold leading-none">{current.score ?? "—"}</div>
              <div className="text-[10px] font-bold uppercase tracking-wider">Score</div>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Section title="Strengths" icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />} items={current.strengths} />
            <Section title="Weaknesses" icon={<AlertTriangle className="h-4 w-4 text-amber-600" />} items={current.weaknesses} />
            <Section title="Recommendations" icon={<Lightbulb className="h-4 w-4 text-primary" />} items={current.recommendations} />
          </div>
        </div>
      )}

      <div className="mt-6">
        <h2 className="text-lg font-bold">Recent audits</h2>
        <div className="mt-2 space-y-1.5">
          {history.length === 0 && (
            <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No audits yet.
            </p>
          )}
          {history.map((h) => (
            <button key={h.id} onClick={() => setCurrent(h)}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-card p-3 text-left hover:bg-muted/40">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs">{h.url_path}</p>
                <p className="truncate text-xs text-muted-foreground">{h.summary}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs text-muted-foreground">{new Date(h.audited_at).toLocaleDateString()}</span>
                <span className={`text-xl font-bold ${scoreColor(h.score)}`}>{h.score ?? "—"}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </AdminLayout>
  );
}

function Section({ title, icon, items }: { title: string; icon: React.ReactNode; items: string[] }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
        {icon} {title}
      </div>
      <ul className="mt-2 space-y-1.5 text-sm">
        {items?.length ? items.map((it, i) => <li key={i} className="leading-snug">• {it}</li>) : <li className="text-xs text-muted-foreground">None</li>}
      </ul>
    </div>
  );
}
