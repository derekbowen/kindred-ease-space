import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Save, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { MarkdownRenderer } from "@/components/help/MarkdownRenderer";
import { SeoPreviewPanel } from "@/components/help/SeoPreviewPanel";
import {
  adminGetArticle,
  adminUpsertArticle,
  adminListCategories,
} from "@/lib/help-admin.functions";

export const Route = createFileRoute("/_authenticated/app/admin/help/articles/$id")({
  head: () => ({ meta: [{ title: "Edit Article — Admin" }] }),
  component: EditArticlePage,
});

type ArticleForm = {
  id: string;
  slug: string;
  title: string;
  category_slug: string;
  excerpt: string;
  content: string;
  status: "draft" | "published" | "archived";
  is_popular: boolean;
  seo_title: string;
  seo_description: string;
  tags: string;
  author_name: string;
};

function EditArticlePage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const getFn = useServerFn(adminGetArticle);
  const upsertFn = useServerFn(adminUpsertArticle);
  const catsFn = useServerFn(adminListCategories);

  const [form, setForm] = useState<ArticleForm | null>(null);
  const [cats, setCats] = useState<Awaited<ReturnType<typeof adminListCategories>>>([]);
  const [meta, setMeta] = useState<{ published_at: string | null; updated_at: string | null }>({
    published_at: null,
    updated_at: null,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [dirty, setDirty] = useState(false);
  const formRef = useRef<ArticleForm | null>(null);
  formRef.current = form;

  useEffect(() => {
    Promise.all([getFn({ data: { id } }), catsFn()])
      .then(([a, c]) => {
        setCats(c);
        if (!a) {
          toast.error("Article not found");
          navigate({ to: "/app/admin/help/articles" });
          return;
        }
        setForm({
          id: a.id,
          slug: a.slug,
          title: a.title,
          category_slug: a.category_slug,
          excerpt: a.excerpt ?? "",
          content: a.content ?? "",
          status: (a.status as ArticleForm["status"]) ?? "draft",
          is_popular: a.is_popular ?? false,
          seo_title: a.seo_title ?? "",
          seo_description: a.seo_description ?? "",
          tags: (a.tags ?? []).join(", "),
          author_name: a.author_name ?? "",
        });
      })
      .catch((e) => toast.error("Failed to load", { description: String(String(e)) }))
      .finally(() => setLoading(false));
  }, [id, getFn, catsFn, navigate, toast]);

  const update = <K extends keyof ArticleForm>(k: K, v: ArticleForm[K]) => {
    setForm((f) => (f ? { ...f, [k]: v } : f));
    setDirty(true);
  };

  const save = async (opts: { silent?: boolean } = {}) => {
    const f = formRef.current;
    if (!f) return;
    setSaving(true);
    try {
      await upsertFn({
        data: {
          id: f.id,
          slug: f.slug,
          title: f.title,
          category_slug: f.category_slug,
          excerpt: f.excerpt || null,
          content: f.content,
          status: f.status,
          is_popular: f.is_popular,
          seo_title: f.seo_title || null,
          seo_description: f.seo_description || null,
          tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean),
          author_name: f.author_name || null,
        },
      });
      setLastSaved(new Date());
      setDirty(false);
      if (!opts.silent) toast.success("Saved");
    } catch (e) {
      toast.error("Save failed", { description: String(String(e)) });
    } finally {
      setSaving(false);
    }
  };

  // Autosave every 30s if dirty
  useEffect(() => {
    if (!form) return;
    const t = setInterval(() => {
      if (dirty && !saving) save({ silent: true });
    }, 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, dirty, saving]);

  const previewArticle = useMemo(() => {
    if (!form) return null;
    return { title: form.title, content: form.content };
  }, [form]);

  if (loading || !form) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Link to="/app/admin/help/articles">
            <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
          </Link>
          <div>
            <h1 className="text-xl font-bold tracking-tight truncate max-w-md">{form.title || "Untitled"}</h1>
            <p className="text-xs text-muted-foreground">
              {dirty ? "Unsaved changes" : lastSaved ? `Saved ${lastSaved.toLocaleTimeString()}` : "All changes saved"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {form.status === "published" && (
            <Link to="/help/$category/$article" params={{ category: form.category_slug, article: form.slug }} target="_blank">
              <Button size="sm" variant="outline"><ExternalLink className="h-4 w-4 mr-1" /> View live</Button>
            </Link>
          )}
          <Button size="sm" onClick={() => save()} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
            Save
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        <div className="space-y-4">
          <Card className="p-4 space-y-4">
            <div>
              <Label htmlFor="title">Title</Label>
              <Input id="title" value={form.title} onChange={(e) => update("title", e.target.value)} className="text-lg font-semibold" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="slug">Slug</Label>
                <Input id="slug" value={form.slug} onChange={(e) => update("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} />
              </div>
              <div>
                <Label htmlFor="category">Category</Label>
                <Select value={form.category_slug} onValueChange={(v) => update("category_slug", v)}>
                  <SelectTrigger id="category"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {cats.map((c) => <SelectItem key={c.slug} value={c.slug}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label htmlFor="excerpt">Excerpt</Label>
              <Textarea id="excerpt" rows={2} value={form.excerpt} onChange={(e) => update("excerpt", e.target.value)} placeholder="One-sentence summary shown in cards and search" />
            </div>
          </Card>

          <Tabs defaultValue="write">
            <TabsList>
              <TabsTrigger value="write">Write</TabsTrigger>
              <TabsTrigger value="preview">Preview</TabsTrigger>
            </TabsList>
            <TabsContent value="write">
              <Card className="p-0 overflow-hidden">
                <Textarea
                  value={form.content}
                  onChange={(e) => update("content", e.target.value)}
                  className="font-mono text-sm min-h-[500px] border-0 rounded-none focus-visible:ring-0"
                  placeholder="# Heading&#10;&#10;Write markdown here…"
                />
              </Card>
            </TabsContent>
            <TabsContent value="preview">
              <Card className="p-6 min-h-[500px]">
                {previewArticle && <MarkdownRenderer content={previewArticle.content} />}
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        <div className="space-y-4">
          <Card className="p-4 space-y-4">
            <div>
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => update("status", v as ArticleForm["status"])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="published">Published</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="popular" className="cursor-pointer">Mark as popular</Label>
              <Switch id="popular" checked={form.is_popular} onCheckedChange={(v) => update("is_popular", v)} />
            </div>
            <div>
              <Label htmlFor="tags">Tags</Label>
              <Input id="tags" value={form.tags} onChange={(e) => update("tags", e.target.value)} placeholder="comma, separated, tags" />
            </div>
            <div>
              <Label htmlFor="author">Author name</Label>
              <Input id="author" value={form.author_name} onChange={(e) => update("author_name", e.target.value)} />
            </div>
          </Card>

          <Card className="p-4 space-y-4">
            <h3 className="text-sm font-semibold">SEO</h3>
            <div>
              <Label htmlFor="seo_title">SEO title</Label>
              <Input id="seo_title" value={form.seo_title} onChange={(e) => update("seo_title", e.target.value)} maxLength={70} />
              <p className="text-xs text-muted-foreground mt-1">{form.seo_title.length}/70</p>
            </div>
            <div>
              <Label htmlFor="seo_desc">SEO description</Label>
              <Textarea id="seo_desc" rows={3} value={form.seo_description} onChange={(e) => update("seo_description", e.target.value)} maxLength={160} />
              <p className="text-xs text-muted-foreground mt-1">{form.seo_description.length}/160</p>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
