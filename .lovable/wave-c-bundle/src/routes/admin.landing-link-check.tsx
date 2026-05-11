import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AdminLayout } from "@/components/admin-layout";
import {
  checkLandingAcademyLinks,
  type LandingLinkCheck,
} from "@/server/landing-link-check.functions";

export const Route = createFileRoute("/admin/landing-link-check")({
  component: LandingLinkCheckPage,
});

function LandingLinkCheckPage() {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<LandingLinkCheck[]>([]);
  const [summary, setSummary] = useState<{ ok: number; broken: number; total: number; checkedAt: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await checkLandingAcademyLinks();
      setResults(res.results);
      setSummary({ ok: res.ok, broken: res.broken, total: res.total, checkedAt: res.checkedAt });
    } catch (e: any) {
      setError(e?.message ?? "Failed to run check");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    run();
  }, []);

  return (
    <AdminLayout title="Landing page link check">
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Landing page link check</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Verifies every course and academy card on the landing page resolves to a published
              <code className="mx-1 rounded bg-muted px-1.5 py-0.5">/p/&#123;slug&#125;</code>
              page (so nginx forwards it to fresh-web instead of falling through to Sharetribe's 404).
            </p>
          </div>
          <button
            onClick={run}
            disabled={loading}
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {loading ? "Checking…" : "Re-run"}
          </button>
        </header>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {summary && (
          <div className="flex gap-3 text-sm">
            <span className="rounded-full bg-muted px-3 py-1 text-foreground">Total: {summary.total}</span>
            <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-emerald-700">OK: {summary.ok}</span>
            <span
              className={`rounded-full px-3 py-1 ${
                summary.broken > 0 ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground"
              }`}
            >
              Broken: {summary.broken}
            </span>
          </div>
        )}

        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Card</th>
                <th className="px-3 py-2">URL</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.href} className="border-t border-border">
                  <td className="px-3 py-2">
                    {r.ok ? (
                      <span className="inline-flex rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                        200
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold text-destructive">
                        {r.status === "missing" ? "404 (missing)" : "404 (unpublished)"}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-foreground">{r.label}</td>
                  <td className="px-3 py-2">
                    <a
                      href={r.href}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      {r.href}
                    </a>
                  </td>
                </tr>
              ))}
              {!results.length && !loading && (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-muted-foreground">
                    No results yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AdminLayout>
  );
}
