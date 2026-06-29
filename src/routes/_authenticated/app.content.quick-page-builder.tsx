import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Sparkles,
  Loader2,
  ExternalLink,
  Zap,
  MapPin,
  ArrowRight,
  Pencil,
  CheckCircle2,
} from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { createQuickPage } from "@/lib/admin-quick-page.functions";
import { getPageBuilderContext } from "@/lib/page-builder.functions";
import type { BuilderCity } from "@/lib/page-builder.functions";
import { GenerationProgress } from "@/components/pages/GenerationProgress";
import { PageLivePreview } from "@/components/pages/PageLivePreview";
import { PageSeoPreview } from "@/components/pages/PageSeoPreview";
import { PAGE_PRESETS, slugifyPageTitle } from "@/components/pages/page-builder-utils";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/app/content/quick-page-builder")({
  head: () => ({ meta: [{ title: "Quick Page Builder — founders.click" }] }),
  component: QuickPageBuilder,
});

function QuickPageBuilder() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [preset, setPreset] = useState("city");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [topic, setTopic] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [model, setModel] = useState("google/gemini-3.1-pro-preview");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    url_path: string;
    title: string;
    words: number;
    slug: string;
  } | null>(null);
  const [ctx, setCtx] = useState<{
    domain: string | null;
    cities: BuilderCity[];
    gaps: BuilderCity[];
    stats: { cityGaps: number; publishedPages: number };
  } | null>(null);

  const create = useServerFn(createQuickPage);
  const loadCtx = useServerFn(getPageBuilderContext);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    loadCtx({ data: { workspaceId } }).then((r) =>
      setCtx({ domain: r.domain, cities: r.cities, gaps: r.gaps, stats: r.stats }),
    );
  }, [workspaceId, loadCtx]);

  const slug = title ? slugifyPageTitle(title) : "";
  const canSubmit = !!workspaceId && title.trim().length >= 3 && topic.trim().length >= 10 && !busy;
  const activePreset = PAGE_PRESETS.find((p) => p.id === preset) ?? PAGE_PRESETS[0];

  const previewListingCount = useMemo(() => {
    if (!city || !ctx?.cities) return 0;
    const match = ctx.cities.find(
      (g) => g.city.toLowerCase() === city.toLowerCase() && (!state || g.state === state),
    );
    return match?.listingCount ?? 0;
  }, [city, state, ctx]);

  function applyPreset(id: string) {
    setPreset(id);
    const p = PAGE_PRESETS.find((x) => x.id === id);
    if (!p || id === "ai") return;
    setTitle(p.buildTitle({ city, state }));
    setTopic(p.buildTopic({ city, state }));
  }

  function applyCityGap(g: BuilderCity) {
    setPreset("city");
    setCity(g.city);
    setState(g.state ?? "");
    const p = PAGE_PRESETS[0];
    setTitle(p.buildTitle({ city: g.city, state: g.state ?? undefined }));
    setTopic(p.buildTopic({ city: g.city, state: g.state ?? undefined }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId) return;
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const res = await create({
        data: {
          workspaceId,
          title,
          description,
          topic,
          model,
          city: city || undefined,
          state: state || undefined,
          categoryPlural: preset === "city" ? "pools" : "listings",
        },
      });
      setResult({
        url_path: res.page.url_path ?? "",
        title: res.page.title ?? "(untitled)",
        words: res.words,
        slug: res.page.slug ?? slug,
      });
      setTitle("");
      setDescription("");
      setTopic("");
      setCity("");
      setState("");
      if (workspaceId) {
        loadCtx({ data: { workspaceId } }).then((r) =>
          setCtx({ domain: r.domain, cities: r.cities, gaps: r.gaps, stats: r.stats }),
        );
      }
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8 pb-10">
      <section className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/15 via-background to-violet-500/10 p-6 sm:p-8">
        <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-primary/20 blur-3xl" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/20">
                <Zap className="h-5 w-5 text-primary" />
              </div>
              <Badge variant="secondary" className="gap-1">
                <Sparkles className="h-3 w-3" /> AI Page Builder
              </Badge>
            </div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Ship SEO pages in 60 seconds</h1>
            <p className="max-w-xl text-sm text-muted-foreground">
              Describe the page, we write on-brand copy, wire up your listing grid, and publish live at{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">/p/{"{slug}"}</code>.
            </p>
          </div>
          {ctx && (
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">{ctx.stats.publishedPages} published</Badge>
              {ctx.stats.cityGaps > 0 && (
                <Badge variant="outline" className="border-amber-500/40 text-amber-600">
                  {ctx.stats.cityGaps} city gaps
                </Badge>
              )}
            </div>
          )}
        </div>
      </section>

      {ctx && ctx.gaps.length > 0 && !busy && !result && (
        <Card className="border-amber-500/20 bg-amber-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <MapPin className="h-4 w-4 text-amber-500" />
              Cities with listings but no page yet
            </CardTitle>
            <CardDescription>One click pre-fills a city hub brief — highest ROI pages first.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {ctx.gaps.map((g) => (
              <Button
                key={`${g.city}-${g.state}`}
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 border-amber-500/30 hover:bg-amber-500/10"
                onClick={() => applyCityGap(g)}
              >
                {g.city}
                {g.state ? `, ${g.state}` : ""}
                <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">
                  {g.listingCount}
                </Badge>
              </Button>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Page type</CardTitle>
              <CardDescription>Pick a template — we tune the AI brief automatically.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {PAGE_PRESETS.map((p) => {
                  const Icon = p.icon;
                  const selected = preset === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => applyPreset(p.id)}
                      className={cn(
                        "group relative overflow-hidden rounded-xl border p-3 text-left transition-all",
                        selected
                          ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                          : "border-border hover:border-primary/40 hover:bg-muted/30",
                      )}
                    >
                      <div
                        className={cn(
                          "absolute inset-0 bg-gradient-to-br opacity-60",
                          p.accent,
                        )}
                      />
                      <div className="relative">
                        <Icon
                          className={cn(
                            "h-5 w-5",
                            selected ? "text-primary" : "text-muted-foreground",
                          )}
                        />
                        <p className="mt-2 text-sm font-medium">{p.label}</p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2">
                          {p.description}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Your brief</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="space-y-4">
                {preset === "city" && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="city">City</Label>
                      <Input
                        id="city"
                        placeholder="Los Angeles"
                        value={city}
                        onChange={(e) => setCity(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="state">State</Label>
                      <Input
                        id="state"
                        placeholder="CA"
                        value={state}
                        onChange={(e) => setState(e.target.value)}
                      />
                    </div>
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="title">Page title</Label>
                  <Input
                    id="title"
                    placeholder={activePreset.buildTitle({ city, state })}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                  {slug && (
                    <p className="text-xs text-muted-foreground">
                      Live URL:{" "}
                      <code className="rounded bg-muted px-1 font-mono">/p/{slug}</code>
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="description">Meta description hint (optional)</Label>
                  <Input
                    id="description"
                    placeholder="One line the AI will optimize for search"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={500}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="topic">What should this page cover?</Label>
                  <Textarea
                    id="topic"
                    rows={5}
                    placeholder={activePreset.buildTopic({ city, state }) || "Describe the angle, audience, facts to include…"}
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{topic.length} chars · min 10</p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="model">AI model</Label>
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger id="model">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="google/gemini-3.1-pro-preview">Gemini 3.1 Pro — best quality</SelectItem>
                      <SelectItem value="google/gemini-3.5-flash">Gemini 3.5 Flash — balanced</SelectItem>
                      <SelectItem value="google/gemini-3-flash-preview">Gemini 3 Flash — fast & cheap</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {error && (
                  <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                    {error}
                  </p>
                )}

                {result && (
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
                    <div className="flex items-start gap-3">
                      <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
                      <div className="min-w-0 flex-1 space-y-2">
                        <p className="font-semibold">Published — {result.words} words</p>
                        <p className="text-sm text-muted-foreground truncate">{result.title}</p>
                        <div className="flex flex-wrap gap-2">
                          <Button asChild size="sm">
                            <a href={result.url_path} target="_blank" rel="noreferrer">
                              View live <ExternalLink className="ml-1 h-3.5 w-3.5" />
                            </a>
                          </Button>
                          <Button asChild size="sm" variant="outline">
                            <Link to="/app/pages">All pages</Link>
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-3 pt-2">
                  <Button type="submit" disabled={!canSubmit} size="lg" className="gap-2">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    {busy ? "Generating…" : "Generate & publish"}
                  </Button>
                  <Button asChild variant="ghost" size="sm">
                    <Link to="/app/pages/new" className="gap-1 text-muted-foreground">
                      <Pencil className="h-3.5 w-3.5" /> Manual editor
                    </Link>
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <GenerationProgress active={busy} />
        </div>

        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <PageSeoPreview
            title={title}
            slug={slug}
            metaDescription={description}
            domain={ctx?.domain}
          />
          <PageLivePreview
            domain={ctx?.domain}
            page={{
              title,
              slug,
              metaDescription: description,
              h1: title,
              bodyMarkdown: "",
              city: city || undefined,
              state: state || undefined,
              categoryPlural: preset === "city" ? "pools" : "listings",
              listingCount: previewListingCount,
            }}
          />
          <Card className="border-dashed">
            <CardContent className="flex items-center gap-3 p-4 text-sm">
              <ArrowRight className="h-4 w-4 shrink-0 text-primary" />
              <p className="text-muted-foreground">
                Need bulk city pages?{" "}
                <Link to="/app/pages/bulk" className="font-medium text-primary hover:underline">
                  CSV import
                </Link>{" "}
                or ask Coach to draft cities.
              </p>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}