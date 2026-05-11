import * as React from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import {
  auditListing, listListingAudits, emailListingAudit, deleteListingAudit,
  type ListingAuditRow,
} from "@/server/admin-listing-audit.functions";
import { AdminLayout } from "@/components/admin-layout";
import { Loader2, Sparkles, Mail, Trash2, CheckCircle2, AlertTriangle, Lightbulb, Camera, DollarSign } from "lucide-react";

export const Route = createFileRoute("/admin/listing-auditor")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth", search: { redirect: "/admin/listing-auditor", mode: "signin" } });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({ meta: [{ title: "Listing Auditor — Admin" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: ListingAuditor,
});

function scoreColor(s: number | null) {
  if (s == null) return "text-muted-foreground";
  if (s >= 80) return "text-emerald-600";
  if (s >= 60) return "text-amber-600";
  return "text-destructive";
}

function ListingAuditor() {
  const [url, setUrl] = React.useState("");
  const [hostEmail, setHostEmail] = React.useState("");
  const [hostName, setHostName] = React.useState("");
  const [sendNow, setSendNow] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [current, setCurrent] = React.useState<ListingAuditRow | null>(null);
  const [history, setHistory] = React.useState<ListingAuditRow[]>([]);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const r = await listListingAudits({ data: { limit: 40 } });
    setHistory(r.rows);
  }, []);
  React.useEffect(() => { load(); }, [load]);

  async function run() {
    if (!url.trim()) { setErr("Paste a listing URL first"); return; }
    if (sendNow && !hostEmail.trim()) { setErr("Add a host email or untick 'send to host'"); return; }
    setBusy(true); setErr(null); setMsg(null); setCurrent(null);
    try {
      const r: any = await auditListing({ data: {
        listing_url: url.trim(),
        host_email: hostEmail.trim() || undefined,
        host_name: hostName.trim() || undefined,
        send_email: sendNow,
      }});
      if (r.ok) {
        setCurrent(r.audit);
        await load();
        if (sendNow) {
          if (r.email?.sent) setMsg(`Audit complete and emailed to ${r.audit.host_email}`);
          else setMsg(`Audit complete. Email failed: ${r.email?.error || "unknown"}`);
        } else {
          setMsg("Audit complete.");
        }
      } else setErr(r.error || "audit failed");
    } catch (e: any) { setErr(e?.message || "failed"); }
    finally { setBusy(false); }
  }

  async function resend(row: ListingAuditRow) {
    const target = prompt("Send report to email:", row.host_email || "");
    if (!target) return;
    const r: any = await emailListingAudit({ data: { id: row.id, override_email: target } });
    if (r.ok) { setMsg(`Sent to ${target}`); await load(); }
    else setErr(r.error || "send failed");
  }

  async function remove(id: string) {
    if (!confirm("Delete this audit?")) return;
    await deleteListingAudit({ data: { id } });
    if (current?.id === id) setCurrent(null);
    await load();
  }

  return (
    <AdminLayout title="Listing Auditor">
      <div className="mb-4">
        <h1 className="flex items-center gap-2 text-2xl font-bold sm:text-3xl">
          <Sparkles className="h-6 w-6 text-primary" /> Listing Auditor
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste a marketplace pool listing URL. AI grades the listing 0-100 and emails the host a report with photo, pricing, and copy fixes.
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <label className="block text-xs font-medium text-muted-foreground">Listing URL</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://swimply.com/pooldetails/1234 or /l/abc123"
          className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono" />

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-muted-foreground">Host email (optional)</label>
            <input value={hostEmail} onChange={(e) => setHostEmail(e.target.value)} placeholder="host@example.com" type="email"
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground">Host name (optional)</label>
            <input value={hostName} onChange={(e) => setHostName(e.target.value)} placeholder="Sarah"
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
          </div>
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={sendNow} onChange={(e) => setSendNow(e.target.checked)} />
          Email the report to the host as soon as it's ready
        </label>

        <button onClick={run} disabled={busy}
          className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {busy ? "Auditing…" : "Audit listing"}
        </button>
        {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
        {msg && <p className="mt-2 text-xs text-emerald-600">{msg}</p>}
      </div>

      {current && (
        <div className="mt-4 rounded-2xl border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-semibold">{current.listing_title || "Listing"}</p>
              <a href={current.listing_url} target="_blank" rel="noreferrer" className="block truncate font-mono text-xs text-muted-foreground hover:underline">{current.listing_url}</a>
              <p className="mt-2 text-sm">{current.summary}</p>
              {current.host_email && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Host: {current.host_name || "—"} · {current.host_email} ·{" "}
                  {current.emailed_at ? `emailed ${new Date(current.emailed_at).toLocaleString()}` : (current.email_status || "not emailed")}
                </p>
              )}
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

          {(current.pricing_notes || current.photo_notes) && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {current.pricing_notes && <Note title="Pricing" icon={<DollarSign className="h-4 w-4" />} text={current.pricing_notes} />}
              {current.photo_notes && <Note title="Photos" icon={<Camera className="h-4 w-4" />} text={current.photo_notes} />}
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => resend(current)}
              className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-xs font-semibold">
              <Mail className="h-3.5 w-3.5" /> Send to host
            </button>
          </div>
        </div>
      )}

      <div className="mt-6">
        <h2 className="text-lg font-bold">Recent audits ({history.length})</h2>
        <div className="mt-2 space-y-1.5">
          {history.length === 0 && (
            <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No audits yet.
            </p>
          )}
          {history.map((h) => (
            <div key={h.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-3">
              <button onClick={() => setCurrent(h)} className="flex-1 min-w-0 text-left">
                <p className="truncate font-medium text-sm">{h.listing_title || h.listing_url}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {h.host_email || "no host email"} · {h.emailed_at ? `emailed ${new Date(h.emailed_at).toLocaleDateString()}` : (h.email_status || "not emailed")}
                </p>
              </button>
              <div className="flex shrink-0 items-center gap-2">
                <span className={`text-xl font-bold ${scoreColor(h.score)}`}>{h.score ?? "—"}</span>
                <button onClick={() => resend(h)} className="rounded-full bg-secondary p-1.5" title="Email host">
                  <Mail className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => remove(h.id)} className="rounded-full border border-border p-1.5 text-destructive">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
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

function Note({ title, icon, text }: { title: string; icon: React.ReactNode; text: string }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
        {icon} {title}
      </div>
      <p className="mt-1.5 text-sm leading-snug">{text}</p>
    </div>
  );
}
