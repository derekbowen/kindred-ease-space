import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { scanContentHealth, type ContentHealthReport } from "@/lib/admin-content-health.functions";
import { InlineCoach } from "@/components/coach/InlineCoach";

export const Route = createFileRoute("/_authenticated/app/seo/content-health")({
  head: () => ({ meta: [{ title: "Content Health — founders.click" }] }),
  component: ContentHealthPage,
});

function ContentHealthPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [minLength, setMinLength] = useState(500);
  const [report, setReport] = useState<ContentHealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const scan = useServerFn(scanContentHealth);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);

  async function run() {
    if (!workspaceId) return;
    setLoading(true);
    try {
      setReport(await scan({ data: { workspaceId, minLength, limit: 500, onlyInSitemap: false } }));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (workspaceId) run(); /* eslint-disable-next-line */ }, [workspaceId]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Content Health</h1>
        <p className="text-sm text-muted-foreground">Find published pages with missing or thin body content.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Scan</CardTitle>
          <CardDescription>Workspace-scoped scan of <code>content_pages</code> where <code>status='published'</code>.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <Label htmlFor="min">Min body length (chars)</Label>
            <Input id="min" type="number" min={0} max={10000} value={minLength}
              onChange={(e) => setMinLength(Math.max(0, Math.min(10000, Number(e.target.value) || 500)))}
              className="w-28" />
          </div>
          <Button onClick={run} disabled={loading || !workspaceId} className="gap-2">
            {loading && <Loader2 className="h-4 w-4 animate-spin" />} Scan
          </Button>
        </CardContent>
      </Card>

      {report && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="Published" value={report.totalPublished} />
            <StatCard label="Affected" value={report.totalAffected} />
            <StatCard label="Missing" value={report.byReason.missing} />
            <StatCard label="Thin / Blank" value={report.byReason.thin + report.byReason.blank} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Affected pages</CardTitle>
              <CardDescription>Sorted by body length ascending.</CardDescription>
            </CardHeader>
            <CardContent>
              {report.rows.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">All published pages pass the threshold.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="py-2 pr-4">URL</th>
                        <th className="py-2 pr-4">Reason</th>
                        <th className="py-2 pr-4">Length</th>
                        <th className="py-2">Template</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.rows.map((r) => (
                        <tr key={r.id} className="border-b last:border-0">
                          <td className="py-2 pr-4">
                            <div className="font-medium">{r.title ?? "(untitled)"}</div>
                            <div className="font-mono text-xs text-muted-foreground">{r.url_path}</div>
                          </td>
                          <td className="py-2 pr-4 font-mono text-xs">{r.reason}</td>
                          <td className="py-2 pr-4">{r.body_len}</td>
                          <td className="py-2 text-xs text-muted-foreground">{r.template_type ?? "—"}</td>
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

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl">{value.toLocaleString()}</CardTitle>
      </CardHeader>
    </Card>
  );
}
