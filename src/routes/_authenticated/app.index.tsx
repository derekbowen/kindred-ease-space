import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Sparkles, FileText, Store, Coins, BarChart3 } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { getWorkspaceOverview } from "@/lib/workspace.functions";
import { DailyBriefing } from "@/components/coach/DailyBriefing";
import { SetupChecklist } from "@/components/dashboard/SetupChecklist";

export const Route = createFileRoute("/_authenticated/app/")({
  head: () => ({ meta: [{ title: "Dashboard — founders.click" }] }),
  component: DashboardPage,
});

function DashboardPage() {
  const navigate = useNavigate();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async (attempt = 0): Promise<void> => {
      try {
        const me = await getMe();
        const wsId = me?.memberships?.[0]?.workspace_id ?? null;
        if (cancelled) return;
        if (wsId) {
          setWorkspaceId(wsId);
          return;
        }
        if (attempt < 12) setTimeout(() => poll(attempt + 1), 400);
      } catch (err) {
        const status = (err as { status?: number; response?: { status?: number } })?.status
          ?? (err as { response?: { status?: number } })?.response?.status;
        if (status === 401) navigate({ to: "/login", search: { next: "/app" } });
        else console.error("getMe failed", err);
      }
    };
    poll();
    return () => { cancelled = true; };
  }, [navigate]);

  const { data, isLoading } = useQuery({
    queryKey: ["workspace-overview", workspaceId],
    queryFn: () => getWorkspaceOverview({ data: { workspaceId: workspaceId! } }),
    enabled: !!workspaceId,
  });

  if (!workspaceId || isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    );
  }

  const ws = data?.workspace;
  const balance = data?.balance;
  const stats = data?.stats;
  const trialEnd = ws?.trial_ends_at ? new Date(ws.trial_ends_at) : null;
  const daysLeft = trialEnd ? Math.max(0, Math.ceil((trialEnd.getTime() - Date.now()) / (1000 * 60 * 60 * 24))) : null;

  const setupStatus = {
    sharetribeConnected: stats?.sharetribeConnected ?? false,
    hasListings: (stats?.syncedListings ?? 0) > 0,
    hasDomain: Boolean(ws?.marketplace_domain),
    hasPublishedPage: (stats?.publishedPages ?? 0) > 0,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Welcome back</h1>
        <p className="text-sm text-muted-foreground">
          {ws?.name} · {ws?.marketplace_domain ?? "domain not set yet"}
        </p>
      </div>

      {ws?.subscription_status === "trialing" && daysLeft !== null && (
        <Card className="border-orange-500/30 bg-orange-500/5">
          <CardContent className="py-4 flex items-center justify-between">
            <div>
              <div className="font-medium">Trial — {daysLeft} day{daysLeft === 1 ? "" : "s"} left</div>
              <div className="text-xs text-muted-foreground">Pick a plan to keep generating after the trial ends.</div>
            </div>
            <Button asChild>
              <Link to="/app/billing">Choose a plan</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <SetupChecklist status={setupStatus} />

      {workspaceId && <DailyBriefing workspaceId={workspaceId} />}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Coins className="h-4 w-4" /> AI Credits
            </CardDescription>
            <CardTitle className="text-3xl">{balance?.balance?.toLocaleString() ?? 0}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {balance?.monthly_allowance
              ? `${balance.monthly_allowance.toLocaleString()} included / mo`
              : "Top up in Billing to keep generating"}
            {" · "}
            <Link to="/app/billing" className="hover:text-foreground">Billing →</Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <FileText className="h-4 w-4" /> Published Pages
            </CardDescription>
            <CardTitle className="text-3xl">{stats?.publishedPages ?? 0}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {(stats?.publishedPages ?? 0) === 0 ? (
              <Link to="/app/pages/new" className="hover:text-foreground">Create your first page →</Link>
            ) : (
              <Link to="/app/pages" className="hover:text-foreground">Manage pages →</Link>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Store className="h-4 w-4" /> Synced Listings
            </CardDescription>
            <CardTitle className="text-3xl">{stats?.syncedListings ?? 0}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {stats?.sharetribeConnected ? (
              <>
                From Sharetribe
                {stats?.lastSharetribeSync
                  ? ` · last sync ${new Date(stats.lastSharetribeSync).toLocaleDateString()}`
                  : ""}
                {" · "}
                <Link to="/app/settings/integrations/sharetribe" className="hover:text-foreground">Integration →</Link>
              </>
            ) : (
              <Link to="/app/settings/integrations/sharetribe" className="hover:text-foreground">Connect Sharetribe →</Link>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4" /> Search performance
          </CardTitle>
          <CardDescription>Import Google Search Console data to track clicks and impressions here.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/app/seo/gsc-import">Import GSC data</Link>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/app/seo/click-report">View click report</Link>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/app/coach">
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              Ask Coach
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}