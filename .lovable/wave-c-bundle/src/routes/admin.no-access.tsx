import * as React from "react";
import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { getAdminIdentity, type AdminIdentity } from "@/server/admin-team.functions";
import { SiteHeader, SiteFooter } from "@/components/site-layout";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/admin/no-access")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data } = await supabase.auth.getUser();
    if (!data.user) {
      throw redirect({ to: "/auth", search: { redirect: "/admin/dashboard", mode: "signin" } });
    }
  },
  head: () => ({
    meta: [
      { title: "Admin access required — PRNM" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: NoAccessPage,
});

function NoAccessPage() {
  const [id, setId] = React.useState<AdminIdentity | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    void (async () => {
      try {
        const r = await getAdminIdentity();
        setId(r);
        if (r.isAdmin) {
          window.location.replace("/admin/dashboard");
        }
      } catch (e: any) {
        setErr(e?.message || "Failed to check access");
      }
    })();
  }, []);

  async function copy(v: string) {
    try { await navigator.clipboard.writeText(v); } catch {}
  }

  async function signOut() {
    await supabase.auth.signOut();
    window.location.href = "/auth?redirect=%2Fadmin%2Fdashboard&mode=signin";
  }

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-4 py-12">
        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
          <h1 className="text-2xl font-bold">Admin access required</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            You're signed in, but this account doesn't have admin access yet.
            Send the details below to an existing admin to be granted access.
          </p>

          {err && <div className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm">{err}</div>}

          {id && (
            <div className="mt-6 space-y-3 rounded-xl border border-border bg-background p-4 text-sm">
              <Row label="Signed in as" value={id.displayName || "—"} />
              <Row label="Email" value={id.email || "—"} onCopy={id.email ? () => copy(id.email!) : undefined} />
              <Row label="User ID" value={id.userId || "—"} mono onCopy={id.userId ? () => copy(id.userId!) : undefined} />
            </div>
          )}

          <div className="mt-6 flex flex-wrap gap-2">
            <Button variant="outline" onClick={signOut}>Sign in as a different account</Button>
            <Link to="/" className="inline-flex items-center rounded-md border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted">
              Back to site
            </Link>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

function Row({ label, value, mono, onCopy }: { label: string; value: string; mono?: boolean; onCopy?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`mt-0.5 truncate ${mono ? "font-mono text-xs" : ""}`}>{value}</div>
      </div>
      {onCopy && (
        <button onClick={onCopy} className="shrink-0 rounded border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-muted">
          Copy
        </button>
      )}
    </div>
  );
}
