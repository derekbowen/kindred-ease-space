import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Info,
  Loader2,
  MapPin,
  RefreshCw,
  Search,
  Tag,
  Undo2,
  XCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { userMessage } from "@/lib/user-message";
import {
  getCoverage,
  setCoverageDismissed,
  type CoverageView,
} from "@/lib/coverage/coverage.functions";
import type { CoverageItem, CoverageState } from "@/lib/coverage/coverage.server";
import { restorePage } from "@/lib/pages.functions";
import { timeAgo, useCurrentWorkspace } from "@/components/pages/use-workspace";

export const Route = createFileRoute("/_authenticated/app/opportunities")({
  head: () => ({ meta: [{ title: "Opportunities — founders.click" }] }),
  component: OpportunitiesPage,
});

const VIEWS: Array<{ id: CoverageView; label: string }> = [
  { id: "open", label: "Open" },
  { id: "missing", label: "No page yet" },
  { id: "draft", label: "Drafts" },
  { id: "published", label: "Published" },
  { id: "archived", label: "Archived" },
  { id: "insufficient", label: "Not enough listings" },
  { id: "dismissed", label: "Dismissed" },
  { id: "all", label: "All" },
];

const STATE_BADGE: Record<CoverageState, { label: string; cls: string }> = {
  missing: {
    label: "No page yet",
    cls: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  draft: {
    label: "Draft in progress",
    cls: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  published: {
    label: "Published",
    cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  suspended: {
    label: "Paused by plan",
    cls: "border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  },
  archived: { label: "Archived", cls: "border-border bg-muted text-muted-foreground" },
  insufficient: {
    label: "Not enough listings",
    cls: "border-border bg-muted text-muted-foreground",
  },
};

const PAGE_SIZE = 50;

function itemTitle(i: CoverageItem): string {
  const cat = i.labels.category ? humanize(i.labels.category) : null;
  if (i.kind === "category_page") return cat ?? "Listings with no category";
  const place = [i.labels.city, i.labels.region, i.labels.country].filter(Boolean).join(", ");
  return `${place || "Listings with no location"}${cat ? ` · ${cat}` : ""}`;
}

function humanize(raw: string): string {
  const s = raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : raw;
}

function OpportunitiesPage() {
  const { workspaceId } = useCurrentWorkspace();
  const [view, setView] = useState<CoverageView>("open");
  const [kind, setKind] = useState<"all" | "city_hub" | "category_page">("all");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const qc = useQueryClient();
  const fetchCoverage = useServerFn(getCoverage);
  const dismissFn = useServerFn(setCoverageDismissed);
  const restoreFn = useServerFn(restorePage);

  const q = useQuery({
    queryKey: ["coverage", workspaceId, view, kind, page],
    queryFn: () =>
      fetchCoverage({ data: { workspaceId: workspaceId!, view, kind, page, pageSize: PAGE_SIZE } }),
    enabled: !!workspaceId,
    placeholderData: (prev) => prev,
  });

  const dismiss = useMutation({
    mutationFn: (v: { targetKey: string; dismissed: boolean }) =>
      dismissFn({
        data: { workspaceId: workspaceId!, targetKey: v.targetKey, dismissed: v.dismissed },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["coverage", workspaceId] }),
    onError: (e) => setActionError(userMessage(e, "Couldn't update this opportunity. Try again.")),
  });
  const restore = useMutation({
    mutationFn: (pageId: string) => restoreFn({ data: { workspaceId: workspaceId!, pageId } }),
    onSuccess: (r) => {
      if (!r.ok) setActionError(userMessage(r.message, "Couldn't restore that page."));
      qc.invalidateQueries({ queryKey: ["coverage", workspaceId] });
    },
    onError: (e) => setActionError(userMessage(e, "Couldn't restore that page. Try again.")),
  });

  const data = q.data;
  const items = (data?.items ?? []).filter((i) =>
    search.trim() ? itemTitle(i).toLowerCase().includes(search.trim().toLowerCase()) : true,
  );
  const pages = data ? Math.max(1, Math.ceil(data.viewTotal / data.pageSize)) : 1;

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Opportunities</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Inventory-backed coverage opportunities: the places and categories your published listings
          support, and whether each one has a page yet.
        </p>
      </div>

      {q.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading your listings and pages…
        </div>
      )}
      {q.error && (
        <Card className="border-destructive/40">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium">Couldn't load your opportunities.</p>
              <p className="text-muted-foreground">
                {userMessage(
                  q.error,
                  "Nothing is shown rather than a wrong number. Try again in a minute.",
                )}
              </p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => q.refetch()}>
                <RefreshCw className="mr-1 h-3.5 w-3.5" /> Try again
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          <EvidenceBanner evidence={data.evidence} />

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="No page yet"
              value={data.totals.missing}
              hint="enough listings for a page"
            />
            <Stat label="Drafts" value={data.totals.draft} hint="in progress" />
            <Stat
              label="Published"
              value={data.totals.published + data.totals.suspended}
              hint={
                data.totals.suspended ? `${data.totals.suspended} paused by plan` : "live coverage"
              }
            />
            <Stat
              label="Published listings"
              value={data.totals.listings}
              hint="in your marketplace"
            />
          </div>

          {(data.totals.withoutCity > 0 ||
            data.totals.withoutCategory > 0 ||
            data.totals.needsResync > 0) && (
            <Card>
              <CardContent className="flex items-start gap-3 p-4 text-sm">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="space-y-1 text-muted-foreground">
                  {data.totals.withoutCity > 0 && (
                    <p>
                      <span className="font-medium text-foreground">{data.totals.withoutCity}</span>{" "}
                      listing
                      {data.totals.withoutCity === 1 ? " has" : "s have"} no city, so no City Hub
                      can show {data.totals.withoutCity === 1 ? "it" : "them"}.
                    </p>
                  )}
                  {data.totals.withoutCategory > 0 && (
                    <p>
                      <span className="font-medium text-foreground">
                        {data.totals.withoutCategory}
                      </span>{" "}
                      listing
                      {data.totals.withoutCategory === 1 ? " has" : "s have"} no category, so no
                      Category Page can show {data.totals.withoutCategory === 1 ? "it" : "them"}.
                    </p>
                  )}
                  {data.totals.needsResync > 0 && (
                    <p>
                      {data.totals.needsResync} listing
                      {data.totals.needsResync === 1 ? " was" : "s were"} synced before locations
                      were matched —{" "}
                      <Link to="/app/settings/integrations/sharetribe" className="underline">
                        run a sync
                      </Link>{" "}
                      to count {data.totals.needsResync === 1 ? "it" : "them"}.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="-mx-1 flex flex-wrap gap-1">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => {
                    setView(v.id);
                    setPage(1);
                  }}
                  className={cn(
                    "rounded-md px-2.5 py-1.5 text-sm transition-colors",
                    view === v.id
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-muted",
                  )}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <select
                aria-label="Page type"
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as typeof kind);
                  setPage(1);
                }}
              >
                <option value="all">All page types</option>
                <option value="city_hub">City Hubs</option>
                <option value="category_page">Category Pages</option>
              </select>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  aria-label="Filter this page of results"
                  placeholder="Filter"
                  className="h-9 w-36 pl-7"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
          </div>

          {actionError && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {actionError}
            </p>
          )}

          {items.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-center text-sm text-muted-foreground">
                {data.viewTotal === 0
                  ? emptyText(view, data.totals.targets)
                  : "Nothing on this page matches the filter."}
              </CardContent>
            </Card>
          ) : (
            <ul className="space-y-2">
              {items.map((i) => (
                <OpportunityRow
                  key={i.targetKey}
                  item={i}
                  busy={dismiss.isPending || restore.isPending}
                  onDismiss={(d) => dismiss.mutate({ targetKey: i.targetKey, dismissed: d })}
                  onRestore={(pageId) => restore.mutate(pageId)}
                />
              ))}
            </ul>
          )}

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {data.viewTotal === 0
                ? "0 results"
                : `${(data.page - 1) * data.pageSize + 1}–${Math.min(data.page * data.pageSize, data.viewTotal)} of ${data.viewTotal}`}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1 || q.isFetching}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= pages || q.isFetching}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">{data.scopeNote}</p>
        </>
      )}
    </div>
  );
}

function emptyText(view: CoverageView, targets: number): string {
  if (targets === 0)
    return "No opportunities yet: once your listings sync with a city or a category, they appear here.";
  switch (view) {
    case "open":
      return "Nothing open: every place and category with enough listings has a page or is dismissed.";
    case "draft":
      return "No drafts in progress.";
    case "published":
      return "No published pages yet.";
    case "dismissed":
      return "Nothing dismissed.";
    default:
      return "Nothing here.";
  }
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value.toLocaleString()}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function EvidenceBanner({
  evidence,
}: {
  evidence: {
    state: string;
    message: string;
    lastSuccessAt: string | null;
    listingsCount: number | null;
    upstreamTotal: number | null;
  };
}) {
  const ok = evidence.state === "complete";
  return (
    <Card className={cn(!ok && "border-amber-500/40")}>
      <CardContent className="flex flex-col gap-2 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          {ok ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          )}
          <div>
            <p className={cn(!ok && "font-medium")}>
              {userMessage(evidence.message, "Sync status is unavailable right now.")}
            </p>
            <p className="text-xs text-muted-foreground">
              Last complete sync: {timeAgo(evidence.lastSuccessAt)}
            </p>
          </div>
        </div>
        {evidence.state === "never_synced" ? (
          <Button asChild size="sm">
            <Link to="/app/settings/integrations/sharetribe">Connect Sharetribe</Link>
          </Button>
        ) : !ok ? (
          <Button asChild size="sm" variant="outline">
            <Link to="/app/settings/integrations/sharetribe">Open sync</Link>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function OpportunityRow({
  item,
  busy,
  onDismiss,
  onRestore,
}: {
  item: CoverageItem;
  busy: boolean;
  onDismiss: (dismissed: boolean) => void;
  onRestore: (pageId: string) => void;
}) {
  const badge = STATE_BADGE[item.state];
  const Icon = item.kind === "city_hub" ? MapPin : Tag;
  return (
    <li>
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="font-medium">{itemTitle(item)}</span>
              <Badge variant="outline" className="text-xs">
                {item.kind === "city_hub" ? "City Hub" : "Category Page"}
              </Badge>
              <Badge variant="outline" className={cn("text-xs", badge.cls)}>
                {item.dismissed ? "Dismissed" : badge.label}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium tabular-nums text-foreground">{item.listingCount}</span>{" "}
              published listing
              {item.listingCount === 1 ? "" : "s"} · {item.reason}
            </p>
            {item.warnings.map((w) => (
              <p
                key={w}
                className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300"
              >
                <AlertTriangle className="h-3 w-3" /> {w}
              </p>
            ))}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {item.dismissed ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onDismiss(false)}>
                <Undo2 className="mr-1 h-3.5 w-3.5" /> Restore to list
              </Button>
            ) : (
              <>
                {item.state === "missing" && (
                  <Button asChild size="sm">
                    <Link to="/app/pages/new" search={{ target: item.targetKey, kind: item.kind }}>
                      Create page <ArrowRight className="ml-1 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                )}
                {item.state === "draft" && item.page && (
                  <Button asChild size="sm">
                    <Link to="/app/pages/$id/edit" params={{ id: item.page.id }}>
                      Resume draft
                    </Link>
                  </Button>
                )}
                {(item.state === "published" || item.state === "suspended") && item.page && (
                  <Button asChild size="sm" variant="outline">
                    <Link to="/app/pages/$id/edit" params={{ id: item.page.id }}>
                      Review page
                    </Link>
                  </Button>
                )}
                {item.state === "archived" && item.page && (
                  <>
                    <Button size="sm" disabled={busy} onClick={() => onRestore(item.page!.id)}>
                      Restore draft
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <Link
                        to="/app/pages/new"
                        search={{ target: item.targetKey, kind: item.kind }}
                      >
                        New page
                      </Link>
                    </Button>
                  </>
                )}
                {(item.state === "missing" ||
                  item.state === "insufficient" ||
                  item.state === "archived") && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDismiss(true)}>
                    Dismiss
                  </Button>
                )}
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </li>
  );
}
