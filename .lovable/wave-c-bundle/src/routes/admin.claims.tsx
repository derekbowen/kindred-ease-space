import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { adminListProviderClaims, adminReviewProviderClaim } from "@/server/directory.functions";
import { AdminLayout } from "@/components/admin-layout";
import { buildMeta } from "@/lib/seo";

export const Route = createFileRoute("/admin/claims")({
  loader: () => adminListProviderClaims(),
  head: () => buildMeta({ title: "Listing Claims | Admin", description: "Review provider listing claims", path: "/admin/claims", noindex: true }),
  component: AdminClaimsPage,
  errorComponent: ({ error }) => (
    <AdminLayout>
        <h1 className="text-2xl font-bold">Not authorized</h1>
        <p className="mt-2 text-muted-foreground">{error.message}</p>
      </AdminLayout>
  ),
});

function AdminClaimsPage() {
  const initial = Route.useLoaderData() as { claims: any[] };
  const [claims, setClaims] = useState(initial.claims);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function act(id: string, action: "approve" | "reject" | "delete", apply_proposed = false) {
    setBusyId(id);
    setError("");
    try {
      await adminReviewProviderClaim({ data: { id, action, apply_proposed } });
      if (action === "delete") {
        setClaims((cs) => cs.filter((c) => c.id !== id));
      } else {
        setClaims((cs) =>
          cs.map((c) =>
            c.id === id ? { ...c, status: action === "approve" ? "approved" : "rejected", reviewed_at: new Date().toISOString() } : c,
          ),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  const pending = claims.filter((c) => c.status === "pending");
  const reviewed = claims.filter((c) => c.status !== "pending");

  return (
    <AdminLayout>
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Listing Claims</h1>
            <p className="mt-1 text-sm text-muted-foreground">{pending.length} pending • {reviewed.length} reviewed</p>
          </div>
          <Link to="/admin/dashboard" className="text-sm font-medium text-primary hover:underline">← Back to dashboard</Link>
        </header>

        {error && <p className="mt-4 rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}

        <Section title="Pending review" claims={pending} busyId={busyId} act={act} />
        <Section title="Reviewed" claims={reviewed} busyId={busyId} act={act} compact />
      </AdminLayout>
  );
}

function Section({ title, claims, busyId, act, compact = false }: { title: string; claims: any[]; busyId: string | null; act: (id: string, a: "approve" | "reject" | "delete", apply?: boolean) => void; compact?: boolean }) {
  if (claims.length === 0) return null;
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <div className="mt-4 space-y-4">
        {claims.map((c) => (
          <article key={c.id} className={`rounded-2xl border bg-card p-5 ${compact ? "border-border/50 opacity-80" : "border-border"}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <a href={`/p/pool-pros/${c.provider_slug}`} target="_blank" rel="noreferrer" className="font-semibold text-foreground hover:text-primary">
                    {c.provider_slug}
                  </a>
                  <StatusBadge status={c.status} />
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Claimer: <strong>{c.claimer_name}</strong> ({c.claimer_role || "—"}) · {c.claimer_email}
                  {c.claimer_phone && ` · ${c.claimer_phone}`}
                </p>
                <p className="text-xs text-muted-foreground">Submitted {new Date(c.created_at).toLocaleString()}</p>
              </div>
              {!compact && (
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => act(c.id, "approve", true)}
                    disabled={busyId === c.id}
                    className="rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    Approve + apply edits
                  </button>
                  <button
                    onClick={() => act(c.id, "approve", false)}
                    disabled={busyId === c.id}
                    className="rounded-full border border-border bg-card px-4 py-1.5 text-xs font-semibold hover:bg-muted/50 disabled:opacity-50"
                  >
                    Approve only
                  </button>
                  <button
                    onClick={() => act(c.id, "reject")}
                    disabled={busyId === c.id}
                    className="rounded-full border border-destructive/40 px-4 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-50"
                  >
                    Reject
                  </button>
                  <button
                    onClick={() => act(c.id, "delete")}
                    disabled={busyId === c.id}
                    className="rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-destructive disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>

            {(c.business_email || c.business_phone || c.business_website) && (
              <p className="mt-3 text-xs text-muted-foreground">
                Business contact: {[c.business_email, c.business_phone, c.business_website].filter(Boolean).join(" · ")}
              </p>
            )}

            {c.verification_notes && (
              <div className="mt-3 rounded-lg bg-muted/50 p-3 text-sm text-foreground">
                <p className="text-xs font-semibold text-muted-foreground">Verification</p>
                <p className="mt-1 whitespace-pre-line">{c.verification_notes}</p>
              </div>
            )}

            {c.proposed_updates && Object.keys(c.proposed_updates).length > 0 && (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-medium text-primary">Proposed updates ({Object.keys(c.proposed_updates).length})</summary>
                <pre className="mt-2 overflow-x-auto rounded-lg bg-muted/50 p-3 text-xs text-foreground">{JSON.stringify(c.proposed_updates, null, 2)}</pre>
              </details>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "approved"
      ? "bg-emerald-100 text-emerald-800"
      : status === "rejected"
        ? "bg-rose-100 text-rose-800"
        : "bg-amber-100 text-amber-800";
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${cls}`}>{status}</span>;
}
