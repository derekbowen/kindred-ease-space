import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { getMe } from "@/lib/auth.functions";
import {
  listContentPages,
  updateContentPageBasics,
  type ContentPageRow,
} from "@/lib/admin-content-pages.functions";

export const Route = createFileRoute("/_authenticated/app/content/bulk-editor")({
  head: () => ({ meta: [{ title: "Bulk Page Editor — founders.click" }] }),
  component: BulkEditorPage,
});

function BulkEditorPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<ContentPageRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  const fetchRows = useServerFn(listContentPages);
  const saveRow = useServerFn(updateContentPageBasics);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);

  async function load() {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const r = await fetchRows({ data: { workspaceId, search: search || undefined, limit: 100 } });
      setRows(r.rows);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load pages");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (workspaceId) load(); /* eslint-disable-next-line */ }, [workspaceId]);

  async function toggleSitemap(row: ContentPageRow) {
    if (!workspaceId) return;
    if (row.source === "tenant") {
      toast.info("Live tenant pages are always included in your sitemap.");
      return;
    }
    setSavingId(row.id);
    try {
      await saveRow({
        data: { workspaceId, id: row.id, source: row.source, in_sitemap: !row.in_sitemap },
      });
      setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, in_sitemap: !r.in_sitemap } : r)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Bulk Page Editor</h1>
        <p className="text-sm text-muted-foreground">
          Search and triage every published page — live tenant pages and legacy content rows.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Search</CardTitle>
          <CardDescription>Match against slug, title, or URL path.</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Input
            placeholder="e.g. los-angeles, hero, /p/foo"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
          />
          <Button onClick={load} disabled={loading || !workspaceId} className="gap-2">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Search
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{rows.length} pages</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {loading ? "Loading…" : "No pages match."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4">Title / Slug</th>
                    <th className="py-2 pr-4">Source</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Template</th>
                    <th className="py-2 pr-4">Sitemap</th>
                    <th className="py-2">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-2 pr-4">
                        <div className="font-medium">{r.title ?? "(untitled)"}</div>
                        <div className="font-mono text-xs text-muted-foreground">{r.url_path ?? r.slug ?? r.id}</div>
                      </td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">{r.source}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{r.status}</td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">{r.template_type ?? "—"}</td>
                      <td className="py-2 pr-4">
                        {r.source === "tenant" ? (
                          <span className="text-xs text-muted-foreground">Always on</span>
                        ) : (
                          <Button
                            size="sm"
                            variant={r.in_sitemap ? "default" : "outline"}
                            disabled={savingId === r.id}
                            onClick={() => toggleSitemap(r)}
                          >
                            {savingId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : r.in_sitemap ? "On" : "Off"}
                          </Button>
                        )}
                      </td>
                      <td className="py-2 text-xs text-muted-foreground">
                        {new Date(r.updated_at).toLocaleDateString()}
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
