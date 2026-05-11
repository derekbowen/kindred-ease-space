import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, ExternalLink, Pencil, Trash2, Upload } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { listTenantPages, deleteTenantPage } from "@/lib/tenant-pages.functions";

export const Route = createFileRoute("/_authenticated/app/pages")({
  head: () => ({ meta: [{ title: "Pages — founders.click" }] }),
  component: PagesList,
});

type Row = {
  id: string;
  slug: string;
  title: string;
  status: string;
  published_at: string | null;
  updated_at: string;
  page_templates: { name: string; slug: string } | null;
};

function PagesList() {
  const navigate = useNavigate();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const list = useServerFn(listTenantPages);
  const del = useServerFn(deleteTenantPage);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    setLoading(true);
    list({ data: { workspaceId } })
      .then((r) => setRows(r.pages as Row[]))
      .finally(() => setLoading(false));
  }, [workspaceId, list]);

  async function onDelete(id: string) {
    if (!workspaceId) return;
    if (!confirm("Delete this page?")) return;
    await del({ data: { workspaceId, id } });
    setRows((rs) => rs.filter((r) => r.id !== id));
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Pages</h1>
          <p className="text-muted-foreground text-sm">SEO landing pages built from your synced listings.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate({ to: "/app/pages/bulk" })}>
            <Upload className="h-4 w-4 mr-2" /> Bulk import
          </Button>
          <Button onClick={() => navigate({ to: "/app/pages/new" })}>
            <Plus className="h-4 w-4 mr-2" /> New page
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>All pages</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No pages yet. Create one to start building your programmatic SEO surface.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground border-b border-border">
                  <tr>
                    <th className="py-2 pr-4">Title</th>
                    <th className="py-2 pr-4">Template</th>
                    <th className="py-2 pr-4">Slug</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Updated</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-border/40">
                      <td className="py-2 pr-4 font-medium">{r.title}</td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {r.page_templates?.name ?? "—"}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">/p/{r.slug}</td>
                      <td className="py-2 pr-4">
                        <Badge variant={r.status === "published" ? "default" : "secondary"}>
                          {r.status}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground text-xs">
                        {new Date(r.updated_at).toLocaleString()}
                      </td>
                      <td className="py-2 flex gap-1 justify-end">
                        {r.status === "published" && (
                          <Button asChild size="sm" variant="ghost">
                            <a href={`/p/${r.slug}`} target="_blank" rel="noreferrer">
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          </Button>
                        )}
                        <Button asChild size="sm" variant="ghost">
                          <Link to="/app/pages/$id/edit" params={{ id: r.id }}>
                            <Pencil className="h-4 w-4" />
                          </Link>
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => onDelete(r.id)}>
                          <Trash2 className="h-4 w-4" />
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
