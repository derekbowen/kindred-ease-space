import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, MousePointerClick, Users } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { getCityClickReport, type CityClickReport } from "@/lib/click-report.functions";

export const Route = createFileRoute("/_authenticated/app/seo/click-report")({
  head: () => ({ meta: [{ title: "Click Report — founders.click" }] }),
  component: ClickReportPage,
});

function ClickReportPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [limit, setLimit] = useState(50);
  const [report, setReport] = useState<CityClickReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fetchReport = useServerFn(getCityClickReport);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);

  async function load() {
    if (!workspaceId) return;
    setLoading(true); setErr(null);
    try {
      const r = await fetchReport({ data: { workspaceId, days, limit } });
      setReport(r);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (workspaceId) load(); /* eslint-disable-next-line */ }, [workspaceId]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Click Report</h1>
        <p className="text-sm text-muted-foreground">Nearby-city link clicks across your published content pages.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Window</CardTitle>
          <CardDescription>Aggregated from <code>city_link_clicks</code> for this workspace.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <Label htmlFor="days">Days</Label>
            <Input id="days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(Math.max(1, Math.min(365, Number(e.target.value) || 30)))} className="w-24" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="limit">Top N</Label>
            <Input id="limit" type="number" min={1} max={500} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(500, Number(e.target.value) || 50)))} className="w-24" />
          </div>
          <Button onClick={load} disabled={loading || !workspaceId} className="gap-2">
            {loading && <Loader2 className="h-4 w-4 animate-spin" />} Refresh
          </Button>
        </CardContent>
      </Card>

      {err && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{err}</p>}

      {report && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="pb-2"><CardDescription>Total clicks</CardDescription><CardTitle className="text-3xl">{report.totalClicks.toLocaleString()}</CardTitle></CardHeader>
              <CardContent><MousePointerClick className="h-5 w-5 text-muted-foreground" /></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardDescription>Unique visitors</CardDescription><CardTitle className="text-3xl">{report.uniqueVisitors.toLocaleString()}</CardTitle></CardHeader>
              <CardContent><Users className="h-5 w-5 text-muted-foreground" /></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardDescription>Window</CardDescription><CardTitle className="text-3xl">{report.windowDays}d</CardTitle></CardHeader>
              <CardContent />
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Top destination cities</CardTitle>
              <CardDescription>Where users go when they click a nearby-city link.</CardDescription>
            </CardHeader>
            <CardContent>
              {report.topCities.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No clicks in this window.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                      <tr><th className="py-2 pr-4">City slug</th><th className="py-2 pr-4">Clicks</th><th className="py-2 pr-4">Unique</th><th className="py-2">Top referrer</th></tr>
                    </thead>
                    <tbody>
                      {report.topCities.map((c) => (
                        <tr key={c.to_city_slug} className="border-b last:border-0">
                          <td className="py-2 pr-4 font-mono text-xs">{c.to_city_slug}</td>
                          <td className="py-2 pr-4">{c.clicks.toLocaleString()}</td>
                          <td className="py-2 pr-4">{c.unique_visitors.toLocaleString()}</td>
                          <td className="py-2 font-mono text-xs text-muted-foreground">{c.top_referrer ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
