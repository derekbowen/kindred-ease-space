import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Loader2, Save, ExternalLink } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import {
  listPageTemplates,
  getTenantPage,
  upsertTenantPage,
} from "@/lib/tenant-pages.functions";

export const Route = createFileRoute("/_authenticated/app/pages/$id/edit")({
  head: () => ({ meta: [{ title: "Edit page — founders.click" }] }),
  component: EditPage,
});

type Template = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  is_active: boolean;
  config_schema: any;
};

function EditPage() {
  const { id } = Route.useParams();
  const isNew = id === "new";
  const navigate = useNavigate();

  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState<string>("");
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [h1, setH1] = useState("");
  const [bodyMarkdown, setBodyMarkdown] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [categoryPlural, setCategoryPlural] = useState("listings");
  const [limit, setLimit] = useState(24);
  const [status, setStatus] = useState<"draft" | "published">("draft");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const tplFn = useServerFn(listPageTemplates);
  const getFn = useServerFn(getTenantPage);
  const saveFn = useServerFn(upsertTenantPage);

  useEffect(() => {
    Promise.all([getMe(), tplFn()]).then(([me, t]) => {
      setWorkspaceId(me.memberships[0]?.workspace_id ?? null);
      const tpls = (t.templates as Template[]).filter((x) => x.is_active);
      setTemplates(tpls);
      if (isNew && tpls[0]) setTemplateId(tpls[0].id);
    });
  }, [tplFn, isNew]);

  useEffect(() => {
    if (isNew || !workspaceId) {
      setLoading(false);
      return;
    }
    getFn({ data: { workspaceId, id } }).then((r) => {
      const p = r.page as any;
      if (p) {
        setTemplateId(p.template_id);
        setSlug(p.slug);
        setTitle(p.title);
        setMetaDescription(p.meta_description ?? "");
        setH1(p.h1 ?? "");
        setBodyMarkdown(p.body_markdown ?? "");
        setCity(p.variables?.city ?? "");
        setState(p.variables?.state ?? "");
        setCategoryPlural(p.variables?.category_plural ?? "listings");
        setLimit(Number(p.listing_filter?.limit ?? 24));
        setStatus(p.status === "published" ? "published" : "draft");
      }
      setLoading(false);
    });
  }, [isNew, workspaceId, id, getFn]);

  async function onSave(publish: boolean) {
    if (!workspaceId || !templateId) return;
    setSaving(true);
    setErr(null);
    try {
      const r = await saveFn({
        data: {
          workspaceId,
          id: isNew ? undefined : id,
          templateId,
          slug,
          title,
          metaDescription: metaDescription || null,
          h1: h1 || null,
          bodyMarkdown: bodyMarkdown || null,
          variables: { city, state, category_plural: categoryPlural },
          listingFilter: { city, state, limit, sort: "newest" },
          status: publish ? "published" : status,
        },
      });
      if (r.ok) {
        navigate({ to: "/app/pages" });
      } else {
        setErr(r.error);
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="p-8 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{isNew ? "New page" : "Edit page"}</h1>
          <p className="text-muted-foreground text-sm">
            Pages render at <code className="font-mono">/p/&lt;slug&gt;</code>
          </p>
        </div>
        {!isNew && status === "published" && (
          <Button asChild variant="outline" size="sm">
            <a href={`/p/${slug}`} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4 mr-2" /> View
            </a>
          </Button>
        )}
      </header>

      {err && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {err}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Template</CardTitle>
          <CardDescription>Pick a template. v1 ships with City Hub; more coming.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => setTemplateId(t.id)}
                className={`text-left rounded-lg border p-3 transition ${
                  templateId === t.id
                    ? "border-primary bg-primary/10"
                    : "border-border hover:border-primary/50"
                }`}
              >
                <div className="font-medium">{t.name}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{t.description}</div>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>SEO &amp; content</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Slug</Label>
              <Input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="austin-pools"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <div className="flex gap-2 items-center">
                <Badge variant={status === "published" ? "default" : "secondary"}>{status}</Badge>
              </div>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>SEO title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </div>
          <div className="space-y-1.5">
            <Label>Meta description</Label>
            <Textarea
              value={metaDescription}
              onChange={(e) => setMetaDescription(e.target.value)}
              maxLength={320}
              rows={2}
            />
          </div>
          <div className="space-y-1.5">
            <Label>H1</Label>
            <Input value={h1} onChange={(e) => setH1(e.target.value)} maxLength={200} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label>City</Label>
              <Input value={city} onChange={(e) => setCity(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>State</Label>
              <Input value={state} onChange={(e) => setState(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Category (plural)</Label>
              <Input value={categoryPlural} onChange={(e) => setCategoryPlural(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Listings to show</Label>
            <Input
              type="number"
              min={1}
              max={100}
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.min(100, Number(e.target.value) || 24)))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Body content (markdown)</Label>
            <Textarea
              value={bodyMarkdown}
              onChange={(e) => setBodyMarkdown(e.target.value)}
              rows={10}
              placeholder="Write your long-form content here. Markdown supported."
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button onClick={() => onSave(false)} disabled={saving} variant="outline">
          {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          <Save className="h-4 w-4 mr-2" /> Save draft
        </Button>
        <Button onClick={() => onSave(true)} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Publish
        </Button>
      </div>
    </div>
  );
}
