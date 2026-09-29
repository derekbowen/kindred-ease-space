import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Eye,
  Loader2,
  PencilLine,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { userMessage } from "@/lib/user-message";
import { AiModelSelect } from "@/components/ai/AiModelSelect";
import { qualityForRequest } from "@/components/ai/model-choice";
import { TemplateRenderer, type TemplateData } from "@/components/templates/registry";
import { newRequestId, timeAgo, useCurrentWorkspace } from "@/components/pages/use-workspace";
import { pageStatusLabel } from "@/components/pages/page-status";
import {
  archivePage,
  deletePage,
  getPageEditor,
  previewPageEdits,
  publishPage,
  regeneratePageDraft,
  restorePage,
  saveLivePage,
  savePageDraft,
  unpublishPage,
} from "@/lib/pages.functions";

export const Route = createFileRoute("/_authenticated/app/pages/$id/edit")({
  head: () => ({ meta: [{ title: "Edit page — founders.click" }] }),
  component: EditPage,
});

type Fields = {
  title: string;
  h1: string;
  seoTitle: string;
  metaDescription: string;
  slug: string;
  bodyMarkdown: string;
  listingLimit: number;
  noindex: boolean;
};

type Problem = { code: string; message: string; fix?: string };
type Notice =
  | { tone: "ok"; text: string; href?: string | null; detail?: string | null }
  | { tone: "error"; text: string; problems?: Problem[]; step?: string | null };

const STATUS_CLASS: Record<string, string> = {
  draft: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  published: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  archived: "border-border bg-muted text-muted-foreground",
  billing_suspended: "border-orange-500/40 bg-orange-500/10 text-orange-700",
};

function EditPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { workspaceId } = useCurrentWorkspace();
  const editorFn = useServerFn(getPageEditor);
  const saveDraftFn = useServerFn(savePageDraft);
  const saveLiveFn = useServerFn(saveLivePage);
  const publishFn = useServerFn(publishPage);
  const unpublishFn = useServerFn(unpublishPage);
  const archiveFn = useServerFn(archivePage);
  const restoreFn = useServerFn(restorePage);
  const deleteFn = useServerFn(deletePage);
  const regenFn = useServerFn(regeneratePageDraft);
  const previewFn = useServerFn(previewPageEdits);

  const editor = useQuery({
    queryKey: ["page-editor", workspaceId, id],
    queryFn: () => editorFn({ data: { workspaceId: workspaceId!, pageId: id } }),
    enabled: !!workspaceId,
    // While the draft is being written, follow it.
    refetchInterval: (q) => {
      const g = q.state.data?.page.generation;
      return g?.state === "generating" ? 3000 : false;
    },
  });

  const [fields, setFields] = useState<Fields | null>(null);
  const [savedFields, setSavedFields] = useState<Fields | null>(null);
  const [version, setVersion] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [preview, setPreview] = useState<TemplateData | null>(null);
  const [previewStale, setPreviewStale] = useState(false);
  const [mobileTab, setMobileTab] = useState<"edit" | "preview">("edit");
  const [quality, setQuality] = useState("");
  const [showRegen, setShowRegen] = useState(false);
  const [regenBrief, setRegenBrief] = useState("");
  const regenId = useRef(newRequestId());

  // Load the server's version into the form (again after every save/refresh
  // that moved the version, never over unsaved typing).
  const page = editor.data?.page;
  useEffect(() => {
    if (!page) return;
    const f: Fields = {
      title: page.title,
      h1: page.h1,
      seoTitle: page.seoTitle ?? "",
      metaDescription: page.metaDescription ?? "",
      slug: page.slug,
      bodyMarkdown: page.bodyMarkdown,
      listingLimit: page.listingLimit,
      noindex: page.noindex,
    };
    const dirty = fields && savedFields && JSON.stringify(fields) !== JSON.stringify(savedFields);
    if (!fields || !dirty || page.version !== version) {
      setFields(f);
      setSavedFields(f);
      setVersion(page.version);
      setPreview((editor.data?.preview as TemplateData | null) ?? null);
      setPreviewStale(false);
      setRegenBrief(page.generation?.brief ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.version, page?.generation?.state, page?.status]);

  const dirty = useMemo(
    () => !!fields && !!savedFields && JSON.stringify(fields) !== JSON.stringify(savedFields),
    [fields, savedFields],
  );
  useEffect(() => {
    if (dirty) setPreviewStale(true);
  }, [dirty, fields]);

  if (!workspaceId || editor.isLoading || !fields) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        {editor.error ? (
          <span className="text-destructive">
            {userMessage(editor.error, "Couldn't open this page.")}
          </span>
        ) : (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Opening the page…
          </>
        )}
      </div>
    );
  }
  const data = editor.data!;
  const status = data.page.status;
  const generating = data.page.generation?.state === "generating";
  const failed = data.page.generation?.state === "failed";
  const isLive = status === "published";
  const isDraft = status === "draft";
  const readOnly = status === "archived" || status === "billing_suspended" || generating;

  const set = <K extends keyof Fields>(k: K, v: Fields[K]) =>
    setFields((f) => (f ? { ...f, [k]: v } : f));
  const payload = () => ({
    ...fields,
    seoTitle: fields.seoTitle.trim() || null,
    metaDescription: fields.metaDescription.trim() || null,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["page-editor", workspaceId, id] });

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice({
        tone: "error",
        text: userMessage(e, "That didn't work. Nothing was changed. Try again."),
      });
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run("save", async () => {
      const fn = isLive ? saveLiveFn : saveDraftFn;
      const r = await fn({
        data: { workspaceId, pageId: id, expectedVersion: version, fields: payload() },
      });
      if (!r.ok) {
        setNotice({
          tone: "error",
          text: userMessage(r.message, "Not saved. Nothing was changed."),
          problems: r.problems,
        });
        return;
      }
      setVersion(r.version);
      setSavedFields(fields);
      setNotice({
        tone: "ok",
        text: isLive
          ? "Live page updated. Changes reach visitors within a few minutes (pages are cached briefly)."
          : "Draft saved.",
      });
      await refresh();
    });

  const publish = () =>
    run("publish", async () => {
      let v = version;
      if (dirty) {
        const s = await saveDraftFn({
          data: { workspaceId, pageId: id, expectedVersion: version, fields: payload() },
        });
        if (!s.ok) {
          setNotice({
            tone: "error",
            text: userMessage(s.message, "Not saved. Nothing was changed."),
            problems: s.problems,
          });
          return;
        }
        v = s.version;
        setVersion(v);
        setSavedFields(fields);
      }
      const r = await publishFn({ data: { workspaceId, pageId: id, expectedVersion: v } });
      if (!r.ok) {
        setNotice({
          tone: "error",
          text: userMessage(r.message, "Not published. The page stays a draft."),
          problems: r.problems,
          step: r.step ?? null,
        });
        await refresh();
        return;
      }
      setNotice({
        tone: "ok",
        text: r.reachable?.reachable
          ? "Published — the page is live."
          : "Published. We couldn't confirm it loads on your domain yet:",
        href: r.liveUrl ?? null,
        detail: r.reachable?.reachable ? null : (r.reachable?.detail ?? null),
      });
      await refresh();
    });

  const lifecycle = (label: string, fn: typeof unpublishFn, done: string) =>
    run(label, async () => {
      const r = await fn({ data: { workspaceId, pageId: id } });
      if (!r.ok) {
        setNotice({
          tone: "error",
          text: userMessage(r.message, "That didn't work. Nothing was changed."),
        });
        return;
      }
      if (r.status === "deleted") {
        navigate({ to: "/app/pages" });
        return;
      }
      setNotice({ tone: "ok", text: done });
      await refresh();
    });

  const regenerate = () =>
    run("regenerate", async () => {
      const send = () =>
        regenFn({
          data: {
            workspaceId,
            requestId: regenId.current,
            pageId: id,
            brief: regenBrief.trim(),
            quality: qualityForRequest(quality),
          },
        });
      let r: Awaited<ReturnType<typeof send>>;
      try {
        r = await send();
      } catch (e) {
        // A lost response keeps the key (a retry returns that run's result);
        // show the draft as it is now (being written, or interrupted).
        await refresh();
        throw e;
      }
      regenId.current = newRequestId();
      // That key belonged to an earlier click whose answer was lost and whose
      // run then ended: the server only replayed it. The owner asked for a new
      // draft now, so ask once more under the fresh key.
      if (r.outcome === "failed" && r.replayed) {
        r = await send();
        regenId.current = newRequestId();
      }
      setShowRegen(false);
      if (r.outcome === "failed")
        setNotice({
          tone: "error",
          text: `${userMessage(r.error, "The draft couldn't be rewritten.")} Your previous text was kept.`,
        });
      else setNotice({ tone: "ok", text: "New draft written. Review it before publishing." });
      await refresh();
    });

  const refreshPreview = () =>
    run("preview", async () => {
      const p = await previewFn({ data: { workspaceId, pageId: id, fields: payload() } });
      setPreview(p as TemplateData);
      setPreviewStale(false);
      setMobileTab("preview");
    });

  const badge = { cls: STATUS_CLASS[status] ?? "" };
  const check = data.check;

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to="/app/pages">
            <ArrowLeft className="mr-1 h-4 w-4" /> Pages
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="outline">{data.page.templateName}</Badge>
          <Badge variant="outline" className={badge.cls}>
            {generating ? "Being written" : pageStatusLabel(status)}
          </Badge>
          {data.page.targetLabel && (
            <span className="text-muted-foreground">{data.page.targetLabel}</span>
          )}
          {data.liveUrl && (
            <a
              href={data.liveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline"
            >
              View live <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </div>

      <h1 className="text-xl font-semibold tracking-tight">
        {fields.h1 || fields.title || "Untitled page"}
      </h1>

      {generating && (
        <Card>
          <CardContent className="flex items-center gap-3 p-4 text-sm" aria-live="polite">
            <Loader2 className="h-4 w-4 animate-spin" />
            Writing this draft from your listing data — started{" "}
            {timeAgo(data.page.generation?.started_at)}. This page updates by itself when it's
            ready.
          </CardContent>
        </Card>
      )}
      {failed && !generating && (
        <Card className="border-destructive/40">
          <CardContent className="space-y-2 p-4 text-sm">
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              The last attempt to write this draft failed:{" "}
              {userMessage(data.page.generation?.error, "the writer didn't finish.")}
            </p>
            <p className="text-muted-foreground">
              Your title, listings, notes and any earlier text were kept.
            </p>
            {isDraft && (
              <Button size="sm" onClick={() => setShowRegen(true)}>
                <RefreshCw className="mr-1 h-3.5 w-3.5" /> Try again
              </Button>
            )}
          </CardContent>
        </Card>
      )}
      {data.page.legacyFilter && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          This page was made before places were matched exactly. It stays as it is (live pages keep
          working), but it can't be changed or republished here. To replace it, archive it, then
          create a new page for this place from Opportunities.
        </p>
      )}

      {notice && <NoticeBox notice={notice} />}

      <div className="flex gap-1 lg:hidden">
        <Button
          size="sm"
          variant={mobileTab === "edit" ? "default" : "outline"}
          onClick={() => setMobileTab("edit")}
        >
          <PencilLine className="mr-1 h-3.5 w-3.5" /> Edit
        </Button>
        <Button
          size="sm"
          variant={mobileTab === "preview" ? "default" : "outline"}
          onClick={() => setMobileTab("preview")}
        >
          <Eye className="mr-1 h-3.5 w-3.5" /> Preview
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className={cn("space-y-4", mobileTab !== "edit" && "hidden lg:block")}>
          <Card>
            <CardContent className="space-y-4 p-4">
              <Field
                label="Page title"
                hint="Used in links and as the search title when that is empty."
              >
                <Input
                  value={fields.title}
                  maxLength={140}
                  disabled={readOnly}
                  onChange={(e) => set("title", e.target.value)}
                />
              </Field>
              <Field label="Heading (H1)">
                <Input
                  value={fields.h1}
                  maxLength={200}
                  disabled={readOnly}
                  onChange={(e) => set("h1", e.target.value)}
                />
              </Field>
              <Field
                label="Search title"
                hint={`${fields.seoTitle.length}/60 — what search results show.`}
              >
                <Input
                  value={fields.seoTitle}
                  maxLength={70}
                  disabled={readOnly}
                  onChange={(e) => set("seoTitle", e.target.value)}
                />
              </Field>
              <Field
                label="Search description"
                hint={`${fields.metaDescription.length} characters — aim for 70–155.`}
              >
                <Textarea
                  rows={2}
                  value={fields.metaDescription}
                  maxLength={320}
                  disabled={readOnly}
                  onChange={(e) => set("metaDescription", e.target.value)}
                />
              </Field>
              <Field
                label="Address"
                hint={`Renders at ${data.domain.ready ? `${data.domain.baseUrl}/` : "/a/"}${fields.slug}${isLive ? " — a live page's address can't change." : ""}`}
              >
                <div className="flex items-center rounded-md border bg-muted/40 pl-2 text-sm text-muted-foreground">
                  /a/
                  <Input
                    className="border-0 bg-transparent pl-0.5 shadow-none focus-visible:ring-0"
                    value={fields.slug}
                    maxLength={80}
                    disabled={readOnly || isLive}
                    onChange={(e) =>
                      set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))
                    }
                  />
                </div>
              </Field>
              <Field
                label="Page text (Markdown)"
                hint={
                  data.page.kind === "resource_article"
                    ? "The article. Use ## for sections."
                    : "Shown below the listings. Use ## for sections."
                }
              >
                <Textarea
                  rows={16}
                  className="font-mono text-xs"
                  value={fields.bodyMarkdown}
                  disabled={readOnly}
                  onChange={(e) => set("bodyMarkdown", e.target.value)}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                {data.page.kind !== "resource_article" && (
                  <Field label="Listings shown" hint="1–60.">
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      value={fields.listingLimit}
                      disabled={readOnly}
                      onChange={(e) =>
                        set("listingLimit", Math.max(1, Math.min(60, Number(e.target.value) || 1)))
                      }
                    />
                  </Field>
                )}
                <label className="flex items-start gap-2 pt-6 text-sm">
                  <input
                    type="checkbox"
                    checked={fields.noindex}
                    disabled={readOnly}
                    onChange={(e) => set("noindex", e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    Hide from search engines
                    <span className="block text-xs text-muted-foreground">
                      Adds noindex and leaves the page out of the sitemap.
                    </span>
                  </span>
                </label>
              </div>
            </CardContent>
          </Card>

          <ChecksCard check={check} showListings={data.page.kind !== "resource_article"} />

          <DomainCard domain={data.domain} />

          <Card>
            <CardContent className="flex flex-wrap gap-2 p-4">
              {isDraft && (
                <>
                  <Button onClick={save} disabled={!!busy || !dirty || readOnly}>
                    {busy === "save" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Save
                    draft
                  </Button>
                  <Button
                    onClick={publish}
                    disabled={!!busy || readOnly}
                    variant="default"
                    className="bg-emerald-700 hover:bg-emerald-800"
                  >
                    {busy === "publish" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}{" "}
                    {dirty ? "Save and publish" : "Publish"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setShowRegen((v) => !v)}
                    disabled={!!busy || generating}
                  >
                    <RefreshCw className="mr-1 h-3.5 w-3.5" /> Rewrite draft
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      lifecycle("archive", archiveFn, "Archived. It no longer counts as coverage.")
                    }
                    disabled={!!busy || generating}
                  >
                    Archive
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-destructive"
                    disabled={!!busy || generating}
                    onClick={() => {
                      if (window.confirm("Delete this draft? This can't be undone."))
                        void lifecycle("delete", deleteFn, "Deleted.");
                    }}
                  >
                    Delete draft
                  </Button>
                </>
              )}
              {isLive && (
                <>
                  <Button onClick={save} disabled={!!busy || !dirty}>
                    {busy === "save" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Update
                    live page
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      lifecycle(
                        "unpublish",
                        unpublishFn,
                        "Unpublished. It's a draft again and no longer on your domain.",
                      )
                    }
                    disabled={!!busy}
                  >
                    Unpublish
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => lifecycle("archive", archiveFn, "Archived and taken offline.")}
                    disabled={!!busy}
                  >
                    Archive
                  </Button>
                </>
              )}
              {status === "archived" && (
                <>
                  <Button
                    onClick={() => lifecycle("restore", restoreFn, "Restored as a draft.")}
                    disabled={!!busy}
                  >
                    Restore as draft
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-destructive"
                    disabled={!!busy}
                    onClick={() => {
                      if (window.confirm("Delete this page for good? This can't be undone."))
                        void lifecycle("delete", deleteFn, "Deleted.");
                    }}
                  >
                    Delete
                  </Button>
                </>
              )}
              {status === "billing_suspended" && (
                <p className="text-sm text-muted-foreground">
                  This page is paused because your plan's page limit went down. It comes back when
                  capacity allows — see Billing.
                </p>
              )}
              {dirty && (
                <span className="self-center text-xs text-amber-700 dark:text-amber-300">
                  Unsaved changes
                </span>
              )}
            </CardContent>
          </Card>

          {showRegen && isDraft && (
            <Card>
              <CardContent className="space-y-3 p-4">
                <p className="text-sm font-medium">Rewrite this draft</p>
                <p className="text-sm text-muted-foreground">
                  The writer starts again from your current listing data. Your present text is
                  replaced only if the new draft is written successfully.
                </p>
                <Field label="Notes for the writer">
                  <Textarea
                    rows={3}
                    maxLength={2000}
                    value={regenBrief}
                    onChange={(e) => setRegenBrief(e.target.value)}
                  />
                </Field>
                <Field label="Writing quality">
                  <AiModelSelect
                    workspaceId={workspaceId}
                    value={quality}
                    onChange={setQuality}
                    id="regen-quality"
                  />
                </Field>
                <div className="flex gap-2">
                  <Button onClick={regenerate} disabled={!!busy || !quality}>
                    {busy === "regenerate" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}{" "}
                    Rewrite
                  </Button>
                  <Button variant="ghost" onClick={() => setShowRegen(false)}>
                    Cancel
                  </Button>
                </div>
                {busy === "regenerate" && (
                  <p className="text-xs text-muted-foreground" aria-live="polite">
                    Writing — usually 20–60 seconds. Your current text stays until the new one is
                    ready.
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <div className={cn("space-y-2", mobileTab !== "preview" && "hidden lg:block")}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">
              Preview — the real template with your real listings
            </p>
            <Button size="sm" variant="outline" onClick={refreshPreview} disabled={!!busy}>
              {busy === "preview" ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Eye className="mr-1 h-3.5 w-3.5" />
              )}
              {previewStale ? "Preview changes" : "Refresh"}
            </Button>
          </div>
          {previewStale && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              The preview shows the last saved version.
            </p>
          )}
          <div className="max-h-[80vh] overflow-y-auto rounded-lg border bg-white">
            {preview ? (
              <TemplateRenderer {...preview} basePath={null} />
            ) : (
              <p className="p-6 text-sm text-muted-foreground">
                No preview available for this page.
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Draft previews are private: they are never in your sitemap and never served on your
            domain.
          </p>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ChecksCard({
  check,
  showListings,
}: {
  check: { ok: boolean; problems: Problem[]; warnings: Problem[]; listingCount: number } | null;
  /** A Resource Article shows no listing strip: its count would only confuse. */
  showListings: boolean;
}) {
  if (!check) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          The publish checks couldn't run just now. They run again when you publish.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="space-y-2 p-4 text-sm">
        <p className="font-medium">
          {check.ok ? (
            <span className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-4 w-4" /> Ready to publish (as last saved)
            </span>
          ) : (
            "Before this can be published"
          )}
        </p>
        {showListings && (
          <p className="text-muted-foreground">
            {check.listingCount} published listings match this page.
          </p>
        )}
        {check.problems.map((p) => (
          <p key={p.code} className="flex items-start gap-2">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <span>
              {userMessage(p.message, "This needs attention before publishing.")}{" "}
              {p.fix && <span className="text-muted-foreground">{p.fix}</span>}
            </span>
          </p>
        ))}
        {check.warnings.map((p) => (
          <p key={p.code} className="flex items-start gap-2 text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <span>
              {userMessage(p.message, "This needs attention before publishing.")} {p.fix}
            </span>
          </p>
        ))}
      </CardContent>
    </Card>
  );
}

function DomainCard({
  domain,
}: {
  domain: { ready: boolean; hostname: string | null; step?: string };
}) {
  if (domain.ready) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 className="h-4 w-4 text-emerald-600" /> Publishes to {domain.hostname}
      </p>
    );
  }
  return (
    <Card className="border-amber-500/40">
      <CardContent className="space-y-1 p-4 text-sm">
        <p className="font-medium">Your domain isn't serving pages yet</p>
        <p className="text-muted-foreground">{domain.step}</p>
        <Button asChild size="sm" variant="outline" className="mt-1">
          <Link to="/app/settings/domains">Open Domains</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function NoticeBox({ notice }: { notice: Notice }) {
  if (notice.tone === "ok") {
    return (
      <div
        className="space-y-1 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm"
        aria-live="polite"
      >
        <p className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" /> {notice.text}
        </p>
        {notice.href && (
          <a
            href={notice.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline"
          >
            {notice.href} <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
        {notice.detail && <p className="text-muted-foreground">{notice.detail}</p>}
      </div>
    );
  }
  return (
    <div
      className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
      role="alert"
    >
      <p className="font-medium">{notice.text}</p>
      {notice.problems?.map((p) => (
        <p key={p.code} className="flex items-start gap-2">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <span>
            {userMessage(p.message, "This needs attention before publishing.")}{" "}
            {p.fix && <span className="text-muted-foreground">{p.fix}</span>}
          </span>
        </p>
      ))}
      {notice.step && <p className="text-muted-foreground">Next step: {notice.step}</p>}
    </div>
  );
}
