import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Loader2,
  Plus,
  ExternalLink,
  Pencil,
  Trash2,
  Upload,
  Sparkles,
  Search,
  FileText,
  Globe,
} from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { listTenantPages, deleteTenantPage } from "@/lib/tenant-pages.functions";
import { getPageBuilderContext } from "@/lib/page-builder.functions";
import { cn } from "@/lib/utils";

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
  const [query, setQuery] = useState("");
  const [stats, setStats] = useState({ published: 0, drafts: 0, cityGaps: 0 });
  const list = useServerFn(listTenantPages);
  const del = useServerFn(deleteTenantPage);
  const ctxFn = useServerFn(getPageBuilderContext);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    setLoading(true);
    Promise.all([list({ data: { workspaceId } }), ctxFn({ data: { workspaceId } })])
      .then(
        ([r, ctx]: [
          { pages?: Row[] },
          { stats: { publishedPages: number; draftPages: number; cityGaps: number } },
        ]) => {
          setRows(r.pages as Row[]);
          setStats({
            published: ctx.stats.publishedPages,
            drafts: ctx.stats.draftPages,
            cityGaps: ctx.stats.cityGaps,
          });
        },
      )
      .finally(() => setLoading(false));
  }, [workspaceId, list, ctxFn]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.slug.toLowerCase().includes(q) ||
        (r.page_templates?.name ?? "").toLowerCase().includes(q),
    );
  }, [rows, query]);

  async function onDelete(id: string) {
    if (!workspaceId) return;
    if (!confirm("Delete this page?")) return;
    await del({ data: { workspaceId, id } });
    setRows((rs) => rs.filter((r) => r.id !== id));
  }

  return (
    <div className="space-y-8 pb-10">
      <section className="relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-muted/40 via-background to-primary/5 p-6 sm:p-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Globe className="h-5 w-5 text-primary" />
              <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Your SEO surface</h1>
            </div>
            <p className="max-w-lg text-sm text-muted-foreground">
              Programmatic landing pages wired to your Sharetribe listings. Every published page
              lives at{" "}
              <code className="rounded bg-muted px-1 font-mono text-xs">/p/{"{slug}"}</code> on your
              domain.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => navigate({ to: "/app/pages/bulk" })}>
              <Upload className="h-4 w-4 mr-2" /> Bulk import
            </Button>
            <Button
              variant="outline"
              onClick={() => navigate({ to: "/app/content/quick-page-builder" })}
            >
              <Sparkles className="h-4 w-4 mr-2" /> AI builder
            </Button>
            <Button onClick={() => navigate({ to: "/app/pages/new" })}>
              <Plus className="h-4 w-4 mr-2" /> New page
            </Button>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-3 gap-3 sm:max-w-md">
          {[
            { label: "Published", value: stats.published, accent: "text-emerald-500" },
            { label: "Drafts", value: stats.drafts, accent: "text-muted-foreground" },
            { label: "City gaps", value: stats.cityGaps, accent: "text-amber-500" },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-lg border border-border/60 bg-background/60 px-3 py-2"
            >
              <p className={cn("text-2xl font-bold tabular-nums", s.accent)}>{s.value}</p>
              <p className="text-[11px] text-muted-foreground">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search pages…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Badge variant="secondary">{filtered.length} pages</Badge>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-16 text-muted-foreground justify-center">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading pages…
        </div>
      ) : filtered.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-4 py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
              <FileText className="h-7 w-7 text-primary" />
            </div>
            <div className="space-y-1">
              <p className="font-semibold">{query ? "No matching pages" : "No pages yet"}</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                {query
                  ? "Try a different search term."
                  : "Generate your first city hub with AI — it takes about a minute and publishes live."}
              </p>
            </div>
            {!query && (
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => navigate({ to: "/app/content/quick-page-builder" })}>
                  <Sparkles className="h-4 w-4 mr-2" /> AI Page Builder
                </Button>
                <Button variant="outline" onClick={() => navigate({ to: "/app/pages/new" })}>
                  Manual editor
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((r) => (
            <Card
              key={r.id}
              className="group overflow-hidden transition hover:border-primary/40 hover:shadow-md"
            >
              <CardContent className="p-0">
                <div className="border-b border-border/40 bg-gradient-to-br from-muted/30 to-transparent px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <Badge
                      variant={r.status === "published" ? "default" : "secondary"}
                      className="shrink-0"
                    >
                      {r.status}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(r.updated_at).toLocaleDateString()}
                    </span>
                  </div>
                  <h3 className="mt-2 font-semibold leading-snug line-clamp-2">{r.title}</h3>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">/p/{r.slug}</p>
                </div>
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-xs text-muted-foreground">
                    {r.page_templates?.name ?? "Page"}
                  </span>
                  <div className="flex gap-0.5 opacity-80 group-hover:opacity-100">
                    {r.status === "published" && (
                      <Button asChild size="icon" variant="ghost" className="h-8 w-8">
                        <a href={`/p/${r.slug}`} target="_blank" rel="noreferrer" title="View live">
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </Button>
                    )}
                    <Button asChild size="icon" variant="ghost" className="h-8 w-8">
                      <Link to="/app/pages/$id/edit" params={{ id: r.id }} title="Edit">
                        <Pencil className="h-4 w-4" />
                      </Link>
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => onDelete(r.id)}
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
