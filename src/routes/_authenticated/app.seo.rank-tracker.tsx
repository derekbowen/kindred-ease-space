import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, ArrowDown, ArrowUp, Minus } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import {
  listTrackedKeywords, addTrackedKeyword, deleteTrackedKeyword, runSerpCheck,
  type TrackedKeywordRow,
} from "@/lib/admin-rank-tracker.functions";

export const Route = createFileRoute("/_authenticated/app/seo/rank-tracker")({
  head: () => ({ meta: [{ title: "Rank Tracker — founders.click" }] }),
  component: RankTrackerPage,
});

function RankTrackerPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [rows, setRows] = useState<TrackedKeywordRow[]>([]);
  const [keyword, setKeyword] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const list = useServerFn(listTrackedKeywords);
  const add = useServerFn(addTrackedKeyword);
  const del = useServerFn(deleteTrackedKeyword);
  const check = useServerFn(runSerpCheck);

  useEffect(() => { getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null)); }, []);
  useEffect(() => { if (workspaceId) reload(workspaceId); /* eslint-disable-next-line */ }, [workspaceId]);

  async function reload(ws: string) {
    const r = await list({ data: { workspaceId: ws } });
    setRows(r.rows);
  }

  async function addKw() {
    if (!workspaceId || !keyword.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const r = await add({ data: { workspaceId, keyword: keyword.trim(), target_url_path: target.trim() || undefined, market: "us" } });
      if (r.ok) { setKeyword(""); setTarget(""); await reload(workspaceId); }
      else setMsg(r.error);
    } finally { setBusy(false); }
  }

  async function checkAll() {
    if (!workspaceId) return;
    setBusy(true); setMsg(null);
    try {
      const r = await check({ data: { workspaceId, limit: 20 } });
      if (r.ok) { setMsg(`Checked ${r.results.length} keywords.`); await reload(workspaceId); }
      else setMsg(r.error);
    } finally { setBusy(false); }
  }

  async function checkOne(id: string) {
    if (!workspaceId) return;
    setBusy(true);
    try {
      await check({ data: { workspaceId, id, limit: 1 } });
      await reload(workspaceId);
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!workspaceId) return;
    if (!confirm("Delete this keyword?")) return;
    await del({ data: { workspaceId, id } });
    await reload(workspaceId);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Rank Tracker</h1>
        <p className="text-sm text-muted-foreground">
          Track keyword positions for your marketplace domain. Requires <code>SERPAPI_KEY</code> in{" "}
          <a className="underline" href="/app/settings/api-keys">Settings → API Keys</a>.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle>Add keyword</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1 flex-1 min-w-[200px]"><Label>Keyword</Label><Input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="pool rental los angeles" /></div>
          <div className="space-y-1 flex-1 min-w-[200px]"><Label>Target path (optional)</Label><Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="/p/los-angeles-ca" /></div>
          <Button onClick={addKw} disabled={busy || !workspaceId || !keyword.trim()}>Add</Button>
          <Button variant="outline" onClick={checkAll} disabled={busy || !workspaceId} className="gap-2">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Check all (20)
          </Button>
          {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Tracked keywords</CardTitle><CardDescription>{rows.length} rows</CardDescription></CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No keywords yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4">Keyword</th>
                  <th className="py-2 pr-4">Target</th>
                  <th className="py-2 pr-4">Position</th>
                  <th className="py-2 pr-4">Δ</th>
                  <th className="py-2 pr-4">Last checked</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const delta = (r.previous_position != null && r.last_position != null) ? r.previous_position - r.last_position : null;
                  return (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-medium">{r.keyword}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{r.target_url_path || "—"}</td>
                      <td className="py-2 pr-4 font-bold">{r.last_position ?? "—"}</td>
                      <td className="py-2 pr-4">
                        {delta == null ? <Minus className="h-3 w-3 text-muted-foreground" /> :
                         delta > 0 ? <span className="text-green-600 inline-flex items-center"><ArrowUp className="h-3 w-3" /> {delta}</span> :
                         delta < 0 ? <span className="text-destructive inline-flex items-center"><ArrowDown className="h-3 w-3" /> {Math.abs(delta)}</span> :
                         <Minus className="h-3 w-3 text-muted-foreground" />}
                      </td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">{r.last_checked_at ? new Date(r.last_checked_at).toLocaleString() : "never"}</td>
                      <td className="py-2 flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => checkOne(r.id)} disabled={busy}>Check</Button>
                        <Button size="sm" variant="ghost" onClick={() => remove(r.id)}>Delete</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
