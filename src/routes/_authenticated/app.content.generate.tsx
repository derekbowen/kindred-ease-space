import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, FileText, AlertTriangle, CheckCircle2 } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { getGenerateStats, type GenStats } from "@/lib/admin-generate-stats.functions";

export const Route = createFileRoute("/_authenticated/app/content/generate")({
  head: () => ({ meta: [{ title: "Generate Content — founders.click" }] }),
  component: GenerateContentPage,
});

function GenerateContentPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [stats, setStats] = useState<GenStats | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchStats = useServerFn(getGenerateStats);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);

  async function load() {
    if (!workspaceId) return;
    setLoading(true);
    try {
      setStats(await fetchStats({ data: { workspaceId } }));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (workspaceId) load(); /* eslint-disable-next-line */
  }, [workspaceId]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Generate Content</h1>
          <p className="text-sm text-muted-foreground">
            Bulk-generate programmatic pages from your content plan.
          </p>
        </div>
        <Button
          onClick={load}
          disabled={loading || !workspaceId}
          variant="outline"
          className="gap-2"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />} Refresh
        </Button>
      </div>

      <Card className="border-amber-500/40 bg-amber-500/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4" /> Generation backend pending
          </CardTitle>
          <CardDescription>
            The <code>generate-content-batch</code> edge function will be ported in Wave C. For now,
            this page reads live stats from your <code>content_plan</code> and{" "}
            <code>content_pages</code>.
          </CardDescription>
        </CardHeader>
      </Card>

      {stats?.error && (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{stats.error}</p>
      )}

      {stats?.ok && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="Total" value={stats.totals.total} />
            <StatCard
              label="Generated"
              value={stats.totals.generated}
              icon={<CheckCircle2 className="h-4 w-4 text-emerald-500" />}
            />
            <StatCard
              label="Pending"
              value={stats.totals.pending}
              icon={<FileText className="h-4 w-4 text-muted-foreground" />}
            />
            <StatCard
              label="Paused"
              value={stats.totals.paused}
              icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <BreakdownCard title="Pending by tier" rows={stats.pendingByTier} />
            <BreakdownCard title="Paused by tier" rows={stats.pausedByTier} />
          </div>

          {stats.topPausedReasons.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Top paused reasons</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {stats.topPausedReasons.map((r) => (
                  <div
                    key={r.reason}
                    className="flex justify-between border-b py-1 text-sm last:border-0"
                  >
                    <span>{r.reason}</span>
                    <span className="font-mono text-muted-foreground">{r.n}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Recent inserts</CardTitle>
              <CardDescription>
                Last 20 pages added to <code>content_pages</code>.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {stats.recentInserts.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Nothing yet.</p>
              ) : (
                <ul className="divide-y text-sm">
                  {stats.recentInserts.map((r) => (
                    <li key={r.slug} className="flex items-center justify-between py-2">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{r.title ?? r.slug}</div>
                        <div className="truncate font-mono text-xs text-muted-foreground">
                          /p/{r.slug}
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {new Date(r.created_at).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {stats.recentErrors.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Recent errors</CardTitle>
                <CardDescription>
                  Latest 15 plan rows with a <code>last_error</code>.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-y text-sm">
                  {stats.recentErrors.map((e) => (
                    <li key={e.slug} className="space-y-1 py-2">
                      <div className="flex justify-between font-mono text-xs">
                        <span>{e.slug}</span>
                        <span className="text-muted-foreground">
                          {e.tier ?? "—"} · {e.status}
                        </span>
                      </div>
                      <p className="text-xs text-destructive">{e.error}</p>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-2">
          {icon} {label}
        </CardDescription>
        <CardTitle className="text-3xl">{value.toLocaleString()}</CardTitle>
      </CardHeader>
    </Card>
  );
}

function BreakdownCard({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ tier: string; n: number }>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">None.</p>
        ) : (
          <div className="space-y-1">
            {rows.map((r) => (
              <div
                key={r.tier}
                className="flex justify-between border-b py-1 text-sm last:border-0"
              >
                <span className="font-mono text-xs">{r.tier}</span>
                <span className="text-muted-foreground">{r.n}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
