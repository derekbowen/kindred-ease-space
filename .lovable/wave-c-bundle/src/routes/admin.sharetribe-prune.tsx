import * as React from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";
import {
  previewSharetribePrune,
  executeSharetribePrune,
} from "@/server/sharetribe-prune.functions";

export const Route = createFileRoute("/admin/sharetribe-prune")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({
        to: "/auth",
        search: { redirect: "/admin/sharetribe-prune", mode: "signin" },
      });
    }
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({
    meta: [
      { title: "Prune Become-a-Host pages — Admin" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: SharetribePrunePage,
});

type Preview = Awaited<ReturnType<typeof previewSharetribePrune>>;

function SharetribePrunePage() {
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function runPreview() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await previewSharetribePrune();
      setPreview(r);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  async function runDelete() {
    if (!preview) return;
    if (
      !confirm(
        `Delete ${preview.pages.toDelete} "Become a host" pages? This cannot be undone.`,
      )
    )
      return;
    setDeleting(true);
    setError(null);
    try {
      const r = await executeSharetribePrune({ data: { confirm: "DELETE" } });
      setResult(
        `Deleted ${r.deleted} pages. Kept ${r.kept}. (${r.keysFound} Sharetribe city keys)`,
      );
      setPreview(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AdminLayout>
      <div className="max-w-4xl space-y-6 p-6">
        <header>
          <h1 className="text-2xl font-bold">Prune Become-a-Host pages</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Pulls every listing from Sharetribe (live, all states), derives
            unique <code>city-state</code> keys, then shows which "Become a
            host" pages would be kept vs. deleted. Nothing changes until you
            click Delete.
          </p>
        </header>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={runPreview}
            disabled={loading}
            className="rounded bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50"
          >
            {loading ? "Loading from Sharetribe…" : "Run preview"}
          </button>
          {preview && preview.pages.toDelete > 0 && (
            <button
              type="button"
              onClick={runDelete}
              disabled={deleting}
              className="rounded bg-destructive px-4 py-2 font-medium text-destructive-foreground disabled:opacity-50"
            >
              {deleting
                ? "Deleting…"
                : `Delete ${preview.pages.toDelete} pages`}
            </button>
          )}
        </div>

        {error && (
          <div className="rounded border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        {result && (
          <div className="rounded border border-green-600 bg-green-50 p-3 text-sm text-green-900">
            {result}
          </div>
        )}

        {preview && (
          <div className="space-y-6">
            <section className="rounded border p-4">
              <h2 className="font-semibold">Sharetribe</h2>
              <ul className="mt-2 text-sm">
                <li>Listings scanned: {preview.sharetribe.totalListings}</li>
                <li>Pages scanned: {preview.sharetribe.pagesScanned}</li>
                <li>Unique city keys: {preview.sharetribe.uniqueCityKeys}</li>
                <li>
                  Listings without city/state:{" "}
                  {preview.sharetribe.skippedNoCity}
                </li>
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                Sample keys:{" "}
                {preview.sharetribe.sampleKeys.join(", ") || "(none)"}
              </p>
            </section>

            <section className="rounded border p-4">
              <h2 className="font-semibold">Content pages (host-acquisition)</h2>
              <ul className="mt-2 text-sm">
                <li>Total: {preview.pages.total}</li>
                <li className="text-green-700">Keep: {preview.pages.keep}</li>
                <li className="text-red-700">
                  Delete: {preview.pages.toDelete}
                </li>
                <li className="text-muted-foreground">
                  Of which slug couldn't be parsed:{" "}
                  {preview.pages.unmatchedSlug}
                </li>
              </ul>
              <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <p className="font-medium text-green-700">Keep samples</p>
                  <ul className="mt-1 text-xs">
                    {preview.pages.keepSamples.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                    {preview.pages.keepSamples.length === 0 && <li>(none)</li>}
                  </ul>
                </div>
                <div>
                  <p className="font-medium text-red-700">Delete samples</p>
                  <ul className="mt-1 text-xs">
                    {preview.pages.deleteSamples.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
