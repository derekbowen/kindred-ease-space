import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Sparkles, FileText, Users, Coins } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { getWorkspaceOverview } from "@/lib/workspace.functions";
import { DailyBriefing } from "@/components/coach/DailyBriefing";

export const Route = createFileRoute("/_authenticated/app/")({
  head: () => ({ meta: [{ title: "Dashboard — founders.click" }] }),
  component: DashboardPage,
});

function DashboardPage() {
  const navigate = useNavigate();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    getMe()
      .then((me) => {
        const memberships = Array.isArray(me?.memberships) ? me.memberships : [];
        setWorkspaceId(memberships[0]?.workspace_id ?? null);
      })
      .catch((err) => {
        // 401s here just mean session expired / not hydrated — bounce to login.
        const status = (err as { status?: number; response?: { status?: number } })?.status
          ?? (err as { response?: { status?: number } })?.response?.status;
        if (status === 401) {
          navigate({ to: "/login", search: { next: "/app" } });
        } else {
          console.error("getMe failed", err);
        }
      });
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
  const trialEnd = ws?.trial_ends_at ? new Date(ws.trial_ends_at) : null;
  const daysLeft = trialEnd ? Math.max(0, Math.ceil((trialEnd.getTime() - Date.now()) / (1000 * 60 * 60 * 24))) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Welcome back</h1>
        <p className="text-sm text-muted-foreground">
          {ws?.name} · {ws?.marketplace_domain ?? "no domain set"}
        </p>
      </div>

      {ws?.subscription_status === "trialing" && daysLeft !== null && (
        <Card className="border-orange-500/30 bg-orange-500/5">
          <CardContent className="py-4 flex items-center justify-between">
            <div>
              <div className="font-medium">Trial — {daysLeft} day{daysLeft === 1 ? "" : "s"} left</div>
              <div className="text-xs text-muted-foreground">Pick a plan to keep things rolling after the trial ends.</div>
            </div>
            <Button asChild>
              <Link to="/app/billing">Choose a plan</Link>
            </Button>
          </CardContent>
        </Card>
      )}

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
            {balance?.monthly_allowance ? `${balance.monthly_allowance.toLocaleString()} / mo` : "Top up to generate pages"}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <FileText className="h-4 w-4" /> Published Pages
            </CardDescription>
            <CardTitle className="text-3xl">{data?.stats.publishedPages ?? 0}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            <Link to="/app/content" className="hover:text-foreground">Open Content →</Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Users className="h-4 w-4" /> Leads
            </CardDescription>
            <CardTitle className="text-3xl">{data?.stats.leads ?? 0}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            <Link to="/app/users-ops" className="hover:text-foreground">Open Users & Ops →</Link>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-orange-500" /> Today's Top 3 Actions
          </CardTitle>
          <CardDescription>AI-ranked priorities will appear here once your site has data.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>Connect your Google Search Console and Stripe to start surfacing live KPIs and ranked actions.</p>
          <Button variant="outline" asChild>
            <Link to="/app/settings">Open Settings</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
