import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  adminGetCourseSummary,
  adminListLearners,
  type AdminCourseSummary,
  type AdminLearnerRow,
} from "@/server/learning.functions";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";
import { Progress } from "@/components/ui/progress";

export const Route = createFileRoute("/admin/learning")({
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
  component: AdminLearningPage,
  head: () => ({ meta: [{ title: "Learning admin — Pool Rental Near Me" }] }),
});

function AdminLearningPage() {
  const [summary, setSummary] = useState<AdminCourseSummary[] | null>(null);
  const [learners, setLearners] = useState<AdminLearnerRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      adminGetCourseSummary({ data: undefined as never }),
      adminListLearners({ data: undefined as never }),
    ])
      .then(([s, l]) => {
        setSummary(s.rows);
        setLearners(l.rows);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const totalEnroll = (summary ?? []).reduce((a, r) => a + r.enrollments, 0);
  const totalComplete = (summary ?? []).reduce((a, r) => a + r.completions, 0);
  const completionRate = totalEnroll > 0 ? Math.round((totalComplete / totalEnroll) * 100) : 0;

  return (
    <AdminLayout>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Learning admin</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Aggregate course progress and per-learner activity.
        </p>

        {err && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {err}
          </div>
        )}

        <section className="mt-8 grid gap-4 sm:grid-cols-3">
          <Stat label="Enrollments" value={totalEnroll} />
          <Stat label="Completions" value={totalComplete} />
          <Stat label="Completion rate" value={`${completionRate}%`} />
        </section>

        <section className="mt-10">
          <h2 className="text-lg font-semibold text-foreground">By course</h2>
          {!summary ? (
            <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
          ) : summary.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No course activity yet.</p>
          ) : (
            <div className="mt-3 overflow-x-auto rounded-2xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2">Course</th>
                    <th className="px-4 py-2">Enrolled</th>
                    <th className="px-4 py-2">Completed</th>
                    <th className="px-4 py-2">Avg progress</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((r) => (
                    <tr key={r.course_slug} className="border-t border-border">
                      <td className="px-4 py-2 font-medium text-foreground">
                        {r.course_title ?? r.course_slug}
                        <div className="text-xs text-muted-foreground">{r.course_slug}</div>
                      </td>
                      <td className="px-4 py-2 text-foreground">{r.enrollments}</td>
                      <td className="px-4 py-2 text-foreground">{r.completions}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <Progress value={r.avg_progress_pct} className="w-32" />
                          <span className="text-xs text-foreground">{r.avg_progress_pct}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="mt-10">
          <h2 className="text-lg font-semibold text-foreground">Learners</h2>
          {!learners ? (
            <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
          ) : learners.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No learners yet.</p>
          ) : (
            <div className="mt-3 overflow-x-auto rounded-2xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2">Learner</th>
                    <th className="px-4 py-2">Enrolled</th>
                    <th className="px-4 py-2">Completed</th>
                    <th className="px-4 py-2">Last activity</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {learners.map((l) => (
                    <tr key={l.user_id} className="border-t border-border">
                      <td className="px-4 py-2 font-medium text-foreground">
                        {l.full_name || l.display_name || "Unnamed"}
                        <div className="text-xs text-muted-foreground">{l.user_id.slice(0, 8)}…</div>
                      </td>
                      <td className="px-4 py-2 text-foreground">{l.enrollments}</td>
                      <td className="px-4 py-2 text-foreground">{l.completions}</td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {l.last_activity_at
                          ? new Date(l.last_activity_at).toLocaleString()
                          : "—"}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Link
                          to="/admin/learning/$userId"
                          params={{ userId: l.user_id }}
                          className="text-primary hover:underline"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </AdminLayout>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold text-foreground">{value}</div>
    </div>
  );
}
