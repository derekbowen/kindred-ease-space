import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Circle,
  Loader2,
  MapPin,
  Search,
  Tag,
  XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { userMessage } from "@/lib/user-message";
import { AiModelSelect } from "@/components/ai/AiModelSelect";
import { qualityForRequest } from "@/components/ai/model-choice";
import { newRequestId, useCurrentWorkspace } from "@/components/pages/use-workspace";
import {
  createPageDraft,
  getBuilderSetup,
  getPageDraftStatus,
  reviewTarget,
  type BuilderTarget,
  type BuilderTemplate,
} from "@/lib/pages.functions";
import type { PageKind } from "@/lib/coverage/target";
import { TITLE_MIN } from "@/lib/seo/page-contract";

const searchSchema = z.object({
  target: z.string().max(400).optional(),
  kind: z.enum(["city_hub", "category_page", "resource_article"]).optional(),
});

export const Route = createFileRoute("/_authenticated/app/pages/new")({
  head: () => ({ meta: [{ title: "New page — founders.click" }] }),
  validateSearch: searchSchema,
  component: NewPage,
});

const KIND_ICON: Record<PageKind, typeof MapPin> = {
  city_hub: MapPin,
  category_page: Tag,
  resource_article: BookOpen,
};

/** A whole-marketplace filter — a Resource Article's related listings. */
const ARTICLE_FILTER = {
  v: 2 as const,
  scope: [],
  countryKey: null,
  regionKey: null,
  cityKey: null,
  categoryKey: null,
  country: null,
  region: null,
  city: null,
  category: null,
  limit: 6,
  sort: "newest" as const,
};

type Phase =
  | { name: "idle" }
  | { name: "writing"; startedAt: number; claimed: boolean }
  | { name: "failed"; message: string; pageId: string | null }
  | { name: "exists"; pageId: string; title: string | null; status: string };

function NewPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { workspaceId } = useCurrentWorkspace();
  const setupFn = useServerFn(getBuilderSetup);
  const reviewFn = useServerFn(reviewTarget);
  const createFn = useServerFn(createPageDraft);
  const statusFn = useServerFn(getPageDraftStatus);

  const setup = useQuery({
    queryKey: ["builder-setup", workspaceId],
    queryFn: () => setupFn({ data: { workspaceId: workspaceId! } }),
    enabled: !!workspaceId,
  });

  const [kind, setKindState] = useState<PageKind | null>(search.kind ?? null);
  const [targetKey, setTargetKeyState] = useState<string | null>(search.target ?? null);
  // The chosen template and target live in the URL too (one replace per
  // choice), so a reload or a shared link comes back to the same selection.
  const choose = (next: { kind: PageKind | null; target: string | null }) => {
    setKindState(next.kind);
    setTargetKeyState(next.target);
    void navigate({
      to: "/app/pages/new",
      search: { kind: next.kind ?? undefined, target: next.target ?? undefined },
      replace: true,
    });
  };
  const setTargetKey = (t: string | null) => choose({ kind, target: t });
  const [pickerQuery, setPickerQuery] = useState("");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [brief, setBrief] = useState("");
  const [quality, setQuality] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [elapsed, setElapsed] = useState(0);
  // One key per generation: kept across a lost response so a resubmit returns
  // the draft that request already made; rotated once an answer arrives.
  const requestIdRef = useRef(newRequestId());

  const target: BuilderTarget | null = useMemo(
    () => setup.data?.targets.find((t) => t.targetKey === targetKey) ?? null,
    [setup.data, targetKey],
  );
  const filter = kind === "resource_article" ? ARTICLE_FILTER : (target?.filter ?? null);

  const review = useQuery({
    queryKey: [
      "builder-review",
      workspaceId,
      kind,
      kind === "resource_article" ? "article" : targetKey,
    ],
    queryFn: () => reviewFn({ data: { workspaceId: workspaceId!, kind: kind!, filter: filter! } }),
    enabled: !!workspaceId && !!kind && !!filter,
  });

  // Prefill the suggested title and address once per target.
  const prefilled = useRef<string | null>(null);
  useEffect(() => {
    const key = `${kind}:${targetKey}`;
    if (!review.data || prefilled.current === key) return;
    prefilled.current = key;
    if (review.data.suggestion.title) setTitle(review.data.suggestion.title);
    setSlug(review.data.suggestion.slug);
  }, [review.data, kind, targetKey]);

  // Real progress: elapsed time, and whether the server has claimed the draft.
  useEffect(() => {
    if (phase.name !== "writing") return;
    const tick = setInterval(
      () => setElapsed(Math.round((Date.now() - phase.startedAt) / 1000)),
      1000,
    );
    const poll = setInterval(async () => {
      if (!workspaceId) return;
      try {
        const st = await statusFn({ data: { workspaceId, requestId: requestIdRef.current } });
        if (st && phase.name === "writing" && !phase.claimed) setPhase({ ...phase, claimed: true });
      } catch {
        /* the main request reports errors */
      }
    }, 3000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [phase, workspaceId, statusFn]);

  const templates = setup.data?.templates ?? [];
  const chosenTemplate = templates.find((t) => t.kind === kind) ?? null;
  const targetsOfKind = (setup.data?.targets ?? []).filter((t) => t.kind === kind);
  const shownTargets = targetsOfKind
    .filter((t) =>
      pickerQuery.trim() ? t.label.toLowerCase().includes(pickerQuery.trim().toLowerCase()) : true,
    )
    .slice(0, 60);
  const problems = review.data?.problems ?? [];
  const existing = review.data?.existing ?? null;
  const canWrite =
    !!workspaceId &&
    !!kind &&
    !!filter &&
    !!quality &&
    title.trim().length >= TITLE_MIN &&
    problems.length === 0 &&
    !existing &&
    !!chosenTemplate?.available &&
    phase.name !== "writing" &&
    !review.isLoading;

  async function write() {
    if (!canWrite || !kind || !filter) return;
    setPhase({ name: "writing", startedAt: Date.now(), claimed: false });
    setElapsed(0);
    try {
      const r = await createFn({
        data: {
          workspaceId: workspaceId!,
          requestId: requestIdRef.current,
          kind,
          filter,
          title: title.trim(),
          slug: slug.trim() || undefined,
          description: description.trim(),
          brief: brief.trim(),
          quality: qualityForRequest(quality),
        },
      });
      requestIdRef.current = newRequestId();
      if (r.outcome === "ready" || r.outcome === "generating") {
        navigate({ to: "/app/pages/$id/edit", params: { id: r.page.id } });
        return;
      }
      if (r.outcome === "exists") {
        setPhase({ name: "exists", pageId: r.page.id, title: r.page.title, status: r.page.status });
        return;
      }
      setPhase({
        name: "failed",
        message: userMessage(
          r.error,
          "The draft couldn't be written. Your draft was kept — open it to try again.",
        ),
        pageId: r.page.id,
      });
    } catch (e) {
      const message = userMessage(e, "The draft couldn't be written. Try again.");
      // A key buys one provider call. An answer from the server (even a
      // refusal) finishes it; a lost response or "still being generated"
      // keeps it, so a retry returns that request's draft instead of a second.
      if (!(e instanceof TypeError) && !/still being generated/i.test(message)) {
        requestIdRef.current = newRequestId();
      }
      setPhase({ name: "failed", message, pageId: null });
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to="/app/pages">
            <ArrowLeft className="mr-1 h-4 w-4" /> Pages
          </Link>
        </Button>
      </div>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New page</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick what the page is about, check the listings it will show, then write a draft. Nothing
          goes live until you publish it.
        </p>
      </div>

      {setup.isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading templates and your listings…
        </p>
      )}
      {setup.error && (
        <ErrorCard
          message={userMessage(setup.error, "Couldn't load the builder. Try again in a minute.")}
        />
      )}

      {setup.data && (
        <>
          <Step n={1} title="Choose a template" done={!!kind}>
            <div className="grid gap-3 sm:grid-cols-3">
              {templates.map((t) => (
                <TemplateCard
                  key={t.kind}
                  t={t}
                  selected={kind === t.kind}
                  onSelect={() => {
                    choose({ kind: t.kind, target: t.kind !== kind ? null : targetKey });
                    setPhase({ name: "idle" });
                  }}
                />
              ))}
            </div>
          </Step>

          {kind && kind !== "resource_article" && (
            <Step
              n={2}
              title={kind === "city_hub" ? "Choose the place" : "Choose the category"}
              done={!!target}
            >
              {target ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                  <div>
                    <p className="font-medium">{target.label}</p>
                    <p className="text-sm text-muted-foreground">
                      {target.listingCount} published listings
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setTargetKey(null)}>
                    Change
                  </Button>
                </div>
              ) : targetsOfKind.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {kind === "city_hub"
                    ? "None of your published listings has a city yet. Add locations to listings in Sharetribe, sync, and they appear here."
                    : "None of your published listings has a category yet."}
                </p>
              ) : (
                <div className="space-y-2">
                  <div className="relative">
                    <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder={kind === "city_hub" ? "Search places" : "Search categories"}
                      className="pl-7"
                      value={pickerQuery}
                      onChange={(e) => setPickerQuery(e.target.value)}
                    />
                  </div>
                  <ul className="max-h-80 divide-y overflow-y-auto rounded-md border">
                    {shownTargets.map((t) => {
                      const hasPage =
                        t.state === "draft" || t.state === "published" || t.state === "suspended";
                      const tooFew = t.state === "insufficient";
                      return (
                        <li
                          key={t.targetKey}
                          className="flex items-center justify-between gap-2 p-2.5 text-sm"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-medium">{t.label}</p>
                            <p className="text-xs text-muted-foreground">
                              {t.listingCount} listing{t.listingCount === 1 ? "" : "s"}
                              {hasPage
                                ? " · already has a page"
                                : tooFew
                                  ? " · not enough listings"
                                  : ""}
                            </p>
                          </div>
                          {hasPage && t.pageId ? (
                            <Button asChild size="sm" variant="outline">
                              <Link to="/app/pages/$id/edit" params={{ id: t.pageId }}>
                                Open page
                              </Link>
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={tooFew}
                              onClick={() => setTargetKey(t.targetKey)}
                            >
                              Choose
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {targetsOfKind.length > shownTargets.length && (
                    <p className="text-xs text-muted-foreground">
                      Showing {shownTargets.length} of {targetsOfKind.length}. Search to narrow the
                      list.
                    </p>
                  )}
                </div>
              )}
            </Step>
          )}

          {kind && filter && (
            <Step
              n={kind === "resource_article" ? 2 : 3}
              title="Review the listings and write the brief"
              done={false}
            >
              {review.isLoading && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Counting matching listings…
                </p>
              )}
              {review.error && (
                <ErrorCard
                  message={userMessage(review.error, "Couldn't check these listings. Try again.")}
                />
              )}
              {review.data && (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">
                        {kind === "resource_article"
                          ? "Published listings in your marketplace"
                          : "Published listings on this page"}
                      </p>
                      <p className="text-2xl font-semibold tabular-nums">
                        {review.data.listingCount}
                      </p>
                      {review.data.prices.length > 0 && (
                        <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                          {review.data.prices.map((p) => (
                            <li key={p}>{p}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">
                        {kind === "resource_article"
                          ? "Listings the guide is written from (the article links to your marketplace, not to these)"
                          : "Listings the page will show"}
                      </p>
                      {review.data.sample.length === 0 ? (
                        <p className="mt-2 text-sm text-muted-foreground">No listings match.</p>
                      ) : (
                        <ul className="mt-1 space-y-1 text-sm">
                          {review.data.sample.map((l) => (
                            <li key={l.id} className="flex justify-between gap-2">
                              <span className="truncate">{l.title}</span>
                              <span className="shrink-0 text-xs text-muted-foreground">
                                {l.price ?? l.location ?? ""}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>

                  {existing && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                      <span>
                        A page for this already exists (
                        {existing.status === "published" ? "live" : existing.status}):{" "}
                        <span className="font-medium">{existing.title}</span>. Open it instead of
                        writing a second one.
                      </span>
                      <Button asChild size="sm">
                        <Link to="/app/pages/$id/edit" params={{ id: existing.id }}>
                          Open page
                        </Link>
                      </Button>
                    </div>
                  )}
                  {problems.length > 0 && (
                    <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                      {problems.map((p) => (
                        <p key={p} className="flex items-start gap-2">
                          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" /> {p}
                        </p>
                      ))}
                    </div>
                  )}

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label htmlFor="title">Page title (the heading visitors see)</Label>
                      <Input
                        id="title"
                        value={title}
                        maxLength={140}
                        placeholder={
                          kind === "resource_article"
                            ? "How to choose a private pool for a party"
                            : ""
                        }
                        onChange={(e) => setTitle(e.target.value)}
                      />
                      {title.trim().length > 0 && title.trim().length < TITLE_MIN && (
                        <p className="text-xs text-muted-foreground">
                          At least {TITLE_MIN} characters: say what's offered and where.
                        </p>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="slug">Address</Label>
                      <div className="flex items-center rounded-md border bg-muted/40 pl-2 text-sm text-muted-foreground">
                        /a/
                        <Input
                          id="slug"
                          className="border-0 bg-transparent pl-0.5 shadow-none focus-visible:ring-0"
                          value={slug}
                          maxLength={80}
                          placeholder="made from the title"
                          onChange={(e) =>
                            setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))
                          }
                        />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="quality">Writing quality</Label>
                      <AiModelSelect
                        workspaceId={workspaceId}
                        value={quality}
                        onChange={setQuality}
                        id="quality"
                      />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label htmlFor="description">One-line summary (optional)</Label>
                      <Input
                        id="description"
                        value={description}
                        maxLength={300}
                        onChange={(e) => setDescription(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label htmlFor="brief">Notes for the writer (optional)</Label>
                      <Textarea
                        id="brief"
                        rows={4}
                        maxLength={2000}
                        value={brief}
                        placeholder="Facts only you know: what makes these listings useful, who books them, what to mention or avoid. The writer uses only these notes and your listing data — it won't invent prices, reviews or availability."
                        onChange={(e) => setBrief(e.target.value)}
                      />
                    </div>
                  </div>

                  <WritePanel phase={phase} elapsed={elapsed} canWrite={canWrite} onWrite={write} />
                </div>
              )}
            </Step>
          )}
        </>
      )}
    </div>
  );
}

function WritePanel({
  phase,
  elapsed,
  canWrite,
  onWrite,
}: {
  phase: Phase;
  elapsed: number;
  canWrite: boolean;
  onWrite: () => void;
}) {
  if (phase.name === "writing") {
    return (
      <div className="space-y-2 rounded-md border p-4 text-sm" aria-live="polite">
        <p className="font-medium">Writing your draft · {elapsed}s</p>
        <ProgressLine done label="Checked the template, the filter and your listings" />
        <ProgressLine
          done={phase.claimed}
          active={!phase.claimed}
          label="Saved an empty draft so nothing can be lost"
        />
        <ProgressLine
          active={phase.claimed}
          label="Writing from your listing data (usually 20–60 seconds)"
        />
        <p className="text-xs text-muted-foreground">
          You can leave this page: the draft appears under Pages when it's ready.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {phase.name === "failed" && (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />{" "}
            {userMessage(phase.message, "The draft couldn't be written.")}
          </p>
          {phase.pageId && (
            <p>
              Your draft (title, listings and notes) was kept.{" "}
              <Link
                to="/app/pages/$id/edit"
                params={{ id: phase.pageId }}
                className="font-medium underline"
              >
                Open the draft
              </Link>{" "}
              to try again from there.
            </p>
          )}
        </div>
      )}
      {phase.name === "exists" && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <span>
            This place or category already has a page (
            {phase.status === "published" ? "live" : phase.status}): {phase.title}. Nothing new was
            written.
          </span>
          <Button asChild size="sm">
            <Link to="/app/pages/$id/edit" params={{ id: phase.pageId }}>
              Open page
            </Link>
          </Button>
        </div>
      )}
      <Button onClick={onWrite} disabled={!canWrite} className="w-full sm:w-auto">
        Write draft
      </Button>
      <p className="text-xs text-muted-foreground">
        Writing a draft uses your AI allowance. The draft is saved as soon as it starts; you edit
        and preview it before anything is published.
      </p>
    </div>
  );
}

function ProgressLine({
  label,
  done,
  active,
}: {
  label: string;
  done?: boolean;
  active?: boolean;
}) {
  return (
    <p className={cn("flex items-center gap-2", !done && !active && "text-muted-foreground")}>
      {done ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
      ) : active ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Circle className="h-4 w-4" />
      )}
      {label}
    </p>
  );
}

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <span
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full border text-xs",
              done && "border-emerald-600 bg-emerald-600 text-white",
            )}
          >
            {done ? "✓" : n}
          </span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function TemplateCard({
  t,
  selected,
  onSelect,
}: {
  t: BuilderTemplate;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = KIND_ICON[t.kind];
  return (
    <button
      type="button"
      disabled={!t.available}
      onClick={onSelect}
      className={cn(
        "flex h-full flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors",
        selected ? "border-foreground ring-1 ring-foreground" : "hover:bg-muted/60",
        !t.available && "cursor-not-allowed opacity-50",
      )}
    >
      <div className="flex w-full items-center justify-between">
        <span className="flex items-center gap-2 font-medium">
          <Icon className="h-4 w-4" /> {t.name}
        </span>
        {!t.available && <Badge variant="outline">Not available</Badge>}
      </div>
      <p className="text-sm text-muted-foreground">{t.summary}</p>
      <TemplateSketch kind={t.kind} />
    </button>
  );
}

/** A small, honest sketch of each template's layout (sections in order). */
function TemplateSketch({ kind }: { kind: PageKind }) {
  const bar = "rounded-sm bg-muted-foreground/25";
  return (
    <div className="w-full space-y-1 rounded-md border bg-background p-2" aria-hidden="true">
      <div className={cn(bar, "h-2.5 w-3/4")} />
      {kind === "resource_article" ? (
        <>
          <div className={cn(bar, "h-1.5 w-full")} />
          <div className={cn(bar, "h-1.5 w-full")} />
          <div className={cn(bar, "h-1.5 w-5/6")} />
          <div className="grid grid-cols-3 gap-1 pt-1">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-4 rounded-sm border border-dashed border-muted-foreground/40"
              />
            ))}
          </div>
        </>
      ) : (
        <>
          <div className={cn(bar, "h-1.5 w-2/3")} />
          <div className="grid grid-cols-3 gap-1 pt-1">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-5 rounded-sm border border-muted-foreground/40" />
            ))}
          </div>
          <div className={cn(bar, "h-1.5 w-full")} />
          <div className={cn(bar, "h-1.5 w-4/5")} />
        </>
      )}
    </div>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <Card className="border-destructive/40">
      <CardContent className="flex items-start gap-3 p-4 text-sm">
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <p>{message}</p>
      </CardContent>
    </Card>
  );
}
