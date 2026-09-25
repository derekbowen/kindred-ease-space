import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Sparkles, FileText, Store } from "lucide-react";
import { formatAllowanceCount, useAiAllowance } from "@/components/ai/use-ai-allowance";
import { getMe } from "@/lib/auth.functions";
import { getWorkspaceOverview } from "@/lib/workspace.functions";
import { getBetaStatus } from "@/lib/entitlements.functions";
import { DailyBriefing } from "@/components/coach/DailyBriefing";
import { useCoachEnabled } from "@/components/coach/coach-availability";
import { SetupChecklist } from "@/components/dashboard/SetupChecklist";
import { describePlanStatus, formatPlanDate } from "@/components/billing/plan-status";

export const Route = createFileRoute("/_authenticated/app/")({
  head: () => ({ meta: [{ title: "Dashboard — founders.click" }] }),
  component: DashboardPage,
});

function DashboardPage() {
  const navigate = useNavigate();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const coachEnabled = useCoachEnabled();
  const { allowance, error: allowanceError } = useAiAllowance(workspaceId);

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
        const status =
          (err as { status?: number; response?: { status?: number } })?.status ??
          (err as { response?: { status?: number } })?.response?.status;
        if (status === 401) navigate({ to: "/login", search: { next: "/app" } });
        else console.error("getMe failed", err);
      }
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const { data, isLoading } = useQuery({
    queryKey: ["workspace-overview", workspaceId],
    queryFn: () => getWorkspaceOverview({ data: { workspaceId: workspaceId! } }),
    enabled: !!workspaceId,
  });

  // A beta tenant has an admin grant and no trial to convert from. Resolve it
  // before rendering the status card so the "pick a plan" nag never flashes
  // at someone who was promised free access.
  const { data: beta, isLoading: betaLoading } = useQuery({
    queryKey: ["beta-status", workspaceId],
    queryFn: () => getBetaStatus({ data: { workspaceId: workspaceId! } }),
    enabled: !!workspaceId,
    staleTime: 60_000,
  });

  if (!workspaceId || isLoading || betaLoading) {
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
  const stats = data?.stats;
  // Trial wording shared with the billing page and the shell badge. An ended
  // trial still reads subscription_status 'trialing'; it used to show here as
  // "Trial — 0 days left".
  const planStatus = describePlanStatus({
    subscriptionStatus: ws?.subscription_status,
    trialEndsAt: ws?.trial_ends_at,
    currentPeriodEnd: ws?.current_period_end ?? null,
    planKey: ws?.plan,
    inBeta: Boolean(beta?.beta),
    betaExpiresAt: beta?.expiresAt ?? null,
  });
  const trialEnded = planStatus.kind === "trial_ended";
  const trialRunning =
    (planStatus.kind === "trial" || planStatus.kind === "trial_ends_today") &&
    planStatus.daysLeft !== null;

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

      {beta?.beta ? (
        // Never nag a beta tenant: their access is a grant, not a countdown
        // to a credit card. Say what they have and when (if ever) it ends.
        <Card className="border-emerald-500/30 bg-emerald-500/5">
          <CardContent className="py-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-medium">
                Free beta — {beta.pageLimit.toLocaleString()} page
                {beta.pageLimit === 1 ? "" : "s"} included, no charge
              </div>
              <div className="text-xs text-muted-foreground">
                {/* No sentence promising a notice: nothing sends one when a
                    grant ends. The end date itself is the honest signal. */}
                {beta.expiresAt
                  ? `Beta access runs until ${formatPlanDate(beta.expiresAt)}.`
                  : "No end date set."}
              </div>
            </div>
            <Button asChild variant="outline">
              <Link to="/beta">What's included</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        (trialRunning || trialEnded) && (
          <Card
            className={
              trialEnded
                ? "border-destructive/40 bg-destructive/5"
                : "border-orange-500/30 bg-orange-500/5"
            }
          >
            <CardContent className="py-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-medium">{planStatus.trialHeadline}</div>
                <div className="text-xs text-muted-foreground">
                  {trialEnded
                    ? "Your published pages are paused until you pick a plan; drafts are kept."
                    : `${planStatus.dateLine}. When it ends, your published pages pause until you pick a plan; drafts are kept.`}
                </div>
              </div>
              <Button asChild>
                <Link to="/app/billing">Choose a plan</Link>
              </Button>
            </CardContent>
          </Card>
        )
      )}

      <SetupChecklist status={setupStatus} />

      {workspaceId && <DailyBriefing workspaceId={workspaceId} />}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" /> AI pages (last 24 hours)
            </CardDescription>
            <CardTitle className="text-3xl tabular-nums">{formatAllowanceCount(allowance)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {allowance ? allowance.summary : (allowanceError ?? "Checking your AI allowance…")}
            {" · "}
            <Link to="/app/billing" className="hover:text-foreground">
              Billing →
            </Link>
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
              <Link to="/app/pages/new" className="hover:text-foreground">
                Create your first page →
              </Link>
            ) : (
              <Link to="/app/pages" className="hover:text-foreground">
                Manage pages →
              </Link>
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
                  ? ` · last sync ${formatPlanDate(stats.lastSharetribeSync)}`
                  : ""}
                {" · "}
                <Link to="/app/settings/integrations/sharetribe" className="hover:text-foreground">
                  Integration →
                </Link>
              </>
            ) : (
              <Link to="/app/settings/integrations/sharetribe" className="hover:text-foreground">
                Connect Sharetribe →
              </Link>
            )}
          </CardContent>
        </Card>
      </div>

      {/* The GSC import is not a launch feature (launch: false in app-nav),
          so the dashboard no longer promises "track clicks and impressions
          here" and links a customer to it (round-4 release review L7). The
          Coach, off for launch, keeps its own card behind its switch. */}
      {coachEnabled && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4" /> Coach
            </CardTitle>
            <CardDescription>Ask what to fix next on your site.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            {coachEnabled && (
              <Button variant="ghost" size="sm" asChild>
                <Link to="/app/coach">
                  <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                  Ask Coach
                </Link>
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
