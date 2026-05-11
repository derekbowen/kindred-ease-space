import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  adminGetLearnerDetail,
  type AdminLearnerDetail,
} from "@/server/learning.functions";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";
import { Progress } from "@/components/ui/progress";

export const Route = createFileRoute("/admin/learning/$userId")({
  beforeLoad: async ({ location }) => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) {
      throw redirect({
        to: "/auth",
        search: { redirect: location.pathname, mode: "signin" },
      });
    }
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  component: LearnerDetailPage,
  head: () => ({ meta: [{ title: "Learner detail — Pool Rental Near Me" }] }),
});

function LearnerDetailPage() {
  const { userId } = Route.useParams();
  const [detail, setDetail] = useState<AdminLearnerDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void adminGetLearnerDetail({ data: { user_id: userId } })
      .then(setDetail)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [userId]);

  return (
    <AdminLayout>
        <Link to="/admin/learning" className="text-sm text-primary hover:underline">
          ← Back to learning admin
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-foreground">
          {detail?.profile?.full_name ||
            detail?.profile?.display_name ||
            "Learner"}
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">{userId}</p>

        {err && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {err}
          </div>
        )}

        {!detail ? (
          <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <section className="mt-8">
              <h2 className="text-lg font-semibold text-foreground">Course progress</h2>
              {detail.progress.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">No active courses.</p>
              ) : (
                <ul className="mt-3 grid gap-3">
                  {detail.progress.map((p) => (
                    <li
                      key={p.course_slug}
                      className="rounded-2xl border border-border bg-card p-4 shadow-sm"
                    >
                      <div className="flex items-center justify-between">
                        <div className="font-medium text-foreground">
                          {p.course_title ?? p.course_slug}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {Math.round((p.total_seconds_spent ?? 0) / 60)} min spent
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-3">
                        <Progress value={p.progress_pct} className="flex-1" />
                        <span className="text-sm font-medium text-foreground">
                          {p.progress_pct}%
                        </span>
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">
                        Started{" "}
                        {p.started_at ? new Date(p.started_at).toLocaleDateString() : "—"} ·
                        Last activity{" "}
                        {p.last_activity_at
                          ? new Date(p.last_activity_at).toLocaleString()
                          : "—"}
                        {p.completed_at && (
                          <>
                            {" "}· Completed{" "}
                            {new Date(p.completed_at).toLocaleDateString()}
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="mt-10">
              <h2 className="text-lg font-semibold text-foreground">Certificates</h2>
              {detail.completions.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">No certificates issued.</p>
              ) : (
                <ul className="mt-3 grid gap-2">
                  {detail.completions.map((c) => (
                    <li
                      key={c.certificate_uid}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-3 text-sm"
                    >
                      <div>
                        <div className="font-medium text-foreground">{c.course_title}</div>
                        <div className="text-xs text-muted-foreground">
                          {c.certificate_uid} · Issued{" "}
                          {new Date(c.completed_at).toLocaleDateString()}
                          {c.revoked_at && (
                            <span className="ml-2 rounded bg-destructive/10 px-2 py-0.5 text-destructive">
                              Revoked
                            </span>
                          )}
                        </div>
                      </div>
                      <Link
                        to="/verify/$uid"
                        params={{ uid: c.certificate_uid }}
                        className="text-primary hover:underline"
                      >
                        Verify
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="mt-10">
              <h2 className="text-lg font-semibold text-foreground">Recent events</h2>
              {detail.events.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">No events recorded.</p>
              ) : (
                <ol className="mt-3 space-y-1 text-xs">
                  {detail.events.map((e) => (
                    <li
                      key={e.id}
                      className="flex items-baseline gap-3 border-b border-border/60 pb-1"
                    >
                      <span className="text-muted-foreground tabular-nums">
                        {new Date(e.created_at).toLocaleString()}
                      </span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                        {e.event_type}
                      </span>
                      <span className="text-foreground">{e.course_slug}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </AdminLayout>
  );
}
