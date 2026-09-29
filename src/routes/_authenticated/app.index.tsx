import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Sparkles, FileText, Store, Lightbulb } from "lucide-react";
import {
  allowanceSentence,
  formatAllowanceCount,
  useAiAllowance,
} from "@/components/ai/use-ai-allowance";
import { getMe } from "@/lib/auth.functions";
import { getWorkspaceOverview } from "@/lib/workspace.functions";
import { getBetaStatus } from "@/lib/entitlements.functions";
import { SetupChecklist } from "@/components/dashboard/SetupChecklist";
import {
  describeSyncHealth,
  MY_PAGES_PATH,
  OPPORTUNITIES_PATH,
  pagesLine,
  type SyncTone,
} from "@/components/dashboard/overview-status";
import {
  describePlanStatus,
  formatPlanDate,
  INTERNAL_PLAN_LABEL,
  INTERNAL_STATUS_LINE,
} from "@/components/billing/plan-status";

const SYNC_TONE_CLASS: Record<SyncTone, string> = {
  ok: "text-emerald-500",
  warn: "text-amber-500",
  bad: "text-destructive",
  muted: "text-foreground",
};

export const Route = createFileRoute("/_authenticated/app/")({
  head: () => ({ meta: [{ title: "Overview — founders.click" }] }),
  component: DashboardPage,
});

function DashboardPage() {
  const navigate = useNavigate();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
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
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Skeleton className="h-32" />
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
    // The founder / internal unlimited grant, as the server computed it: no
    // trial card, no "Choose a plan" (the server lifts the limits themselves).
    internalUnlimited: beta?.internalUnlimited === true,
    inBeta: Boolean(beta?.beta),
    betaExpiresAt: beta?.expiresAt ?? null,
  });
  const trialEnded = planStatus.kind === "trial_ended";
  const trialRunning =
    (planStatus.kind === "trial" || planStatus.kind === "trial_ends_today") &&
    planStatus.daysLeft !== null;

  // The MVP journey's setup steps and the sync's health, both read from the
  // one overview (getWorkspaceOverview) — the same for every workspace, the
  // founder / internal unlimited one included.
  const setupFacts = {
    sharetribeConnected: stats?.sharetribeConnected ?? false,
    syncedListings: stats?.syncedListings ?? 0,
    domains: data?.domains ?? [],
    marketplaceDomain: ws?.marketplace_domain ?? null,
    publishedPages: stats?.publishedPages ?? 0,
  };
  const sync = describeSyncHealth(
    {
      connected: stats?.sharetribeConnected ?? false,
      integrationStatus: stats?.sharetribeStatus ?? null,
      lastSyncAt: stats?.lastSharetribeSync ?? null,
      lastSyncStatus: stats?.lastSharetribeSyncStatus ?? null,
      listings: stats?.syncedListings ?? 0,
    },
    Date.now(),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Welcome back</h1>
        <p className="text-sm text-muted-foreground">
          {ws?.name} · {ws?.marketplace_domain ?? "domain not set yet"}
        </p>
      </div>

      {planStatus.kind === "internal" ? (
        <Card className="border-sky-500/30 bg-sky-500/5">
          <CardContent className="py-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-medium">{INTERNAL_PLAN_LABEL}</div>
              <div className="text-xs text-muted-foreground">{INTERNAL_STATUS_LINE}</div>
            </div>
            <Button asChild variant="outline">
              <Link to="/app/billing">Billing &amp; Plans</Link>
            </Button>
          </CardContent>
        </Card>
      ) : beta?.beta ? (
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

      <SetupChecklist facts={setupFacts} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {/* Sync health: the last sync's outcome and time, and how many
            listings are imported (the "Synced Listings" card the help
            center's sync article points at). */}
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Store className="h-4 w-4" /> Synced Listings
            </CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {(stats?.syncedListings ?? 0).toLocaleString("en-US")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs text-muted-foreground">
            <div className={`font-medium ${SYNC_TONE_CLASS[sync.tone]}`}>{sync.headline}</div>
            <div>{sync.detail}</div>
            <Link to={sync.cta.to} className="inline-block hover:text-foreground">
              {sync.cta.label}
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <FileText className="h-4 w-4" /> My Pages
            </CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {(stats?.publishedPages ?? 0).toLocaleString("en-US")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs text-muted-foreground">
            <div>{pagesLine(stats?.publishedPages ?? 0, stats?.draftPages ?? 0)}</div>
            <Link to={MY_PAGES_PATH} className="inline-block hover:text-foreground">
              View my pages →
            </Link>
          </CardContent>
        </Card>

        {/* No counts yet: the coverage service wires them in. */}
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Lightbulb className="h-4 w-4" /> Opportunities
            </CardDescription>
            <CardTitle className="text-base">Pages your listings can support</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs text-muted-foreground">
            <div>City and category pages your synced inventory can back up.</div>
            <Link to={OPPORTUNITIES_PATH} className="inline-block hover:text-foreground">
              View opportunities →
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" /> AI pages (last 24 hours)
            </CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {formatAllowanceCount(allowance)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {allowance
              ? allowanceSentence(allowance)
              : (allowanceError ?? "Checking your AI allowance…")}
            {" · "}
            <Link to="/app/billing" className="hover:text-foreground">
              Billing →
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
