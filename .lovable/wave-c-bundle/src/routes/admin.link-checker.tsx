import * as React from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";
import { scanBrokenLinks, fixBrokenLink, bulkFixBrokenLinks, type BrokenLink } from "@/server/link-checker.functions";
import { getRecentLinkHealthRuns, type LinkHealthRun } from "@/server/link-health.functions";

export const Route = createFileRoute("/admin/link-checker")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth", search: { redirect: "/admin/link-checker", mode: "signin" } });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({ meta: [{ title: "Link checker — Admin" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: LinkChecker,
});

const REASON_LABEL: Record<BrokenLink["reason"], string> = {
  missing_p_page: "Missing /p/ page",
  unknown_internal_path: "Unknown internal path",
  malformed: "Malformed URL",
};

type RowState = { status: "idle" | "fixing" | "fixed" | "error"; msg?: string };

function LinkChecker() {
  const [rows, setRows] = React.useState<BrokenLink[]>([]);
  const [scanning, setScanning] = React.useState(false);
  const [progress, setProgress] = React.useState({ done: 0, total: 0 });
  const [filter, setFilter] = React.useState<"all" | BrokenLink["reason"]>("all");
  const [state, setState] = React.useState<Record<string, RowState>>({});
  const [editHref, setEditHref] = React.useState<Record<string, string>>({});
  const [healthRuns, setHealthRuns] = React.useState<LinkHealthRun[]>([]);
  const abortRef = React.useRef(false);

  React.useEffect(() => {
    getRecentLinkHealthRuns().then(setHealthRuns).catch(() => setHealthRuns([]));
  }, []);

  // Scan filters
  const [showFilters, setShowFilters] = React.useState(false);
  const [fUrlPrefix, setFUrlPrefix] = React.useState("/p/");
  const [fUrlContains, setFUrlContains] = React.useState("");
  const [fRangeStart, setFRangeStart] = React.useState("");
  const [fRangeEnd, setFRangeEnd] = React.useState("");
  const [fPageIdsRaw, setFPageIdsRaw] = React.useState("");
  const [fOnlyMissing, setFOnlyMissing] = React.useState(false);

  function key(b: BrokenLink) { return `${b.page_id}::${b.href}`; }

  function buildScanFilters() {
    const pageIds = fPageIdsRaw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s));
    return {
      urlPrefix: fUrlPrefix.trim() || undefined,
      urlContains: fUrlContains.trim() || undefined,
      rangeStart: fRangeStart.trim() || undefined,
      rangeEnd: fRangeEnd.trim() || undefined,
      pageIds: pageIds.length ? pageIds : undefined,
      onlyMissingPPage: fOnlyMissing || undefined,
    };
  }

  function resetFilters() {
    setFUrlPrefix("/p/"); setFUrlContains(""); setFRangeStart(""); setFRangeEnd("");
    setFPageIdsRaw(""); setFOnlyMissing(false);
  }

  const activeFilterCount =
    (fUrlPrefix.trim() && fUrlPrefix.trim() !== "/p/" ? 1 : 0) +
    (fUrlContains.trim() ? 1 : 0) +
    (fRangeStart.trim() ? 1 : 0) +
    (fRangeEnd.trim() ? 1 : 0) +
    (fPageIdsRaw.trim() ? 1 : 0) +
    (fOnlyMissing ? 1 : 0);

  const [scanCompletedAt, setScanCompletedAt] = React.useState<Date | null>(null);
  const [scanDurationMs, setScanDurationMs] = React.useState<number | null>(null);

  async function startScan() {
    setRows([]); setState({}); setEditHref({}); setScanning(true); abortRef.current = false;
    setScanCompletedAt(null); setScanDurationMs(null);
    let offset = 0;
    const batchSize = 200;
    const filters = buildScanFilters();
    if (fOnlyMissing) setFilter("missing_p_page");
    const startedAt = Date.now();
    try {
      while (!abortRef.current) {
        const r = await scanBrokenLinks({ data: { offset, batchSize, ...filters } });
        setRows((prev) => [...prev, ...r.broken]);
        setProgress({ done: r.nextOffset, total: r.total });
        if (r.done) break;
        offset = r.nextOffset;
      }
    } finally {
      setScanning(false);
      setScanCompletedAt(new Date());
      setScanDurationMs(Date.now() - startedAt);
    }
  }

  async function applyFix(b: BrokenLink, action: "replace" | "unlink" | "remove", newHref?: string) {
    const k = key(b);
    setState((s) => ({ ...s, [k]: { status: "fixing" } }));
    try {
      const res = await fixBrokenLink({ data: { pageId: b.page_id, href: b.href, action, newHref } });
      if (res.ok) setState((s) => ({ ...s, [k]: { status: "fixed", msg: action === "replace" ? `→ ${newHref}` : action } }));
      else setState((s) => ({ ...s, [k]: { status: "error", msg: (res as any).error || "Failed" } }));
    } catch (e: any) {
      setState((s) => ({ ...s, [k]: { status: "error", msg: e?.message || "Failed" } }));
    }
  }

  const [bulkRunning, setBulkRunning] = React.useState(false);
  const [bulkResult, setBulkResult] = React.useState<string | null>(null);

  async function applyBulk(action: "replace" | "unlink" | "remove") {
    setBulkResult(null);
    const targets = filtered;
    if (!targets.length) return;
    if (action === "replace") {
      const missingSuggestion = targets.filter((b) => !((editHref[key(b)] ?? b.suggestion?.href) || "").trim());
      if (missingSuggestion.length === targets.length) {
        setBulkResult("No suggestions/edits available to replace with. Use Unlink or Remove instead.");
        return;
      }
    }
    const verb = action === "replace" ? "replace" : action;
    if (!confirm(`Apply "${verb}" to ${targets.length} link${targets.length === 1 ? "" : "s"}?${action === "replace" ? " Only links with a suggested or edited URL will be changed." : ""}`)) return;

    setBulkRunning(true);
    try {
      const items = targets
        .map((b) => {
          const newHref = (editHref[key(b)] ?? b.suggestion?.href ?? "").trim();
          if (action === "replace" && !newHref) return null;
          return { pageId: b.page_id, href: b.href, newHref: action === "replace" ? newHref : undefined };
        })
        .filter(Boolean) as Array<{ pageId: string; href: string; newHref?: string }>;

      const res = await bulkFixBrokenLinks({ data: { action, items } });
      // mark each affected row in local state
      setState((prev) => {
        const next = { ...prev };
        for (const it of items) {
          const k = `${it.pageId}::${it.href}`;
          next[k] = { status: "fixed", msg: action === "replace" ? `→ ${it.newHref}` : action };
        }
        return next;
      });
      setBulkResult(`Updated ${res.pagesUpdated} page${res.pagesUpdated === 1 ? "" : "s"} · fixed ${res.linksFixed} link${res.linksFixed === 1 ? "" : "s"}${res.linksSkipped ? ` · skipped ${res.linksSkipped}` : ""}${res.errors.length ? ` · ${res.errors.length} errors` : ""}.`);
    } catch (e: any) {
      setBulkResult(`Bulk fix failed: ${e?.message || "unknown error"}`);
    } finally {
      setBulkRunning(false);
    }
  }


  const filtered = rows.filter((r) => filter === "all" || r.reason === filter);
  const counts = {
    all: rows.length,
    missing_p_page: rows.filter((r) => r.reason === "missing_p_page").length,
    unknown_internal_path: rows.filter((r) => r.reason === "unknown_internal_path").length,
    malformed: rows.filter((r) => r.reason === "malformed").length,
  };
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  // === Summary report ===
  const report = React.useMemo(() => {
    if (!rows.length) return null;
    // Top broken targets (group by href)
    const byTarget = new Map<string, { href: string; count: number; pages: Set<string>; reason: BrokenLink["reason"]; suggestion: string | null }>();
    for (const r of rows) {
      const e = byTarget.get(r.href) || { href: r.href, count: 0, pages: new Set<string>(), reason: r.reason, suggestion: r.suggestion?.href || null };
      e.count++; e.pages.add(r.page_url);
      if (!e.suggestion && r.suggestion?.href) e.suggestion = r.suggestion.href;
      byTarget.set(r.href, e);
    }
    const targets = Array.from(byTarget.values()).map((t) => ({ ...t, pageCount: t.pages.size }));
    const topTargets = [...targets].sort((a, b) => b.count - a.count).slice(0, 10);
    // Fastest fixes by impact: has a suggestion and high count
    const fastestFixes = targets
      .filter((t) => t.suggestion)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    // Affected pages count
    const affectedPages = new Set(rows.map((r) => r.page_url)).size;
    return { topTargets, fastestFixes, affectedPages, withSuggestions: rows.filter((r) => r.suggestion?.href).length };
  }, [rows]);

  async function fixAllOf(href: string, newHref: string) {
    const items = rows.filter((r) => r.href === href).map((r) => ({ pageId: r.page_id, href: r.href, newHref }));
    if (!items.length) return;
    if (!confirm(`Replace ${items.length} occurrence${items.length === 1 ? "" : "s"} of ${href} → ${newHref}?`)) return;
    setBulkRunning(true);
    try {
      const res = await bulkFixBrokenLinks({ data: { action: "replace", items } });
      setState((prev) => {
        const next = { ...prev };
        for (const it of items) next[`${it.pageId}::${it.href}`] = { status: "fixed", msg: `→ ${newHref}` };
        return next;
      });
      setBulkResult(`Updated ${res.pagesUpdated} page${res.pagesUpdated === 1 ? "" : "s"} · fixed ${res.linksFixed} link${res.linksFixed === 1 ? "" : "s"}.`);
    } catch (e: any) {
      setBulkResult(`Failed: ${e?.message || "unknown"}`);
    } finally {
      setBulkRunning(false);
    }
  }


  return (
    <AdminLayout title="Link checker">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Internal link checker</h1>
          <p className="text-sm text-muted-foreground">
            Scans every published <code>/p/*</code> page for broken internal links and offers one-click fixes.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowFilters((v) => !v)}
            className={`rounded-full border px-4 py-2 text-sm font-semibold ${activeFilterCount ? "border-primary text-primary" : "border-border"}`}
          >
            Filters{activeFilterCount ? ` (${activeFilterCount})` : ""}
          </button>
          {scanning ? (
            <button onClick={() => { abortRef.current = true; }} className="rounded-full border border-border px-4 py-2 text-sm font-semibold">Stop</button>
          ) : (
            <button onClick={startScan} className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
              {rows.length ? "Re-scan" : "Start scan"}
            </button>
          )}
      </div>

      {healthRuns.length > 0 && (
        <div className="mt-4 rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Scheduled link-health runs</h2>
            <span className="text-xs text-muted-foreground">Latest {healthRuns.length} of cron-driven /api/public/link-health calls</span>
          </div>
          <div className="mt-3 max-h-48 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr><th className="py-1 pr-3">When</th><th className="py-1 pr-3">Source</th><th className="py-1 pr-3">Checked</th><th className="py-1 pr-3">Broken</th><th className="py-1 pr-3">Duration</th><th className="py-1">Status</th></tr>
              </thead>
              <tbody>
                {healthRuns.map((r) => (
                  <tr key={r.id} className="border-t border-border/50">
                    <td className="py-1 pr-3 whitespace-nowrap">{new Date(r.ran_at).toLocaleString()}</td>
                    <td className="py-1 pr-3">{r.source}</td>
                    <td className="py-1 pr-3">{r.checked}</td>
                    <td className={`py-1 pr-3 ${r.broken_count ? "font-semibold text-destructive" : ""}`}>{r.broken_count}</td>
                    <td className="py-1 pr-3">{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : "—"}</td>
                    <td className="py-1">{r.ok ? "✓" : "✗"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      </div>

      {showFilters && (
        <div className="mt-4 rounded-lg border border-border bg-card p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs">
              <span className="mb-1 block font-medium text-muted-foreground">URL prefix</span>
              <input
                value={fUrlPrefix}
                onChange={(e) => setFUrlPrefix(e.target.value)}
                placeholder="/p/ or /p/austin-tx-"
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">Must start with <code>/p/</code>. Limits scan to URLs starting with this.</span>
            </label>
            <label className="block text-xs">
              <span className="mb-1 block font-medium text-muted-foreground">URL contains</span>
              <input
                value={fUrlContains}
                onChange={(e) => setFUrlContains(e.target.value)}
                placeholder="austin"
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">Substring match on the URL path (case-insensitive).</span>
            </label>
            <label className="block text-xs">
              <span className="mb-1 block font-medium text-muted-foreground">Range start</span>
              <input
                value={fRangeStart}
                onChange={(e) => setFRangeStart(e.target.value)}
                placeholder="/p/a"
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block font-medium text-muted-foreground">Range end</span>
              <input
                value={fRangeEnd}
                onChange={(e) => setFRangeEnd(e.target.value)}
                placeholder="/p/m"
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
              />
            </label>
            <label className="block text-xs sm:col-span-2">
              <span className="mb-1 block font-medium text-muted-foreground">Page IDs (overrides URL filters)</span>
              <textarea
                value={fPageIdsRaw}
                onChange={(e) => setFPageIdsRaw(e.target.value)}
                rows={2}
                placeholder="UUIDs separated by spaces, commas, or newlines"
                className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs"
              />
            </label>
            <label className="flex items-center gap-2 sm:col-span-2">
              <input
                type="checkbox"
                checked={fOnlyMissing}
                onChange={(e) => setFOnlyMissing(e.target.checked)}
                className="h-4 w-4"
              />
              <span className="text-sm">Only report <code>/p/</code> missing-target issues</span>
            </label>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={resetFilters} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted">
              Reset
            </button>
          </div>
        </div>
      )}

      {(scanning || progress.total > 0) && (
        <div className="mt-4">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{scanning ? "Scanning…" : "Scan complete"}</span>
            <span>{progress.done} / {progress.total} pages · {rows.length} broken links</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {!scanning && report && (
        <div className="mt-6 rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">Scan summary</h2>
            <span className="text-xs text-muted-foreground">
              {scanCompletedAt ? scanCompletedAt.toLocaleString() : ""}
              {scanDurationMs != null ? ` · ${(scanDurationMs / 1000).toFixed(1)}s` : ""}
            </span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              ["Pages scanned", progress.done.toLocaleString()],
              ["Broken links", rows.length.toLocaleString()],
              ["Affected pages", report.affectedPages.toLocaleString()],
              ["With suggestion", report.withSuggestions.toLocaleString()],
              ["Missing /p/", counts.missing_p_page.toLocaleString()],
            ].map(([label, val]) => (
              <div key={label} className="rounded-md border border-border bg-background p-3">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
                <div className="mt-1 text-xl font-semibold">{val}</div>
              </div>
            ))}
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold">Top broken targets</h3>
              <p className="text-xs text-muted-foreground">Links broken in the most places.</p>
              <ol className="mt-2 space-y-1.5">
                {report.topTargets.length === 0 && <li className="text-xs text-muted-foreground">None.</li>}
                {report.topTargets.map((t) => (
                  <li key={t.href} className="flex items-center justify-between gap-2 rounded border border-border bg-background px-2 py-1.5">
                    <code className="truncate text-xs" title={t.href}>{t.href}</code>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t.count}× · {t.pageCount} page{t.pageCount === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
            <div>
              <h3 className="text-sm font-semibold">Fastest fixes by impact</h3>
              <p className="text-xs text-muted-foreground">Targets with a suggested replacement, ordered by occurrences fixed.</p>
              <ol className="mt-2 space-y-1.5">
                {report.fastestFixes.length === 0 && <li className="text-xs text-muted-foreground">No suggestions available yet.</li>}
                {report.fastestFixes.map((t) => (
                  <li key={t.href} className="rounded border border-border bg-background px-2 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <code className="truncate text-xs" title={t.href}>{t.href}</code>
                      <span className="shrink-0 text-xs text-muted-foreground">{t.count}× · {t.pageCount} pg</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <div className="truncate text-[11px] text-muted-foreground">→ <code>{t.suggestion}</code></div>
                      <button
                        disabled={bulkRunning}
                        onClick={() => fixAllOf(t.href, t.suggestion!)}
                        className="shrink-0 rounded bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground disabled:opacity-50"
                      >Fix all</button>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-6 flex flex-wrap gap-2">
          {([
            ["all", "All"],
            ["missing_p_page", "Missing /p/"],
            ["unknown_internal_path", "Unknown internal"],
            ["malformed", "Malformed"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setFilter(id as any)}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${filter === id ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-muted"}`}
            >
              {label} ({counts[id as keyof typeof counts]})
            </button>
          ))}
        </div>
      )}

      {filtered.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3">
          <span className="text-sm font-medium">Bulk action on {filtered.length} filtered link{filtered.length === 1 ? "" : "s"}:</span>
          <button
            onClick={() => applyBulk("replace")}
            disabled={bulkRunning}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            title="Replaces each link with its suggested or edited URL. Links without a target are skipped."
          >
            ⚡ Replace all (using suggestions)
          </button>
          <button
            onClick={() => applyBulk("unlink")}
            disabled={bulkRunning}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            Unlink all
          </button>
          <button
            onClick={() => applyBulk("remove")}
            disabled={bulkRunning}
            className="rounded-md border border-red-500 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-500/10 disabled:opacity-50"
          >
            Remove all
          </button>
          {bulkRunning && <span className="text-xs text-muted-foreground">Working…</span>}
          {bulkResult && <span className="ml-auto text-xs text-muted-foreground">{bulkResult}</span>}
        </div>
      )}

      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Page</th>
              <th className="px-3 py-2 text-left">Broken link</th>
              <th className="px-3 py-2 text-left">Reason</th>
              <th className="px-3 py-2 text-left">Fix</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                {scanning ? "Scanning…" : rows.length ? "No links match this filter." : "Run a scan to find broken links."}
              </td></tr>
            )}
            {filtered.map((b) => {
              const k = key(b);
              const st = state[k];
              const suggested = b.suggestion?.href || "";
              const editVal = editHref[k] ?? suggested;
              return (
                <tr key={k + Math.random()} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <a href={b.page_url} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">{b.page_url}</a>
                    <div className="text-xs text-muted-foreground line-clamp-1">{b.page_title || ""}</div>
                  </td>
                  <td className="px-3 py-2">
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{b.href}</code>
                    <div className="text-xs text-muted-foreground">label: "{b.label}"</div>
                  </td>
                  <td className="px-3 py-2">
                    <span className="rounded-full bg-yellow-500/10 px-2 py-0.5 text-xs font-medium text-yellow-700 dark:text-yellow-400">
                      {REASON_LABEL[b.reason]}
                    </span>
                    {b.suggestion && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        Suggested: <code className="rounded bg-muted px-1 py-0.5">{b.suggestion.href}</code> ({b.suggestion.reason})
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {st?.status === "fixed" ? (
                      <span className="text-xs font-medium text-green-600 dark:text-green-400">✓ Fixed {st.msg}</span>
                    ) : st?.status === "error" ? (
                      <span className="text-xs font-medium text-red-600 dark:text-red-400">✗ {st.msg}</span>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <input
                          value={editVal}
                          onChange={(e) => setEditHref((m) => ({ ...m, [k]: e.target.value }))}
                          placeholder="/p/replacement"
                          className="w-44 rounded border border-border bg-background px-2 py-1 text-xs"
                        />
                        <button
                          disabled={st?.status === "fixing" || !editVal.trim()}
                          onClick={() => applyFix(b, "replace", editVal.trim())}
                          className="rounded bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                        >Replace</button>
                        <button
                          disabled={st?.status === "fixing"}
                          onClick={() => applyFix(b, "unlink")}
                          className="rounded border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                        >Unlink</button>
                        <button
                          disabled={st?.status === "fixing"}
                          onClick={() => applyFix(b, "remove")}
                          className="rounded border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                        >Remove</button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </AdminLayout>
  );
}
