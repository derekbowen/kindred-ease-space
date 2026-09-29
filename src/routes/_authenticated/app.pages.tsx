import { useState } from "react";
import { createFileRoute, Link, Outlet, useChildMatches } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ExternalLink,
  FileText,
  Loader2,
  Plus,
  Search,
  XCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { userMessage } from "@/lib/user-message";
import { listMyPages } from "@/lib/pages.functions";
import { timeAgo, useCurrentWorkspace } from "@/components/pages/use-workspace";
import { pageStatusLabel } from "@/components/pages/page-status";

export const Route = createFileRoute("/_authenticated/app/pages")({
  head: () => ({ meta: [{ title: "Pages — founders.click" }] }),
  component: PagesRoute,
});

// This route has child routes (/new, /$id/edit). TanStack Router renders a
// child only through the parent's <Outlet/>.
function PagesRoute() {
  const childMatches = useChildMatches();
  if (childMatches.length > 0) return <Outlet />;
  return <MyPages />;
}

const TABS = [
  { id: "all", label: "All" },
  { id: "published", label: "Published" },
  { id: "draft", label: "Drafts" },
  { id: "archived", label: "Archived" },
] as const;

const KIND_NAME: Record<string, string> = {
  city_hub: "City Hub",
  category_page: "Category Page",
  resource_article: "Resource Article",
};

const STATUS_CLASS: Record<string, string> = {
  draft: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  published: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  archived: "border-border bg-muted text-muted-foreground",
  billing_suspended: "border-orange-500/40 bg-orange-500/10 text-orange-700",
};

function MyPages() {
  const { workspaceId } = useCurrentWorkspace();
  const listFn = useServerFn(listMyPages);
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("all");
  const [query, setQuery] = useState("");
  const q = useQuery({
    queryKey: ["my-pages", workspaceId],
    queryFn: () => listFn({ data: { workspaceId: workspaceId! } }),
    enabled: !!workspaceId,
    refetchInterval: (s) => (s.state.data?.pages.some((p) => p.generating) ? 4000 : false),
  });

  const pages = q.data?.pages ?? [];
  const count = (id: string) =>
    id === "all" ? pages.length : pages.filter((p) => p.status === id).length;
  const shown = pages
    .filter((p) => tab === "all" || p.status === tab)
    .filter((p) => {
      const s = query.trim().toLowerCase();
      return !s || (p.title ?? "").toLowerCase().includes(s) || p.slug.includes(s);
    });

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pages</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your drafts and the pages live on your domain.
          </p>
        </div>
        <Button asChild>
          <Link to="/app/pages/new">
            <Plus className="mr-1 h-4 w-4" /> New page
          </Link>
        </Button>
      </div>

      {q.data && !q.data.domain.ready && (
        <Card className="border-amber-500/40">
          <CardContent className="flex flex-col gap-2 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div>
                <p className="font-medium">Pages can't go live until your domain is connected</p>
                <p className="text-muted-foreground">{q.data.domain.step}</p>
              </div>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link to="/app/settings/domains">Open Domains</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {q.isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading your pages…
        </p>
      )}
      {q.error && (
        <Card className="border-destructive/40">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            {userMessage(q.error, "Couldn't load your pages. Try again in a minute.")}
          </CardContent>
        </Card>
      )}

      {q.data && (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-1">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "rounded-md px-2.5 py-1.5 text-sm",
                    tab === t.id
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {t.label} <span className="tabular-nums opacity-70">{count(t.id)}</span>
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search pages"
                className="h-9 pl-7 sm:w-56"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>

          {shown.length === 0 ? (
            <Card>
              <CardContent className="space-y-3 p-8 text-center text-sm text-muted-foreground">
                <FileText className="mx-auto h-8 w-8 opacity-50" />
                {pages.length === 0 ? (
                  <>
                    <p>
                      No pages yet. Start from an opportunity your listings support, or create one
                      yourself.
                    </p>
                    <div className="flex justify-center gap-2">
                      <Button asChild size="sm">
                        <Link to="/app/opportunities">See opportunities</Link>
                      </Button>
                      <Button asChild size="sm" variant="outline">
                        <Link to="/app/pages/new">New page</Link>
                      </Button>
                    </div>
                  </>
                ) : (
                  <p>No pages match.</p>
                )}
              </CardContent>
            </Card>
          ) : (
            <ul className="divide-y rounded-lg border">
              {shown.map((p) => {
                const cls = STATUS_CLASS[p.status] ?? "";
                return (
                  <li
                    key={p.id}
                    className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          to="/app/pages/$id/edit"
                          params={{ id: p.id }}
                          className="truncate font-medium hover:underline"
                        >
                          {p.title || p.slug}
                        </Link>
                        <Badge variant="outline" className={cn("text-xs", cls)}>
                          {p.generating ? "Being written" : pageStatusLabel(p.status)}
                        </Badge>
                        {p.generationState === "failed" && !p.generating && (
                          <Badge
                            variant="outline"
                            className="border-destructive/40 text-xs text-destructive"
                          >
                            Writing failed
                          </Badge>
                        )}
                        {p.noindex && (
                          <Badge variant="outline" className="text-xs">
                            Hidden from search
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {p.kind ? KIND_NAME[p.kind] : "Unknown template"} · /a/{p.slug} · updated{" "}
                        {timeAgo(p.updatedAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {p.liveUrl && (
                        <Button asChild size="sm" variant="ghost">
                          <a href={p.liveUrl} target="_blank" rel="noopener noreferrer">
                            View <ExternalLink className="ml-1 h-3.5 w-3.5" />
                          </a>
                        </Button>
                      )}
                      <Button asChild size="sm" variant="outline">
                        <Link to="/app/pages/$id/edit" params={{ id: p.id }}>
                          {p.status === "draft" ? "Edit" : "Open"}
                        </Link>
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
