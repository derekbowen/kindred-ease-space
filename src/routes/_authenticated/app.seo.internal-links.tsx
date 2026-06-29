import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import {
  generateLinkSuggestions,
  listLinkSuggestions,
  updateLinkSuggestionStatus,
  type LinkSuggestionRow,
} from "@/lib/admin-seo-tools.functions";

export const Route = createFileRoute("/_authenticated/app/seo/internal-links")({
  head: () => ({ meta: [{ title: "Internal Links — founders.click" }] }),
  component: InternalLinksPage,
});

function InternalLinksPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [rows, setRows] = useState<LinkSuggestionRow[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"pending" | "applied" | "dismissed" | "all">("pending");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const gen = useServerFn(generateLinkSuggestions);
  const list = useServerFn(listLinkSuggestions);
  const upd = useServerFn(updateLinkSuggestionStatus);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);

  async function reload(ws: string) {
    const r = await list({ data: { workspaceId: ws, status, q, limit: 200 } });
    setRows(r.rows);
  }
  useEffect(() => {
    if (workspaceId) reload(workspaceId); /* eslint-disable-next-line */
  }, [workspaceId, status]);

  async function regenerate() {
    if (!workspaceId) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await gen({ data: { workspaceId, sampleSize: 500, minScore: 0.18, perPage: 5 } });
      setMsg(r.ok ? `Generated ${r.count} suggestions.` : `Error: ${r.error}`);
      await reload(workspaceId);
    } finally {
      setBusy(false);
    }
  }

  async function setRowStatus(id: string, newStatus: "applied" | "dismissed") {
    if (!workspaceId) return;
    await upd({ data: { workspaceId, ids: [id], status: newStatus } });
    await reload(workspaceId);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Internal Link Suggestions</h1>
        <p className="text-sm text-muted-foreground">
          Topic-overlap suggestions across your published pages.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Generate</CardTitle>
          <CardDescription>
            Scans up to 500 published pages, computes Jaccard similarity, stores up to 5 suggestions
            per source.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <Button onClick={regenerate} disabled={busy || !workspaceId} className="gap-2">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Regenerate suggestions
          </Button>
          {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Suggestions</CardTitle>
          <CardDescription>{rows.length} rows</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label>Status</Label>
              <select
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={status}
                onChange={(e) => setStatus(e.target.value as typeof status)}
              >
                <option value="pending">Pending</option>
                <option value="applied">Applied</option>
                <option value="dismissed">Dismissed</option>
                <option value="all">All</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label>Search</Label>
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="url contains..."
                className="w-64"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && workspaceId) reload(workspaceId);
                }}
              />
            </div>
            <Button variant="outline" onClick={() => workspaceId && reload(workspaceId)}>
              Apply filters
            </Button>
          </div>

          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No suggestions yet. Click "Regenerate" above.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4">From</th>
                    <th className="py-2 pr-4">→ To</th>
                    <th className="py-2 pr-4">Anchor</th>
                    <th className="py-2 pr-4">Score</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs">{r.from_url}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{r.to_url}</td>
                      <td className="py-2 pr-4">{r.anchor_text || "—"}</td>
                      <td className="py-2 pr-4">{r.score.toFixed(3)}</td>
                      <td className="py-2 pr-4 text-xs">{r.status}</td>
                      <td className="py-2">
                        {r.status === "pending" && (
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setRowStatus(r.id, "applied")}
                            >
                              Mark applied
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setRowStatus(r.id, "dismissed")}
                            >
                              Dismiss
                            </Button>
                          </div>
                        )}
                      </td>
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
