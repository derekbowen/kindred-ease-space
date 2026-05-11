import * as React from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import {
  nextPendingPage,
  scrapeContentPage,
  scrapeProgress,
} from "@/server/content-scrape.functions";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";

export const Route = createFileRoute("/admin/content-migration")({
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth", search: { redirect: "/admin/content-migration", mode: "signin" } });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  component: AdminContentMigration,
});

function AdminContentMigration() {
  const [templateType, setTemplateType] = React.useState("host_acq_city");
  const [next, setNext] = React.useState<any>(null);
  const [scraped, setScraped] = React.useState<any>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<{
    pending: number;
    scraped: number;
    total: number;
  } | null>(null);
  const [autoRun, setAutoRun] = React.useState(false);

  const loadProgress = React.useCallback(async () => {
    try {
      const p = await scrapeProgress({ data: { template_type: templateType } });
      setProgress(p);
    } catch {
      /* ignore */
    }
  }, [templateType]);

  const loadNext = React.useCallback(async () => {
    setError(null);
    setScraped(null);
    setBusy(true);
    try {
      const res = await nextPendingPage({
        data: { template_type: templateType },
      });
      setNext(res.page);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [templateType]);

  React.useEffect(() => {
    void loadNext();
    void loadProgress();
  }, [loadNext, loadProgress]);

  // Periodic progress refresh — poll every 3s while a scrape run is active
  // (auto-running or a single scrape in flight) so the bar stays accurate
  // even if individual scrapes take a while.
  React.useEffect(() => {
    if (!autoRun && !busy) return;
    const id = setInterval(() => {
      void loadProgress();
    }, 3000);
    return () => clearInterval(id);
  }, [autoRun, busy, loadProgress]);

  const runScrape = React.useCallback(async () => {
    if (!next?.id) return;
    setError(null);
    setBusy(true);
    try {
      const res = await scrapeContentPage({ data: { id: next.id } });
      setScraped(res.page);
      void loadProgress();
      try {
        const nextRes = await nextPendingPage({
          data: { template_type: templateType },
        });
        setNext(nextRes.page);
      } catch {
        /* ignore — user can click Reload next */
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setAutoRun(false);
    } finally {
      setBusy(false);
    }
  }, [next?.id, templateType, loadProgress]);

  // Auto-run loop: when enabled, keep scraping until no pending rows remain.
  React.useEffect(() => {
    if (!autoRun || busy) return;
    if (!next?.id) {
      setAutoRun(false);
      return;
    }
    void runScrape();
  }, [autoRun, busy, next?.id, runScrape]);

  return (
    <AdminLayout>
        <h1 className="text-3xl font-bold">Content migration scraper</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Pulls one pending row at a time via Firecrawl so you can review
          before bulk-running.
        </p>

        <div className="mt-6 flex items-center gap-3">
          <label className="text-sm font-medium">template_type:</label>
          <select
            value={templateType}
            onChange={(e) => setTemplateType(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-sm"
          >
            <option value="host_acq_city">host_acq_city</option>
            
            <option value="event_guide">event_guide</option>
            <option value="resource">resource</option>
          </select>
          <button
            onClick={loadNext}
            disabled={busy}
            className="rounded-full border border-border px-4 py-1.5 text-sm"
          >
            Reload next
          </button>
          <button
            onClick={() => setAutoRun((v) => !v)}
            disabled={!next?.id && !autoRun}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold ${
              autoRun
                ? "bg-destructive text-destructive-foreground"
                : "bg-primary text-primary-foreground"
            }`}
          >
            {autoRun ? "Stop auto-run" : "Auto-run all"}
          </button>
        </div>

        {progress && (
          <div className="mt-6">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">
                Progress: {progress.scraped} / {progress.total}
              </span>
              <span className="text-muted-foreground">
                {progress.pending} pending
                {progress.total > 0 &&
                  ` · ${Math.round((progress.scraped / progress.total) * 100)}%`}
              </span>
            </div>
            <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full bg-primary transition-all duration-500 ${
                  autoRun ? "animate-pulse" : ""
                }`}
                style={{
                  width: `${
                    progress.total > 0
                      ? Math.min(
                          100,
                          (progress.scraped / progress.total) * 100,
                        )
                      : 0
                  }%`,
                }}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {next ? (
          <div className="mt-6 rounded-2xl border border-border p-5">
            <div className="text-sm text-muted-foreground">Next pending</div>
            <div className="mt-1 font-mono text-sm">{next.url_path}</div>
            <a
              href={next.source_url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block text-xs text-primary underline"
            >
              {next.source_url}
            </a>
            <button
              onClick={runScrape}
              disabled={busy}
              className="mt-4 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground"
            >
              {busy ? "Scraping…" : "Scrape this page"}
            </button>
          </div>
        ) : (
          <p className="mt-6 text-sm text-muted-foreground">
            No pending rows for {templateType}.
          </p>
        )}

        {scraped && (
          <div className="mt-8 rounded-2xl border border-border p-5">
            <div className="text-sm text-muted-foreground">Scraped result</div>
            <div className="mt-1 font-semibold">{scraped.title}</div>
            <div className="text-xs text-muted-foreground">
              {scraped.seo_description}
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-sm">
                body_markdown ({scraped.body_markdown?.length ?? 0} chars)
              </summary>
              <pre className="mt-2 max-h-96 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
                {scraped.body_markdown}
              </pre>
            </details>
            <details className="mt-3">
              <summary className="cursor-pointer text-sm">
                raw_html ({scraped.raw_html?.length ?? 0} chars)
              </summary>
              <pre className="mt-2 max-h-96 overflow-auto rounded bg-muted p-3 text-xs">
                {scraped.raw_html?.slice(0, 5000)}
              </pre>
            </details>
          </div>
        )}
      </AdminLayout>
  );
}
