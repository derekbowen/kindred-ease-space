import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { adminListPlanRequests, adminReviewPlanRequest } from "@/server/directory.functions";
import { AdminLayout } from "@/components/admin-layout";
import { buildMeta } from "@/lib/seo";

export const Route = createFileRoute("/admin/plan-requests")({
  loader: () => adminListPlanRequests(),
  head: () => buildMeta({ title: "Plan Requests | Admin", description: "Review provider plan and payment requests", path: "/admin/plan-requests", noindex: true }),
  component: AdminPlanRequestsPage,
  errorComponent: ({ error }) => (
    <AdminLayout>
        <h1 className="text-2xl font-bold">Not authorized</h1>
        <p className="mt-2 text-muted-foreground">{error.message}</p>
      </AdminLayout>
  ),
});

function fmt(d?: string | null) { return d ? new Date(d).toLocaleString() : "—"; }

function AdminPlanRequestsPage() {
  const initial = Route.useLoaderData() as { requests: any[] };
  const [requests, setRequests] = useState(initial.requests);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function act(id: string, action: "approve" | "reject" | "delete") {
    setBusy(id);
    setError("");
    try {
      await adminReviewPlanRequest({ data: { id, action, admin_notes: notes[id] } });
      if (action === "delete") {
        setRequests((rs) => rs.filter((r) => r.id !== id));
      } else {
        setRequests((rs) => rs.map((r) =>
          r.id === id ? { ...r, status: action === "approve" ? "approved" : "rejected", reviewed_at: new Date().toISOString(), admin_notes: notes[id] ?? r.admin_notes } : r,
        ));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  const pending = requests.filter((r) => r.status === "pending");
  const reviewed = requests.filter((r) => r.status !== "pending");

  return (
    <AdminLayout>
        <div className="mb-6 flex items-center justify-between">
          <div>
            <Link to="/admin/dashboard" className="text-sm text-primary underline">← Admin</Link>
            <h1 className="mt-2 text-3xl font-bold">Plan & payment requests</h1>
          </div>
        </div>
        {error && <div className="mb-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-900">{error}</div>}

        <h2 className="text-lg font-semibold">Pending ({pending.length})</h2>
        <ul className="mt-3 space-y-3">
          {pending.length === 0 && <li className="text-sm text-muted-foreground">Nothing pending.</li>}
          {pending.map((r) => (
            <li key={r.id} className="rounded-2xl border bg-card p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Link to="/providers/$slug" params={{ slug: r.provider_slug }} className="font-semibold text-primary underline">{r.provider_slug}</Link>
                <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800 capitalize">{r.requested_plan}</span>
                <span className="text-sm">${r.amount_usd ?? "—"}</span>
                <span className="ml-auto text-xs text-muted-foreground">{fmt(r.created_at)}</span>
              </div>
              <div className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                <div><strong>Requester:</strong> {r.requester_name} &lt;{r.requester_email}&gt;{r.requester_phone ? ` · ${r.requester_phone}` : ""}</div>
                <div><strong>Payment:</strong> {r.payment_method || "—"} · {r.payment_reference || "no reference"}</div>
                {r.notes && <div className="sm:col-span-2"><strong>Notes:</strong> {r.notes}</div>}
              </div>
              <textarea
                placeholder="Admin notes (optional)"
                value={notes[r.id] ?? ""}
                onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
                rows={2}
                className="mt-3 w-full rounded-lg border px-3 py-2 text-sm"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <button disabled={busy === r.id} onClick={() => act(r.id, "approve")} className="rounded-full bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50">Approve & apply plan</button>
                <button disabled={busy === r.id} onClick={() => act(r.id, "reject")} className="rounded-full border px-4 py-1.5 text-sm font-semibold disabled:opacity-50">Reject</button>
                <button disabled={busy === r.id} onClick={() => act(r.id, "delete")} className="ml-auto rounded-full px-4 py-1.5 text-sm font-semibold text-rose-700 disabled:opacity-50">Delete</button>
              </div>
            </li>
          ))}
        </ul>

        <h2 className="mt-10 text-lg font-semibold">Reviewed ({reviewed.length})</h2>
        <ul className="mt-3 space-y-2">
          {reviewed.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-4 py-2 text-sm">
              <Link to="/providers/$slug" params={{ slug: r.provider_slug }} className="font-semibold text-primary underline">{r.provider_slug}</Link>
              <span className="capitalize">{r.requested_plan}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${r.status === "approved" ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}>{r.status}</span>
              <span className="text-muted-foreground">${r.amount_usd ?? "—"}</span>
              <span className="ml-auto text-xs text-muted-foreground">{fmt(r.reviewed_at)}</span>
              <button onClick={() => act(r.id, "delete")} className="text-xs text-rose-700 underline">delete</button>
            </li>
          ))}
        </ul>
      </AdminLayout>
  );
}
