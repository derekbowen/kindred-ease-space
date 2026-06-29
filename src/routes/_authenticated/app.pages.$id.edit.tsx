import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import {
  Loader2,
  Save,
  ExternalLink,
  Building2,
  FileText,
  Search,
  LayoutGrid,
  Eye,
} from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { listPageTemplates, getTenantPage, upsertTenantPage } from "@/lib/tenant-pages.functions";
import { getPageBuilderContext } from "@/lib/page-builder.functions";
import { InlineCoach } from "@/components/coach/InlineCoach";
import { PageLivePreview } from "@/components/pages/PageLivePreview";
import { PageSeoPreview } from "@/components/pages/PageSeoPreview";
import { slugifyPageTitle } from "@/components/pages/page-builder-utils";
import { cn } from "@/lib/utils";

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
};

const TEMPLATE_ICONS: Record<string, typeof Building2> = {
  city_hub: Building2,
};

function EditPage() {
  const { id } = Route.useParams();
  const isNew = id === "new";
  const navigate = useNavigate();

  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [domain, setDomain] = useState<string | null>(null);
  const [listingCount, setListingCount] = useState(0);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState<string>("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [title, setTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [h1, setH1] = useState("");
  const [h1Touched, setH1Touched] = useState(false);
  const [bodyMarkdown, setBodyMarkdown] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [categoryPlural, setCategoryPlural] = useState("listings");
  const [limit, setLimit] = useState(24);
  const [status, setStatus] = useState<"draft" | "published">("draft");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState("content");

  const tplFn = useServerFn(listPageTemplates);
  const getFn = useServerFn(getTenantPage);
  const saveFn = useServerFn(upsertTenantPage);
  const ctxFn = useServerFn(getPageBuilderContext);

  useEffect(() => {
    Promise.all([getMe(), tplFn()]).then(([me, t]) => {
      const wsId = me.memberships[0]?.workspace_id ?? null;
      setWorkspaceId(wsId);
      const tpls = (t.templates as Template[]).filter((x) => x.is_active);
      setTemplates(tpls);
      if (isNew && tpls[0]) setTemplateId(tpls[0].id);
      if (wsId) {
        ctxFn({ data: { workspaceId: wsId } }).then((r: any) => {
          setDomain(r.domain);
        });
      }
    });
  }, [tplFn, ctxFn, isNew]);

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
        setSlugTouched(true);
        setTitle(p.title);
        setMetaDescription(p.meta_description ?? "");
        setH1(p.h1 ?? "");
        setH1Touched(true);
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

  useEffect(() => {
    if (!workspaceId || !city) {
      setListingCount(0);
      return;
    }
    ctxFn({ data: { workspaceId } }).then((r: any) => {
      const match = r.cities.find(
        (c: any) => c.city.toLowerCase() === city.toLowerCase() && (!state || c.state === state),
      );
      setListingCount(match?.listingCount ?? 0);
    });
  }, [workspaceId, city, state, ctxFn]);

  useEffect(() => {
    if (!slugTouched && title) setSlug(slugifyPageTitle(title));
  }, [title, slugTouched]);

  useEffect(() => {
    if (!h1Touched && title) setH1(title);
  }, [title, h1Touched]);

  const selectedTemplate = templates.find((t) => t.id === templateId);

  const previewPage = useMemo(
    () => ({
      title,
      slug,
      metaDescription,
      h1,
      bodyMarkdown,
      city: city || undefined,
      state: state || undefined,
      categoryPlural,
      listingCount,
    }),
    [title, slug, metaDescription, h1, bodyMarkdown, city, state, categoryPlural, listingCount],
  );

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
      <div className="flex h-[50vh] items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading editor…
      </div>
    );
  }

  const editorForm = (
    <div className="space-y-6 overflow-y-auto p-4 sm:p-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">
              {isNew ? "New page" : "Edit page"}
            </h1>
            <p className="text-sm text-muted-foreground">
              Renders at <code className="font-mono text-xs">/p/{slug || "slug"}</code>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={status === "published" ? "default" : "secondary"}>{status}</Badge>
            <InlineCoach
              workspaceId={workspaceId}
              context={{ page_id: isNew ? undefined : id, route: `/app/pages/${id}/edit` }}
              label="Coach"
            />
          </div>
        </div>
        {err && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {err}
          </div>
        )}
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Template</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2">
            {templates.map((t) => {
              const Icon = TEMPLATE_ICONS[t.slug] ?? FileText;
              const selected = templateId === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTemplateId(t.id)}
                  className={cn(
                    "flex items-start gap-3 rounded-lg border p-3 text-left transition",
                    selected
                      ? "border-primary bg-primary/10"
                      : "border-border hover:border-primary/40",
                  )}
                >
                  <Icon
                    className={cn(
                      "mt-0.5 h-5 w-5 shrink-0",
                      selected ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <div>
                    <p className="font-medium text-sm">{t.name}</p>
                    <p className="text-xs text-muted-foreground">{t.description}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="content" className="gap-1 text-xs sm:text-sm">
            <FileText className="h-3.5 w-3.5" /> Content
          </TabsTrigger>
          <TabsTrigger value="seo" className="gap-1 text-xs sm:text-sm">
            <Search className="h-3.5 w-3.5" /> SEO
          </TabsTrigger>
          <TabsTrigger value="listings" className="gap-1 text-xs sm:text-sm">
            <LayoutGrid className="h-3.5 w-3.5" /> Listings
          </TabsTrigger>
          <TabsTrigger value="preview" className="gap-1 text-xs sm:text-sm xl:hidden">
            <Eye className="h-3.5 w-3.5" /> Preview
          </TabsTrigger>
        </TabsList>

        <TabsContent value="content" className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <Label>Body (markdown)</Label>
            <Textarea
              value={bodyMarkdown}
              onChange={(e) => setBodyMarkdown(e.target.value)}
              rows={14}
              className="font-mono text-sm leading-relaxed"
              placeholder="## Why rent a pool in Austin&#10;&#10;Write long-form content here. Headings, lists, and links supported."
            />
            <p className="text-xs text-muted-foreground">
              {bodyMarkdown.split(/\s+/).filter(Boolean).length} words
            </p>
          </div>
        </TabsContent>

        <TabsContent value="seo" className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <Label>URL slug</Label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">/p/</span>
              <Input
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value);
                }}
                placeholder="austin-pools"
                className="font-mono"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>SEO title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            <p className="text-xs text-muted-foreground">{title.length}/200</p>
          </div>
          <div className="space-y-1.5">
            <Label>Meta description</Label>
            <Textarea
              value={metaDescription}
              onChange={(e) => setMetaDescription(e.target.value)}
              maxLength={320}
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              {metaDescription.length}/320 · aim for 120–160
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>H1 headline</Label>
            <Input
              value={h1}
              onChange={(e) => {
                setH1Touched(true);
                setH1(e.target.value);
              }}
              maxLength={200}
            />
          </div>
          <PageSeoPreview
            title={title}
            slug={slug}
            metaDescription={metaDescription}
            domain={domain}
          />
        </TabsContent>

        <TabsContent value="listings" className="mt-4 space-y-4">
          <CardDescription className="text-sm">
            {selectedTemplate?.slug === "city_hub"
              ? "City Hub pulls live listings from Sharetribe using these filters."
              : "Listing grid filters for this template."}
          </CardDescription>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>City</Label>
              <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Austin" />
            </div>
            <div className="space-y-1.5">
              <Label>State</Label>
              <Input value={state} onChange={(e) => setState(e.target.value)} placeholder="TX" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Category label (plural)</Label>
              <Input value={categoryPlural} onChange={(e) => setCategoryPlural(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Max listings</Label>
              <Input
                type="number"
                min={1}
                max={100}
                value={limit}
                onChange={(e) => setLimit(Math.max(1, Math.min(100, Number(e.target.value) || 24)))}
              />
            </div>
          </div>
          {city && (
            <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{listingCount}</span> synced listings
              match {city}
              {state ? `, ${state}` : ""}
            </p>
          )}
        </TabsContent>

        <TabsContent value="preview" className="mt-4 xl:hidden">
          <PageLivePreview page={previewPage} domain={domain} />
        </TabsContent>
      </Tabs>

      <div className="sticky bottom-0 flex flex-wrap gap-2 border-t border-border bg-background/95 py-4 backdrop-blur">
        <Button onClick={() => onSave(false)} disabled={saving} variant="outline">
          {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          <Save className="h-4 w-4 mr-2" /> Save draft
        </Button>
        <Button onClick={() => onSave(true)} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Publish live
        </Button>
        {!isNew && status === "published" && slug && (
          <Button asChild variant="ghost" size="sm">
            <a href={`/p/${slug}`} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4 mr-2" /> View
            </a>
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <div className="h-[calc(100vh-4rem)] min-h-[600px]">
      <div className="hidden h-full xl:block">
        {/* @ts-expect-error - react-resizable-panels Group direction typing through wrapper */}
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={52} minSize={36}>
            {editorForm}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={48} minSize={30}>
            <div className="h-full overflow-y-auto bg-muted/20 p-4 sm:p-6 space-y-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Live preview
              </p>
              <PageLivePreview page={previewPage} domain={domain} />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <div className="xl:hidden h-full overflow-y-auto">{editorForm}</div>
    </div>
  );
}
