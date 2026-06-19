import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { getMe } from "@/lib/auth.functions";
import { getAffiliateDashboard, startAffiliateTrial } from "@/lib/affiliates.functions";

export const Route = createFileRoute("/_authenticated/app/affiliates")({
  head: () => ({ meta: [{ title: "Affiliate Dashboard — founders.click" }] }),
  component: AffiliateDashboard,
});

function fmtMoney(n: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

function AffiliateDashboard() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const qc = useQueryClient();
  const startTrial = useServerFn(startAffiliateTrial);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me?.memberships?.[0]?.workspace_id ?? null)).catch(() => {});
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["affiliate-dashboard", workspaceId],
    queryFn: () => getAffiliateDashboard({ data: { workspaceId: workspaceId! } }),
    enabled: !!workspaceId,
  });

  if (!workspaceId || isLoading) {
    return <div className="space-y-4"><Skeleton className="h-8 w-64" /><div className="grid grid-cols-2 md:grid-cols-4 gap-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div></div>;
  }

  const addon = data?.addon;
  const active = addon?.status === "active" || addon?.status === "trialing";
  const currency = data?.currency ?? "USD";
  const k = data?.kpis;

  if (!active) {
    return (
      <div className="max-w-xl space-y-4">
        <h1 className="text-2xl font-bold">Affiliate Programs</h1>
        <Card>
          <CardHeader>
            <CardTitle>Turn your members into a sales force</CardTitle>
            <CardDescription>
              Run referral/affiliate programs on your Sharetribe marketplace — track referred sign-ups
              and transactions, manage affiliates, and issue payouts. Start a free 14-day trial.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button
              disabled={starting}
              onClick={async () => {
                setStarting(true);
                try {
                  await startTrial({ data: { workspaceId } });
                  await qc.invalidateQueries({ queryKey: ["affiliate-dashboard", workspaceId] });
                  toast.success("Affiliate add-on trial started.");
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Could not start trial");
                } finally {
                  setStarting(false);
                }
              }}
            >
              {starting ? "Starting…" : "Start free trial"}
            </Button>
            <Button variant="outline" asChild><Link to="/app/addons">View add-ons</Link></Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const cards: Array<{ label: string; value: string }> = [
    { label: "GMV", value: fmtMoney(k?.gmv ?? 0, currency) },
    { label: "Marketplace Revenue", value: fmtMoney(k?.marketplace_revenue ?? 0, currency) },
    { label: "Total Payouts", value: fmtMoney(k?.total_payouts ?? 0, currency) },
    { label: "Conversion Rate", value: `${(k?.conversion_rate ?? 0).toFixed(1)}%` },
    { label: "Active Affiliates", value: String(k?.active_affiliates ?? 0) },
    { label: "Active Programs", value: String(k?.active_programs ?? 0) },
    { label: "Referred Users", value: String(k?.referred_users ?? 0) },
    { label: "Converted Referred", value: String(k?.converted_referred_users ?? 0) },
  ];
  const series = data?.series ?? [];
  const maxGmv = Math.max(1, ...series.map((s) => s.gmv));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Affiliate Dashboard</h1>
        {addon?.status === "trialing" && (
          <span className="text-xs rounded-full bg-orange-500/10 text-orange-500 px-3 py-1">Trial</span>
        )}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardHeader className="pb-1"><CardDescription>{c.label}</CardDescription></CardHeader>
            <CardContent className="text-2xl font-bold">{c.value}</CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Performance over time (12 months)</CardTitle>
        </CardHeader>
        <CardContent>
          {series.every((s) => s.gmv === 0) ? (
            <p className="text-sm text-muted-foreground">No transaction data yet. It appears once transactions sync from Sharetribe.</p>
          ) : (
            <div className="flex items-end gap-1 h-40">
              {series.map((s) => (
                <div key={s.month} className="flex-1 flex flex-col items-center gap-1" title={`${s.month}: ${fmtMoney(s.gmv, currency)}`}>
                  <div className="w-full rounded-t bg-orange-500/70" style={{ height: `${(s.gmv / maxGmv) * 100}%`, minHeight: s.gmv > 0 ? 2 : 0 }} />
                  <span className="text-[9px] text-muted-foreground">{s.month.slice(5)}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
