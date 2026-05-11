import * as React from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";
import { listLeads, updateLeadStatus, type LeadRow } from "@/server/admin-tools.functions";

export const Route = createFileRoute("/admin/leads")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth", search: { redirect: "/admin/leads", mode: "signin" } });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({ meta: [{ title: "Lead Inbox — Admin" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: LeadInbox,
});

const STATUSES = ["all", "new", "contacted", "closed"] as const;

function LeadInbox() {
  const [status, setStatus] = React.useState<typeof STATUSES[number]>("all");
  const [rows, setRows] = React.useState<LeadRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [open, setOpen] = React.useState<LeadRow | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try { setRows((await listLeads({ data: { status, limit: 200 } })).rows); } finally { setLoading(false); }
  }, [status]);
  React.useEffect(() => { void load(); }, [load]);

  async function setLead(id: string, s: "new" | "contacted" | "closed") {
    await updateLeadStatus({ data: { id, status: s } });
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, status: s } : r)));
    if (open?.id === id) setOpen({ ...open, status: s });
  }

  return (
    <AdminLayout title="Lead Inbox">
      <h1 className="text-3xl font-bold">Lead Inbox</h1>
      <p className="text-sm text-muted-foreground">Provider leads triage.</p>

      <div className="mt-6 flex gap-2">
        {STATUSES.map((s) => (
          <button key={s} onClick={() => setStatus(s)}
            className={`rounded-full border px-3 py-1.5 text-sm capitalize ${status === s ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-muted"}`}>
            {s}
          </button>
        ))}
      </div>

      <div className="mt-4 text-sm text-muted-foreground">{loading ? "Loading…" : `${rows.length} leads`}</div>

      <div className="mt-3 overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Company</th>
              <th className="px-3 py-2">City</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border hover:bg-muted/30 cursor-pointer" onClick={() => setOpen(r)}>
                <td className="px-3 py-2 text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</td>
                <td className="px-3 py-2 font-medium">{r.name}</td>
                <td className="px-3 py-2"><a href={`mailto:${r.email}`} onClick={(e) => e.stopPropagation()} className="hover:underline">{r.email}</a></td>
                <td className="px-3 py-2">{r.company || <span className="text-muted-foreground">—</span>}</td>
                <td className="px-3 py-2 text-xs">{[r.city, r.state_code].filter(Boolean).join(", ") || "—"}</td>
                <td className="px-3 py-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-bold ${r.status === "new" ? "bg-yellow-500/20 text-yellow-700 dark:text-yellow-300" : r.status === "contacted" ? "bg-blue-500/20 text-blue-700 dark:text-blue-300" : "bg-green-500/20 text-green-700 dark:text-green-300"}`}>
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-right text-xs">View →</td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">No leads.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setOpen(null)}>
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-card p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold">{open.name}</h3>
            <dl className="mt-4 space-y-2 text-sm">
              <div><dt className="text-xs uppercase text-muted-foreground">Email</dt><dd><a href={`mailto:${open.email}`} className="hover:underline">{open.email}</a></dd></div>
              {open.phone && <div><dt className="text-xs uppercase text-muted-foreground">Phone</dt><dd>{open.phone}</dd></div>}
              {open.company && <div><dt className="text-xs uppercase text-muted-foreground">Company</dt><dd>{open.company}</dd></div>}
              {open.website && <div><dt className="text-xs uppercase text-muted-foreground">Website</dt><dd><a href={open.website} target="_blank" rel="noreferrer" className="hover:underline">{open.website}</a></dd></div>}
              {(open.city || open.state_code) && <div><dt className="text-xs uppercase text-muted-foreground">Location</dt><dd>{[open.city, open.state_code].filter(Boolean).join(", ")}</dd></div>}
              {open.source_path && <div><dt className="text-xs uppercase text-muted-foreground">Source</dt><dd className="font-mono text-xs">{open.source_path}</dd></div>}
              {open.message && <div><dt className="text-xs uppercase text-muted-foreground">Message</dt><dd className="whitespace-pre-wrap rounded bg-muted/50 p-3">{open.message}</dd></div>}
            </dl>
            <div className="mt-6 flex gap-2">
              {(["new", "contacted", "closed"] as const).map((s) => (
                <button key={s} onClick={() => setLead(open.id, s)}
                  className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium capitalize ${open.status === s ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-muted"}`}>
                  {s}
                </button>
              ))}
            </div>
            <button onClick={() => setOpen(null)} className="mt-3 w-full rounded-md border border-border px-3 py-2 text-sm">Close</button>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
