import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import {
  listCompetitorPages,
  scrapeCompetitorUrl,
  deleteCompetitor,
  type CompetitorRow,
} from "@/lib/admin-seo-tools.functions";

export const Route = createFileRoute("/_authenticated/app/seo/competitor-tracker")({
  head: () => ({ meta: [{ title: "Competitor Tracker — founders.click" }] }),
  component: CompetitorTrackerPage,
});

function CompetitorTrackerPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [rows, setRows] = useState<CompetitorRow[]>([]);
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const list = useServerFn(listCompetitorPages);
  const scrape = useServerFn(scrapeCompetitorUrl);
  const del = useServerFn(deleteCompetitor);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);
  useEffect(() => {
    if (workspaceId) reload(workspaceId); /* eslint-disable-next-line */
  }, [workspaceId]);

  async function reload(ws: string) {
    const r = await list({ data: { workspaceId: ws, q, limit: 100 } });
    setRows(r.rows);
  }

  async function doScrape() {
    if (!workspaceId || !url.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await scrape({
        data: { workspaceId, url: url.trim(), notes: notes.trim() || undefined },
      });
      if (r.ok) {
        setMsg(`Scraped ${r.word_count} words.`);
        setUrl("");
        setNotes("");
        await reload(workspaceId);
      } else setMsg(r.error);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!workspaceId) return;
    if (!confirm("Delete this competitor page?")) return;
    await del({ data: { workspaceId, id } });
    await reload(workspaceId);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Competitor Tracker</h1>
        <p className="text-sm text-muted-foreground">
          Scrape competitor pages with Firecrawl. Requires <code>FIRECRAWL_API_KEY</code> in{" "}
          <a className="underline" href="/app/settings/api-keys">
            Settings → API Keys
          </a>
          .
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add a competitor URL</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label>URL</Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://competitor.com/page"
            />
          </div>
          <div className="space-y-1">
            <Label>Notes (optional)</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
          <div className="flex items-center gap-3">
            <Button
              onClick={doScrape}
              disabled={busy || !workspaceId || !url.trim()}
              className="gap-2"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Scrape
            </Button>
            {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tracked pages</CardTitle>
          <CardDescription>{rows.length} rows</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-end gap-3">
            <div className="space-y-1">
              <Label>Search</Label>
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="w-64"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && workspaceId) reload(workspaceId);
                }}
              />
            </div>
            <Button variant="outline" onClick={() => workspaceId && reload(workspaceId)}>
              Refresh
            </Button>
          </div>
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No competitor pages yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4">Domain</th>
                    <th className="py-2 pr-4">Title</th>
                    <th className="py-2 pr-4">Words</th>
                    <th className="py-2 pr-4">Last scraped</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs">{r.domain}</td>
                      <td className="py-2 pr-4">
                        <div className="font-medium">{r.title || "(untitled)"}</div>
                        <div className="font-mono text-xs text-muted-foreground truncate max-w-md">
                          {r.url}
                        </div>
                      </td>
                      <td className="py-2 pr-4">{r.word_count}</td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">
                        {r.last_scraped_at ? new Date(r.last_scraped_at).toLocaleString() : "—"}
                      </td>
                      <td className="py-2">
                        <Button size="sm" variant="ghost" onClick={() => remove(r.id)}>
                          Delete
                        </Button>
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
