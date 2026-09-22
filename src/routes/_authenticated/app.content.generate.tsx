import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Loader2,
  MapPin,
  Pencil,
  PauseCircle,
  RefreshCw,
  Sparkles,
  Upload,
  XCircle,
} from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import {
  getGenerationJob,
  listGenerationTargets,
  processGenerationItem,
  publishGeneratedPages,
  retryGenerationItem,
  startGenerationJob,
  type GenerationItemRow,
  type GenerationJobRow,
  type PublishResult,
  type TargetListing,
} from "@/lib/generation.functions";

export const Route = createFileRoute("/_authenticated/app/content/generate")({
  head: () => ({ meta: [{ title: "Generate Content — founders.click" }] }),
  component: GenerateContentPage,
});

type Overview = Awaited<ReturnType<typeof listGenerationTargets>>;

/**
 * Batch page generation. The browser is the driver: it creates a job, then
 * calls processGenerationItem for one item at a time so the customer watches
 * each page land (or fail, with a Retry) and nothing runs while they are away.
 */
function GenerateContentPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [model, setModel] = useState<string>("");
  const [job, setJob] = useState<GenerationJobRow | null>(null);
  const [items, setItems] = useState<GenerationItemRow[]>([]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishResults, setPublishResults] = useState<PublishResult[] | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const stopRef = useRef(false);

  const fetchTargets = useServerFn(listGenerationTargets);
  const startJob = useServerFn(startGenerationJob);
  const processItem = useServerFn(processGenerationItem);
  const retryItem = useServerFn(retryGenerationItem);
  const fetchJob = useServerFn(getGenerationJob);
  const publishAll = useServerFn(publishGeneratedPages);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const r = await fetchTargets({ data: { workspaceId } });
      setOverview(r);
      setModel((m) => m || r.defaultModel);
      // Drop selections that are no longer eligible.
      setSelected((prev) => {
        const eligible = new Set(
          r.targets.filter((t) => !t.alreadyGenerated).map((t) => t.targetKey),
        );
        return new Set([...prev].filter((k) => eligible.has(k)));
      });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, fetchTargets]);

  useEffect(() => {
    if (workspaceId) load();
  }, [workspaceId, load]);

  const eligible = useMemo(
    () => (overview?.targets ?? []).filter((t) => !t.alreadyGenerated),
    [overview],
  );
  const selectedCount = selected.size;
  const remaining = overview?.remainingToday ?? 0;
  const paused = overview?.paused ?? false;
  const overCap = selectedCount > remaining;
  const canGenerate =
    !!workspaceId && !paused && !running && selectedCount > 0 && !overCap && !!model;

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectUpTo(n: number) {
    setSelected(new Set(eligible.slice(0, Math.max(0, n)).map((t) => t.targetKey)));
  }

  function replaceItem(updated: GenerationItemRow) {
    setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
  }

  /** Drive the job's open items one at a time, updating the list as we go. */
  async function drive(jobId: string, queue: GenerationItemRow[]) {
    setRunning(true);
    stopRef.current = false;
    try {
      for (const it of queue) {
        if (stopRef.current) break;
        if (it.status === "done" || it.status === "skipped") continue;
        replaceItem({ ...it, status: "running" });
        const r = await processItem({ data: { workspaceId: workspaceId!, itemId: it.id } });
        replaceItem(r.item);
      }
      const fresh = await fetchJob({ data: { workspaceId: workspaceId!, jobId } });
      setJob(fresh.job);
      setItems(fresh.items);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      load();
    }
  }

  async function generate() {
    if (!workspaceId || selectedCount === 0) return;
    setRunError(null);
    setPublishResults(null);
    setPublishError(null);
    try {
      const created = await startJob({
        data: { workspaceId, targetKeys: [...selected], model },
      });
      setJob(created.job);
      setItems(created.items);
      setSelected(new Set());
      await drive(created.job.id, created.items);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    }
  }

  async function retry(item: GenerationItemRow) {
    if (!workspaceId || running) return;
    setRunning(true);
    setRunError(null);
    try {
      replaceItem({ ...item, status: "running" });
      const r = await retryItem({ data: { workspaceId, itemId: item.id } });
      replaceItem(r.item);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
      replaceItem(item);
    } finally {
      setRunning(false);
    }
  }

  async function publish() {
    if (!workspaceId || !job) return;
    setPublishing(true);
    setPublishError(null);
    try {
      const r = await publishAll({ data: { workspaceId, jobId: job.id } });
      setPublishResults(r.results);
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : String(e));
    } finally {
      setPublishing(false);
    }
  }

  const doneCount = items.filter((i) => i.status === "done").length;
  const failedCount = items.filter((i) => i.status === "failed").length;
  const openCount = items.filter((i) => i.status === "pending" || i.status === "running").length;
  const jobFinished = !!job && items.length > 0 && openCount === 0 && !running;

  return (
    <div className="space-y-6 pb-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Generate Content</h1>
          <p className="text-sm text-muted-foreground">
            Write draft city pages for every city that has real listings but no page yet.
          </p>
        </div>
        <Button
          onClick={load}
          disabled={loading || !workspaceId || running}
          variant="outline"
          className="gap-2"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Refresh
        </Button>
      </div>

      {loadError && (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{loadError}</p>
      )}

      {overview?.paused && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <PauseCircle className="h-4 w-4 text-amber-500" /> Generation is paused right now
            </CardTitle>
            <CardDescription>
              We have paused page generation for everyone while we look into something. Your
              existing pages are not affected. Please check back shortly.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {overview && !overview.paused && (
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge variant="outline">
            {overview.syncedListings.toLocaleString()} listings synced
          </Badge>
          <Badge variant="outline">{eligible.length} cities ready</Badge>
          <Badge
            variant="outline"
            className={remaining === 0 ? "border-amber-500/40 text-amber-600" : ""}
          >
            {remaining} of {overview.dailyCap} pages left today
          </Badge>
        </div>
      )}

      {overview && overview.syncedListings === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <MapPin className="h-8 w-8 text-muted-foreground" />
            <p className="font-medium">No listings synced yet</p>
            <p className="max-w-md text-sm text-muted-foreground">
              We write pages from your real inventory, so we need your listings first. Connect your
              marketplace and run a sync, then come back here.
            </p>
            <Button asChild>
              <Link to="/app/settings/integrations/sharetribe">Go to Settings → Sharetribe</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {overview && overview.syncedListings > 0 && (
        <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <MapPin className="h-4 w-4" /> Pick the cities to write
              </CardTitle>
              <CardDescription>
                We only generate pages for cities that have at least {overview.minListings}{" "}
                published listings — fewer than that makes a thin page search engines ignore. Cities
                that already have a page are left out.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {eligible.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Every city with enough listings already has a page or a generated draft. Nice.
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => selectUpTo(Math.min(eligible.length, remaining))}
                      disabled={running || remaining === 0}
                    >
                      Select top {Math.min(eligible.length, remaining)}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setSelected(new Set())}
                      disabled={running || selectedCount === 0}
                    >
                      Clear
                    </Button>
                    <span className="text-muted-foreground">{selectedCount} selected</span>
                  </div>
                  <ul className="divide-y rounded-md border">
                    {overview.targets.map((t) => (
                      <TargetRow
                        key={t.targetKey}
                        target={t}
                        checked={selected.has(t.targetKey)}
                        disabled={running || t.alreadyGenerated}
                        onToggle={() => toggle(t.targetKey)}
                      />
                    ))}
                  </ul>
                </>
              )}
            </CardContent>
          </Card>

          <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Writing model</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="model">Model</Label>
                  <Select value={model} onValueChange={setModel} disabled={running}>
                    <SelectTrigger id="model">
                      <SelectValue placeholder="Choose a model" />
                    </SelectTrigger>
                    <SelectContent>
                      {overview.models.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {overview.models.find((m) => m.id === model)?.hint ??
                      "Cost depends on the model you pick."}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Using your own OpenRouter key? Then pages are billed to that key instead.
                  </p>
                </div>

                {overCap && (
                  <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
                    You can generate {remaining} more page{remaining === 1 ? "" : "s"} today. Pick{" "}
                    {remaining} or fewer cities.
                  </p>
                )}

                <Button
                  className="w-full gap-2"
                  size="lg"
                  disabled={!canGenerate}
                  onClick={generate}
                >
                  {running ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {running
                    ? "Writing…"
                    : `Generate ${selectedCount || ""} draft${selectedCount === 1 ? "" : "s"}`}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Every page is saved as a draft first. Nothing goes live until you publish.
                </p>
              </CardContent>
            </Card>
          </aside>
        </div>
      )}

      {runError && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {runError}
        </p>
      )}

      {job && items.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">This batch</CardTitle>
                <CardDescription>
                  {doneCount} written · {failedCount} failed · {openCount} to go
                </CardDescription>
              </div>
              <div className="flex gap-2">
                {running && (
                  <Button variant="outline" size="sm" onClick={() => (stopRef.current = true)}>
                    Stop after this one
                  </Button>
                )}
                {jobFinished && doneCount > 0 && (
                  <Button size="sm" className="gap-2" onClick={publish} disabled={publishing}>
                    {publishing ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Upload className="h-4 w-4" />
                    )}
                    Publish all that pass checks
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {items.map((it) => (
                <ItemRow
                  key={it.id}
                  item={it}
                  busy={running}
                  onRetry={() => retry(it)}
                  publishResult={publishResults?.find((r) => r.itemId === it.id) ?? null}
                />
              ))}
            </ul>
            {publishError && (
              <p className="mt-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {publishError}
              </p>
            )}
            {publishResults && <PublishSummary results={publishResults} />}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TargetRow({
  target,
  checked,
  disabled,
  onToggle,
}: {
  target: TargetListing;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const id = `t-${target.targetKey}`;
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={onToggle} />
      <Label
        htmlFor={id}
        className="flex flex-1 cursor-pointer items-center justify-between gap-3 font-normal"
      >
        <span className="truncate">
          {target.city}
          {target.state ? `, ${target.state}` : ""}
        </span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {target.alreadyGenerated && target.pageId ? (
            <Link
              to="/app/pages/$id/edit"
              params={{ id: target.pageId }}
              className="text-primary hover:underline"
            >
              draft ready
            </Link>
          ) : target.itemStatus === "failed" ? (
            <span className="text-amber-600">last attempt failed</span>
          ) : null}
          <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
            {target.listingCount} listing{target.listingCount === 1 ? "" : "s"}
          </Badge>
        </span>
      </Label>
    </li>
  );
}

function ItemRow({
  item,
  busy,
  onRetry,
  publishResult,
}: {
  item: GenerationItemRow;
  busy: boolean;
  onRetry: () => void;
  publishResult: PublishResult | null;
}) {
  const place = `${item.target.city}${item.target.state ? `, ${item.target.state}` : ""}`;
  return (
    <li className="space-y-1 py-2">
      <div className="flex items-center gap-3">
        <StatusIcon status={item.status} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{place}</div>
          {item.status === "failed" && item.error && (
            <p className="text-xs text-destructive">{item.error}</p>
          )}
          {item.status === "done" && item.slug && (
            <p className="truncate text-xs text-muted-foreground">
              Draft saved ·{" "}
              {item.credits_charged > 0 ? `${item.credits_charged} credits` : "no credits used"}
            </p>
          )}
          {item.status === "pending" && (
            <p className="text-xs text-muted-foreground">Waiting its turn</p>
          )}
          {item.status === "running" && (
            <p className="text-xs text-muted-foreground">Writing from your listings…</p>
          )}
        </div>
        {item.status === "failed" && (
          <Button size="sm" variant="outline" onClick={onRetry} disabled={busy} className="gap-1">
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </Button>
        )}
        {item.status === "done" && item.page_id && (
          <Button asChild size="sm" variant="outline" className="gap-1">
            <Link to="/app/pages/$id/edit" params={{ id: item.page_id }}>
              <Pencil className="h-3.5 w-3.5" /> Edit draft
            </Link>
          </Button>
        )}
      </div>
      {publishResult && (
        <p
          className={`ml-7 text-xs ${
            publishResult.outcome === "published" || publishResult.outcome === "already_published"
              ? "text-emerald-600"
              : publishResult.outcome === "error"
                ? "text-destructive"
                : "text-amber-600"
          }`}
        >
          {publishResult.message}
          {publishResult.outcome === "limit" && (
            <>
              {" "}
              <Link to="/app/billing" className="underline">
                Upgrade plan
              </Link>
            </>
          )}
        </p>
      )}
    </li>
  );
}

function StatusIcon({ status }: { status: GenerationItemRow["status"] }) {
  if (status === "done") return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />;
  if (status === "failed") return <XCircle className="h-4 w-4 shrink-0 text-destructive" />;
  if (status === "running")
    return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />;
  if (status === "skipped") return <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />;
  return <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

function PublishSummary({ results }: { results: PublishResult[] }) {
  const published = results.filter(
    (r) => r.outcome === "published" || r.outcome === "already_published",
  ).length;
  const drafts = results.filter((r) => r.outcome === "draft").length;
  const limited = results.filter((r) => r.outcome === "limit").length;
  return (
    <div className="mt-4 rounded-md border bg-muted/30 p-3 text-sm">
      <p className="font-medium">
        {published} live · {drafts} kept as drafts to fix · {limited} waiting on your plan
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Drafts that were kept back say what to change. Edit them and publish from{" "}
        <Link to="/app/pages" className="underline">
          All pages
        </Link>
        .
      </p>
    </div>
  );
}
