import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Search, Trash2, Pencil, ExternalLink, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  adminListArticles,
  adminUpsertArticle,
  adminDeleteArticle,
  adminListCategories,
} from "@/lib/help-admin.functions";

export const Route = createFileRoute("/_authenticated/app/admin/help/articles")({
  head: () => ({ meta: [{ title: "Help Articles — Admin" }] }),
  component: AdminHelpArticlesPage,
});

function AdminHelpArticlesPage() {
  const navigate = useNavigate();
  const listFn = useServerFn(adminListArticles);
  const catsFn = useServerFn(adminListCategories);
  const upsertFn = useServerFn(adminUpsertArticle);
  const deleteFn = useServerFn(adminDeleteArticle);

  const [rows, setRows] = useState<Awaited<ReturnType<typeof adminListArticles>>>([]);
  const [cats, setCats] = useState<Awaited<ReturnType<typeof adminListCategories>>>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    Promise.all([listFn(), catsFn()])
      .then(([a, c]) => {
        setRows(a);
        setCats(c);
      })
      .catch((e) => {
        if (String(e?.message ?? e).includes("forbidden")) setForbidden(true);
        else toast.error("Failed to load articles", { description: String(String(e)) });
      })
      .finally(() => setLoading(false));
  }, [listFn, catsFn, toast]);

  const onCreate = async () => {
    if (!cats.length) {
      toast.error("Create a category first");
      return;
    }
    setCreating(true);
    try {
      const res = await upsertFn({
        data: {
          slug: `untitled-${Date.now().toString(36)}`,
          title: "Untitled article",
          category_slug: cats[0].slug,
          content: "# Untitled\n\nStart writing…",
          status: "draft",
          is_popular: false,
          tags: [],
        },
      });
      navigate({ to: "/app/admin/help/articles/$id", params: { id: res.id } });
    } catch (e) {
      toast.error("Create failed", { description: String(String(e)) });
    } finally {
      setCreating(false);
    }
  };

  const onDelete = async (id: string, title: string) => {
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
    try {
      await deleteFn({ data: { id } });
      setRows((r) => r.filter((x) => x.id !== id));
    } catch (e) {
      toast.error("Delete failed", { description: String(String(e)) });
    }
  };

  if (forbidden) {
    return (
      <div className="max-w-md mx-auto mt-20 text-center">
        <h1 className="text-2xl font-bold mb-2">Admin only</h1>
        <p className="text-muted-foreground">You need the admin role to manage help articles.</p>
      </div>
    );
  }

  const filtered = rows.filter(
    (r) =>
      !q.trim() ||
      r.title.toLowerCase().includes(q.toLowerCase()) ||
      r.slug.toLowerCase().includes(q.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Help articles</h1>
          <p className="text-sm text-muted-foreground">
            Platform help center content. <Link to="/app/admin/help/categories" className="underline">Manage categories</Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/help" target="_blank">
            <Button variant="outline" size="sm">
              <ExternalLink className="h-4 w-4 mr-2" /> View help center
            </Button>
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const t = toast.loading("Re-indexing articles for AI assistant…");
              try {
                const { data, error } = await supabase.functions.invoke("help-assistant-embed", { body: {} });
                if (error) throw error;
                toast.success(`Indexed ${data?.articles ?? 0} articles (${data?.chunks ?? 0} chunks)`, { id: t });
              } catch (e) {
                toast.error("Re-index failed", { id: t, description: e instanceof Error ? e.message : String(e) });
              }
            }}
          >
            <Sparkles className="h-4 w-4 mr-2" /> Re-index AI
          </Button>
          <Button size="sm" onClick={onCreate} disabled={creating}>
            <Plus className="h-4 w-4 mr-2" /> New article
          </Button>
        </div>
      </div>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-4">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search by title or slug…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
          <span className="text-xs text-muted-foreground ml-auto">{filtered.length} of {rows.length}</span>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Views</TableHead>
              <TableHead className="text-right">Helpful</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="w-[100px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Loading…</TableCell></TableRow>
            ) : filtered.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No articles. Click "New article" to start.</TableCell></TableRow>
            ) : (
              filtered.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link to="/app/admin/help/articles/$id" params={{ id: r.id }} className="font-medium hover:underline">
                      {r.title}
                    </Link>
                    <div className="text-xs text-muted-foreground">/{r.slug}</div>
                  </TableCell>
                  <TableCell className="text-sm">{r.category_slug}</TableCell>
                  <TableCell>
                    <Badge variant={r.status === "published" ? "default" : r.status === "draft" ? "secondary" : "outline"}>
                      {r.status}
                    </Badge>
                    {r.is_popular && <Badge variant="outline" className="ml-1">popular</Badge>}
                  </TableCell>
                  <TableCell className="text-right text-sm">{r.view_count}</TableCell>
                  <TableCell className="text-right text-sm">
                    {r.helpful_count}/{r.helpful_count + r.not_helpful_count}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(r.updated_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link to="/app/admin/help/articles/$id" params={{ id: r.id }}>
                      <Button size="icon" variant="ghost"><Pencil className="h-4 w-4" /></Button>
                    </Link>
                    <Button size="icon" variant="ghost" onClick={() => onDelete(r.id, r.title)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
