import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { runHeroBackfill } from "@/server/cities-hero-backfill.functions";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";

export const Route = createFileRoute("/admin/cities-heroes")({
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: "/auth" as never });
    }
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  component: AdminHeroBackfillPage,
  head: () => ({ meta: [{ title: "Backfill city heroes — Admin" }] }),
});

type Result = {
  slug: string;
  name: string;
  source_url: string | null;
  status: "ok" | "miss" | "error" | "skipped" | "generated";
  hero_url?: string;
  error?: string;
};

function AdminHeroBackfillPage() {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [summary, setSummary] = useState<Record<string, number> | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [stoppedReason, setStoppedReason] = useState<string | null>(null);
  const [autoContinue, setAutoContinue] = useState(false);
  const [batchSize, setBatchSize] = useState(25);
  const [concurrency, setConcurrency] = useState(2);
  const [forceMode, setForceMode] = useState(false);
  const [generateFallback, setGenerateFallback] = useState(true);
  const [maxFallbacksPerBatch, setMaxFallbacksPerBatch] = useState(10);

  // Persist processed slugs across batches so force-mode runs are resumable
  // (non-force is naturally resumable because filled rows drop out of the query).
  const processedRef = useRef<Set<string>>(new Set());
  const stopRef = useRef(false);

  function reset() {
    processedRef.current = new Set();
    setResults([]);
    setSummary(null);
    setRemaining(null);
    setStoppedReason(null);
    setErrMsg(null);
  }

  async function runBatch(force: boolean): Promise<{ remaining: number } | null> {
    const excludeSlugs = force ? Array.from(processedRef.current) : undefined;
    try {
      const out = await runHeroBackfill({
        data: { force, batchSize, concurrency, excludeSlugs, generateFallback, maxFallbacksPerBatch },
      });
      // Append results.
      setResults((prev) => [...prev, ...out.results]);
      out.processedSlugs.forEach((s) => processedRef.current.add(s));
      // Merge summary.
      setSummary((prev) => {
        const next: Record<string, number> = { ...(prev ?? {}) };
        for (const [k, v] of Object.entries(out.summary)) {
          next[k] = (next[k] ?? 0) + v;
        }
        return next;
      });
      setRemaining(out.remaining);
      setStoppedReason(out.stoppedReason);
      return { remaining: out.remaining };
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  async function startRun(force: boolean, continuous: boolean) {
    if (running) return;
    reset();
    setForceMode(force);
    setAutoContinue(continuous);
    stopRef.current = false;
    setRunning(true);
    try {
      // Loop batches until done, user stops, or single batch when !continuous.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const out = await runBatch(force);
        if (!out) break;
        if (!continuous) break;
        if (stopRef.current) break;
        if (out.remaining <= 0) break;
        // Brief pause between batches to be polite.
        await new Promise((r) => setTimeout(r, 800));
      }
    } finally {
      setRunning(false);
      setAutoContinue(false);
    }
  }

  async function continueOneBatch() {
    if (running) return;
    setRunning(true);
    try {
      await runBatch(forceMode);
    } finally {
      setRunning(false);
    }
  }

  function stop() {
    stopRef.current = true;
  }

  // Pause guard: if the page is hidden the user can leave; runs continue
  // server-side per batch, so the loop keeps progressing while tab is open.
  useEffect(() => () => { stopRef.current = true; }, []);

  function downloadMissesCsv() {
    const misses = results.filter((r) => r.status !== "ok");
    const csv =
      "slug,name,status,source_url,error\n" +
      misses
        .map((r) =>
          [
            r.slug,
            JSON.stringify(r.name),
            r.status,
            r.source_url,
            JSON.stringify(r.error ?? ""),
          ].join(","),
        )
        .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "city-hero-misses.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <AdminLayout>
        <div className="mb-6">
          <Link to="/" className="text-sm text-muted-foreground hover:underline">
            ← Home
          </Link>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">
            City hero image backfill
          </h1>
          <p className="mt-2 text-muted-foreground">
            Scrapes the source page for each city and saves the unique hero into
            the database. Admin only.{" "}
            <Link to={"/admin/cities-heroes-report" as never} className="text-primary hover:underline">
              View per-city report →
            </Link>
          </p>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="block text-xs">
            <span className="text-muted-foreground">Batch size</span>
            <input
              type="number" min={1} max={100} value={batchSize}
              disabled={running}
              onChange={(e) => setBatchSize(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
              className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1.5"
            />
          </label>
          <label className="block text-xs">
            <span className="text-muted-foreground">Concurrency</span>
            <input
              type="number" min={1} max={8} value={concurrency}
              disabled={running}
              onChange={(e) => setConcurrency(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
              className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1.5"
            />
          </label>
          <label className="block text-xs">
            <span className="text-muted-foreground">Max AI fallbacks / batch</span>
            <input
              type="number" min={0} max={50} value={maxFallbacksPerBatch}
              disabled={running || !generateFallback}
              onChange={(e) => setMaxFallbacksPerBatch(Math.max(0, Math.min(50, Number(e.target.value) || 0)))}
              className="mt-1 w-full rounded-md border border-border bg-card px-2 py-1.5 disabled:opacity-50"
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox" checked={generateFallback}
              disabled={running}
              onChange={(e) => setGenerateFallback(e.target.checked)}
            />
            <span>
              <span className="font-medium">Generate AI hero on miss</span>
              <span className="block text-muted-foreground">
                When scrape can't find an image, generate one and upload it.
              </span>
            </span>
          </label>
          {remaining !== null && (
            <div className="col-span-2 rounded-md border border-border bg-card p-2 text-xs">
              <div className="text-muted-foreground">Remaining</div>
              <div className="text-lg font-semibold">{remaining}</div>
              {stoppedReason && (
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  last stop: {stoppedReason}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            disabled={running}
            onClick={() => startRun(false, false)}
            className="inline-flex items-center justify-center rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {running && !autoContinue ? "Running…" : "Run one batch (missing)"}
          </button>
          <button
            disabled={running}
            onClick={() => startRun(false, true)}
            className="inline-flex items-center justify-center rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {running && autoContinue ? "Auto-running…" : "Run until done (missing)"}
          </button>
          <button
            disabled={running}
            onClick={() => startRun(true, true)}
            className="inline-flex items-center justify-center rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground hover:bg-secondary disabled:opacity-50"
          >
            Force re-scrape (until done)
          </button>
          {!running && remaining !== null && remaining > 0 && (
            <button
              onClick={continueOneBatch}
              className="inline-flex items-center justify-center rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground hover:bg-secondary"
            >
              Continue next batch
            </button>
          )}
          {running && autoContinue && (
            <button
              onClick={stop}
              className="inline-flex items-center justify-center rounded-full border border-destructive/40 bg-destructive/10 px-5 py-2.5 text-sm font-semibold text-destructive hover:bg-destructive/20"
            >
              Stop after current batch
            </button>
          )}
          {results.length > 0 && (
            <button
              onClick={downloadMissesCsv}
              className="inline-flex items-center justify-center rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground hover:bg-secondary"
            >
              Download misses CSV
            </button>
          )}
        </div>

        {errMsg && (
          <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            {errMsg}
          </div>
        )}

        {summary && (
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Object.entries(summary).map(([k, v]) => (
              <div
                key={k}
                className="rounded-lg border border-border bg-card p-4 text-center"
              >
                <div className="text-2xl font-bold">{v}</div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {k}
                </div>
              </div>
            ))}
          </div>
        )}

        {results.length > 0 && (
          <div className="mt-8 overflow-hidden rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-secondary/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">City</th>
                  <th className="px-3 py-2">Source</th>
                  <th className="px-3 py-2">Hero / error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {results.map((r) => (
                  <tr key={r.slug} className="align-top">
                    <td className="px-3 py-2 font-mono text-xs">
                      <span
                        className={
                          r.status === "ok"
                            ? "text-emerald-600"
                            : r.status === "generated"
                              ? "text-sky-600"
                              : r.status === "miss"
                                ? "text-amber-600"
                                : "text-destructive"
                        }
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{r.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.slug}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {r.source_url ? (
                        <a
                          href={r.source_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline"
                        >
                          {r.source_url.replace("https://www.", "")}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {r.hero_url ? (
                        <a
                          href={r.hero_url}
                          target="_blank"
                          rel="noreferrer"
                          className="break-all text-primary hover:underline"
                        >
                          {r.hero_url.slice(0, 80)}…
                        </a>
                      ) : (
                        <span className="text-muted-foreground">
                          {r.error ?? "—"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminLayout>
  );
}
