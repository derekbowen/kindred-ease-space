import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { runAliasBackfillFn } from "@/server/alias-backfill.functions";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";

export const Route = createFileRoute("/admin/redirect-aliases")({
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: "/auth" as never });
    }
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  component: AdminAliasBackfillPage,
  head: () => ({ meta: [{ title: "Redirect aliases — Admin" }] }),
});

type Result = {
  legacy_slug: string;
  canonical_slug: string | null;
  status: "resolved" | "unresolved";
  reason: string;
  hit_count: number;
};

function AdminAliasBackfillPage() {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [summary, setSummary] = useState<Record<string, number> | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    if (running) return;
    setRunning(true);
    setErrMsg(null);
    setResults([]);
    setSummary(null);
    try {
      const out = await runAliasBackfillFn({ data: { dryRun, limit: 500 } });
      setResults(out.results);
      setSummary(out.summary);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <AdminLayout>
      <div className="mb-6">
        <Link to="/" className="text-sm text-muted-foreground hover:underline">
          ← Home
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">
          Redirect aliases
        </h1>
        <p className="mt-2 text-muted-foreground">
          Scans the 404 log, resolves missing slugs to a canonical{" "}
          <code className="rounded bg-secondary px-1.5 py-0.5 text-xs">
            /p/...
          </code>{" "}
          page, and adds them to that page's{" "}
          <code className="rounded bg-secondary px-1.5 py-0.5 text-xs">
            legacy_slugs
          </code>{" "}
          so future visits 301 instead of 404. Admin only.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          disabled={running}
          onClick={() => run(true)}
          className="inline-flex items-center justify-center rounded-full border border-border bg-card px-5 py-2.5 text-sm font-semibold text-foreground hover:bg-secondary disabled:opacity-50"
        >
          {running ? "Running…" : "Preview (dry run)"}
        </button>
        <button
          disabled={running}
          onClick={() => run(false)}
          className="inline-flex items-center justify-center rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
        >
          {running ? "Running…" : "Run backfill"}
        </button>
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
                {k.replace(/_/g, " ")}
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
                <th className="px-3 py-2">Hits</th>
                <th className="px-3 py-2">Legacy slug</th>
                <th className="px-3 py-2">→ canonical</th>
                <th className="px-3 py-2">Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {results.map((r) => (
                <tr key={r.legacy_slug} className="align-top">
                  <td className="px-3 py-2 font-mono text-xs">
                    <span
                      className={
                        r.status === "resolved"
                          ? "text-emerald-600"
                          : "text-muted-foreground"
                      }
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums">
                    {r.hit_count}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <code>/p/{r.legacy_slug}</code>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.canonical_slug ? (
                      <a
                        href={`/p/${r.canonical_slug}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        /p/{r.canonical_slug}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {r.reason}
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
