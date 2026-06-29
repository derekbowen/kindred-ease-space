import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Trash2, ArrowUp, ArrowDown, ArrowLeft, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  adminListCategories,
  adminUpsertCategory,
  adminDeleteCategory,
  adminReorderCategories,
} from "@/lib/help-admin.functions";

export const Route = createFileRoute("/_authenticated/app/admin/help/categories")({
  head: () => ({ meta: [{ title: "Help Categories — Admin" }] }),
  component: AdminHelpCategoriesPage,
});

type Cat = Awaited<ReturnType<typeof adminListCategories>>[number];

function AdminHelpCategoriesPage() {
  const listFn = useServerFn(adminListCategories);
  const upsertFn = useServerFn(adminUpsertCategory);
  const deleteFn = useServerFn(adminDeleteCategory);
  const reorderFn = useServerFn(adminReorderCategories);

  const [rows, setRows] = useState<Cat[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<Cat> | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const reload = () => listFn().then(setRows);

  useEffect(() => {
    listFn()
      .then(setRows)
      .catch((e) => {
        if (String(e?.message ?? e).includes("forbidden")) setForbidden(true);
        else toast.error("Load failed", { description: String(String(e)) });
      })
      .finally(() => setLoading(false));
  }, [listFn]);

  const move = async (idx: number, dir: -1 | 1) => {
    const next = [...rows];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    setRows(next);
    try {
      await reorderFn({ data: { ids: next.map((c) => c.id) } });
    } catch (e) {
      toast.error("Reorder failed", { description: String(String(e)) });
      reload();
    }
  };

  const onDelete = async (c: Cat) => {
    if (!confirm(`Delete category "${c.name}"? Articles in it will become orphaned.`)) return;
    try {
      await deleteFn({ data: { id: c.id } });
      setRows((r) => r.filter((x) => x.id !== c.id));
    } catch (e) {
      toast.error("Delete failed", { description: String(String(e)) });
    }
  };

  const onSave = async () => {
    if (!editing) return;
    if (!editing.slug || !editing.name) {
      toast.error("Slug and name required");
      return;
    }
    try {
      await upsertFn({
        data: {
          id: editing.id ?? null,
          slug: editing.slug,
          name: editing.name,
          description: editing.description ?? null,
          icon: editing.icon ?? null,
          sort_order: editing.sort_order ?? rows.length,
          is_published: editing.is_published ?? true,
        },
      });
      setEditing(null);
      reload();
    } catch (e) {
      toast.error("Save failed", { description: String(String(e)) });
    }
  };

  if (forbidden) {
    return (
      <div className="max-w-md mx-auto mt-20 text-center">
        <h1 className="text-2xl font-bold mb-2">Admin only</h1>
        <p className="text-muted-foreground">You need the admin role to manage categories.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Link to="/app/admin/help/articles">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" /> Articles
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Help categories</h1>
            <p className="text-sm text-muted-foreground">
              Drag-to-reorder via arrows. Slug is used in the URL.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          onClick={() =>
            setEditing({ slug: "", name: "", sort_order: rows.length, is_published: true })
          }
        >
          <Plus className="h-4 w-4 mr-2" /> New category
        </Button>
      </div>

      {editing && (
        <Card className="p-4 space-y-4 border-primary">
          <h3 className="font-semibold">{editing.id ? "Edit" : "New"} category</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Slug</Label>
              <Input
                value={editing.slug ?? ""}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
                  })
                }
                placeholder="getting-started"
              />
            </div>
            <div>
              <Label>Name</Label>
              <Input
                value={editing.name ?? ""}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </div>
          </div>
          <div>
            <Label>Description</Label>
            <Textarea
              rows={2}
              value={editing.description ?? ""}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Icon (lucide name)</Label>
              <Input
                value={editing.icon ?? ""}
                onChange={(e) => setEditing({ ...editing, icon: e.target.value })}
                placeholder="rocket"
              />
            </div>
            <div className="flex items-end justify-between gap-4">
              <Label htmlFor="pub" className="cursor-pointer">
                Published
              </Label>
              <Switch
                id="pub"
                checked={editing.is_published ?? true}
                onCheckedChange={(v) => setEditing({ ...editing, is_published: v })}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onSave}>
              <Save className="h-4 w-4 mr-1" /> Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      <Card className="divide-y divide-border">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">No categories yet.</div>
        ) : (
          rows.map((c, i) => (
            <div key={c.id} className="flex items-center gap-3 p-3">
              <div className="flex flex-col">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                >
                  <ArrowUp className="h-3 w-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  onClick={() => move(i, 1)}
                  disabled={i === rows.length - 1}
                >
                  <ArrowDown className="h-3 w-3" />
                </Button>
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium">{c.name}</div>
                <div className="text-xs text-muted-foreground truncate">
                  /{c.slug} · {c.description || "—"}
                </div>
              </div>
              {!c.is_published && (
                <span className="text-xs text-muted-foreground">unpublished</span>
              )}
              <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
                Edit
              </Button>
              <Button size="icon" variant="ghost" onClick={() => onDelete(c)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
