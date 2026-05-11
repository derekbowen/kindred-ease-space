import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { findKeywordOpportunities, type KeywordRow } from "@/lib/admin-seo-tools.functions";

export const Route = createFileRoute("/_authenticated/app/seo/keyword-opportunities")({
  head: () => ({ meta: [{ title: "Keyword Opportunities — founders.click" }] }),
  component: KeywordOpportunitiesPage,
});

function KeywordOpportunitiesPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [minPos, setMinPos] = useState(5);
  const [maxPos, setMaxPos] = useState(20);
  const [minImpr, setMinImpr] = useState(50);
  const [pathLike, setPathLike] = useState("");
  const [rows, setRows] = useState<KeywordRow[]>([]);
  const [busy, setBusy] = useState(false);
  const find = useServerFn(findKeywordOpportunities);

  useEffect(() => { getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null)); }, []);

  async function run() {
    if (!workspaceId) return;
    setBusy(true);
    try {
      const r = await find({ data: { workspaceId, minPosition: minPos, maxPosition: maxPos, minImpressions: minImpr, pathLike, limit: 200 } });
      setRows(r.rows);
    } finally { setBusy(false); }
  }

  useEffect(() => { if (workspaceId) run(); /* eslint-disable-next-line */ }, [workspaceId]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Keyword Opportunities</h1>
        <p className="text-sm text-muted-foreground">Queries already ranking but stuck below the fold. Quick wins live here.</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Filters</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-4">
          <Field label="Min position"><Input type="number" min={1} max={100} value={minPos} onChange={(e) => setMinPos(Number(e.target.value) || 5)} className="w-24" /></Field>
          <Field label="Max position"><Input type="number" min={1} max={100} value={maxPos} onChange={(e) => setMaxPos(Number(e.target.value) || 20)} className="w-24" /></Field>
          <Field label="Min impressions"><Input type="number" min={0} value={minImpr} onChange={(e) => setMinImpr(Number(e.target.value) || 0)} className="w-28" /></Field>
          <Field label="Path contains"><Input value={pathLike} onChange={(e) => setPathLike(e.target.value)} placeholder="/p/los-angeles" className="w-56" /></Field>
          <Button onClick={run} disabled={busy || !workspaceId} className="gap-2">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Search</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{rows.length} opportunities</CardTitle>
          <CardDescription>Sorted by impressions descending.</CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No matching queries. Try lowering the impressions threshold or import GSC data first.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4">Query</th>
                    <th className="py-2 pr-4">Page</th>
                    <th className="py-2 pr-4">Pos</th>
                    <th className="py-2 pr-4">Impr</th>
                    <th className="py-2 pr-4">Clicks</th>
                    <th className="py-2">CTR</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-medium">{r.query}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{r.url_path}</td>
                      <td className="py-2 pr-4">{r.position?.toFixed(1) ?? "—"}</td>
                      <td className="py-2 pr-4">{r.impressions}</td>
                      <td className="py-2 pr-4">{r.clicks}</td>
                      <td className="py-2">{r.ctr != null ? `${(r.ctr * 100).toFixed(2)}%` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
