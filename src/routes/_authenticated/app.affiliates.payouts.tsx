import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { getMe } from "@/lib/auth.functions";
import { listPayouts, setPayoutStatus } from "@/lib/affiliates.functions";

export const Route = createFileRoute("/_authenticated/app/affiliates/payouts")({
  head: () => ({ meta: [{ title: "Payouts — founders.click" }] }),
  component: PayoutsPage,
});

const STATUS_TABS = ["all", "pending", "ready", "paid", "rejected"] as const;

function PayoutsPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof STATUS_TABS)[number]>("pending");
  const qc = useQueryClient();
  const setStatus = useServerFn(setPayoutStatus);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me?.memberships?.[0]?.workspace_id ?? null)).catch(() => {});
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["affiliate-payouts", workspaceId, tab],
    queryFn: () => listPayouts({ data: { workspaceId: workspaceId!, status: tab === "all" ? undefined : tab } }),
    enabled: !!workspaceId,
  });

  const act = async (id: string, status: "ready" | "paid" | "rejected" | "pending") => {
    try {
      await setStatus({ data: { workspaceId: workspaceId!, id, status } });
      await qc.invalidateQueries({ queryKey: ["affiliate-payouts", workspaceId] });
    } catch (err) { toast.error(err instanceof Error ? err.message : "Failed"); }
  };

  const counts = data?.counts ?? {};

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Payouts</h1>
      <div className="grid grid-cols-3 gap-4">
        {(["pending", "ready", "paid"] as const).map((s) => (
          <Card key={s}><CardHeader className="pb-1"><CardDescription className="capitalize">{s}</CardDescription></CardHeader><CardContent className="text-2xl font-bold">{counts[s] ?? 0}</CardContent></Card>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        {STATUS_TABS.map((t) => (
          <Button key={t} size="sm" variant={tab === t ? "default" : "outline"} className="capitalize" onClick={() => setTab(t)}>
            {t}{t !== "all" && counts[t] != null ? ` (${counts[t]})` : ""}
          </Button>
        ))}
      </div>
      {isLoading ? <Skeleton className="h-40" /> : (data?.payouts ?? []).length === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No payouts in this view.</CardContent></Card>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr><th className="p-2">Date</th><th className="p-2">Affiliate</th><th className="p-2">Program</th><th className="p-2">Event</th><th className="p-2">Owed</th><th className="p-2">Status</th><th className="p-2 text-right">Actions</th></tr>
            </thead>
            <tbody>
              {data!.payouts.map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="p-2 whitespace-nowrap">{new Date(p.created_at).toLocaleDateString()}</td>
                  <td className="p-2">{p.affiliate_name}</td>
                  <td className="p-2">{p.program_name}</td>
                  <td className="p-2 capitalize">{p.event_type}</td>
                  <td className="p-2 tabular-nums">{p.amount.toFixed(2)}</td>
                  <td className="p-2 capitalize">
                    <Badge variant={p.status === "paid" ? "default" : p.status === "rejected" ? "destructive" : "secondary"} className={p.status === "paid" ? "bg-emerald-600" : ""}>{p.status}</Badge>
                  </td>
                  <td className="p-2 text-right space-x-1 whitespace-nowrap">
                    {p.status === "pending" && <Button size="sm" variant="outline" onClick={() => act(p.id, "ready")}>Approve</Button>}
                    {p.status === "ready" && <Button size="sm" onClick={() => act(p.id, "paid")}>Mark paid</Button>}
                    {(p.status === "pending" || p.status === "ready") && <Button size="sm" variant="ghost" onClick={() => act(p.id, "rejected")}>Reject</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
