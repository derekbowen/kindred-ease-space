import * as React from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";
import { listPrivacyRequests } from "@/server/privacy-requests.functions";

export const Route = createFileRoute("/admin/privacy-requests")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user)
      throw redirect({ to: "/auth", search: { redirect: "/admin/privacy-requests", mode: "signin" } });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({
    meta: [
      { title: "Privacy Requests — Admin" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: PrivacyRequestsAdmin,
});

type Row = {
  id: string;
  request_type: string;
  email: string;
  full_name: string | null;
  state_code: string | null;
  details: string | null;
  gpc_signal: boolean | null;
  source_url: string | null;
  status: string;
  created_at: string;
};

function PrivacyRequestsAdmin() {
  const [rows, setRows] = React.useState<Row[]>([]);
  const [loading, setLoading] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await listPrivacyRequests();
      setRows((res.rows as Row[]) ?? []);
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  return (
    <AdminLayout>
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        <h1 className="text-2xl font-bold text-foreground">Privacy requests</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          High-engagement signal — privacy-engaged users are stickier. {rows.length} total.
        </p>
        {loading && <p className="mt-4 text-sm text-muted-foreground">Loading…</p>}
        <div className="mt-6 overflow-x-auto rounded-lg border border-border">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-left font-medium">Type</th>
                <th className="px-3 py-2 text-left font-medium">Email</th>
                <th className="px-3 py-2 text-left font-medium">Name</th>
                <th className="px-3 py-2 text-left font-medium">State</th>
                <th className="px-3 py-2 text-left font-medium">GPC</th>
                <th className="px-3 py-2 text-left font-medium">Source</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-background">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2">{r.request_type}</td>
                  <td className="px-3 py-2">{r.email}</td>
                  <td className="px-3 py-2">{r.full_name ?? "—"}</td>
                  <td className="px-3 py-2">{r.state_code ?? "—"}</td>
                  <td className="px-3 py-2">{r.gpc_signal ? "✓" : "—"}</td>
                  <td className="px-3 py-2 max-w-[180px] truncate" title={r.source_url ?? ""}>{r.source_url ?? "—"}</td>
                  <td className="px-3 py-2">{r.status}</td>
                  <td className="px-3 py-2 max-w-[280px] truncate" title={r.details ?? ""}>{r.details ?? "—"}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">No requests yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AdminLayout>
  );
}
