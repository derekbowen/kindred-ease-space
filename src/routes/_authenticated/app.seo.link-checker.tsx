import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { scanInternalLinks, type BrokenLink } from "@/lib/admin-link-checker.functions";

export const Route = createFileRoute("/_authenticated/app/seo/link-checker")({
  head: () => ({ meta: [{ title: "Link Checker — founders.click" }] }),
  component: LinkCheckerPage,
});

function LinkCheckerPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [report, setReport] = useState<{
    totalPagesScanned: number;
    totalLinks: number;
    broken: BrokenLink[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const scan = useServerFn(scanInternalLinks);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);

  async function run() {
    if (!workspaceId) return;
    setBusy(true);
    try {
      setReport(await scan({ data: { workspaceId, sampleSize: 500 } }));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (workspaceId) run(); /* eslint-disable-next-line */
  }, [workspaceId]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Internal Link Checker</h1>
        <p className="text-sm text-muted-foreground">
          Scans your published pages for broken or unpublished internal markdown links.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Scan</CardTitle>
        </CardHeader>
        <CardContent>
          <Button onClick={run} disabled={busy || !workspaceId} className="gap-2">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Re-scan
          </Button>
        </CardContent>
      </Card>

      {report && (
        <>
          <div className="grid grid-cols-3 gap-4">
            <Stat label="Pages scanned" value={report.totalPagesScanned} />
            <Stat label="Links found" value={report.totalLinks} />
            <Stat label="Broken" value={report.broken.length} />
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Broken links</CardTitle>
              <CardDescription>
                Targets that don't resolve to a published content page in this workspace.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {report.broken.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No broken internal links 🎉
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4">From</th>
                      <th className="py-2 pr-4">→ To</th>
                      <th className="py-2 pr-4">Anchor</th>
                      <th className="py-2">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.broken.map((b, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="py-2 pr-4 font-mono text-xs">{b.from_url_path}</td>
                        <td className="py-2 pr-4 font-mono text-xs">{b.to_url_path}</td>
                        <td className="py-2 pr-4">{b.anchor || "—"}</td>
                        <td className="py-2 text-xs">{b.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl">{value.toLocaleString()}</CardTitle>
      </CardHeader>
    </Card>
  );
}
