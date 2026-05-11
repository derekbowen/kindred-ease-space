import * as React from "react";
import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { getDashboardStats, type DashboardStats } from "@/server/admin-dashboard.functions";
import { listPendingFailures, retryPendingTemplate, queueSpanishCityBatch, type FailedPage } from "@/server/admin-pending-actions.functions";
import { AdminLayout, ADMIN_NAV_GROUPS } from "@/components/admin-layout";

export const Route = createFileRoute("/admin/dashboard")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: "/auth", search: { redirect: "/admin/dashboard", mode: "signin" } });
    }
  },
  head: () => ({
    meta: [
      { title: "Morning Command Center — Admin" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: AdminDashboard,
});

// ─── Helpers ──────────────────────────────────────────────────────────────
function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString();
}
function pct(num: number, denom: number): number {
  return denom > 0 ? Math.round((num / Math.max(denom, 1)) * 100) : 0;
}
function pctChange(cur: number, prior: number): { value: number; positive: boolean } | null {
  if (prior === 0) return cur > 0 ? { value: 100, positive: true } : null;
  const v = Math.round(((cur - prior) / prior) * 100);
  return { value: Math.abs(v), positive: v >= 0 };
}
function ageLabel(hours: number | null): string {
  if (hours == null) return "—";
  if (hours < 1) return "<1h";
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
function ageTone(hours: number | null): "ok" | "warn" | "danger" {
  if (hours == null) return "ok";
  if (hours > 48) return "danger";
  if (hours > 24) return "warn";
  return "ok";
}
function bandPaint(tone: "ok" | "warn" | "danger" | "neutral"): string {
  return tone === "danger" ? "border-red-500/30 bg-red-500/5"
    : tone === "warn" ? "border-yellow-500/30 bg-yellow-500/5"
    : tone === "ok" ? "border-emerald-500/30 bg-emerald-500/5"
    : "border-border bg-card";
}

// ─── Today's actions logic ───────────────────────────────────────────────
type Action = {
  severity: "critical" | "important" | "opportunity";
  title: string;
  why: string;
  cta: string;
  href: string;
  score: number;
};
function buildTopActions(s: DashboardStats): Action[] {
  const actions: Action[] = [];

  // 1. Templates with >100 pages and 0% published
  for (const t of s.byTemplate) {
    if (t.total > 100 && t.published === 0) {
      actions.push({
        severity: "critical",
        title: `Publish ${t.total} ${t.template_type || "(none)"} pages`,
        why: `Highest-intent supply pages stuck at 0% published.`,
        cta: "Open template",
        href: `/admin/content-pages?template=${encodeURIComponent(t.template_type || "")}`,
        score: 100 + t.total,
      });
    }
  }

  if (s.missing404s.unresolved > 500) {
    actions.push({
      severity: "critical",
      title: `Triage ${fmt(s.missing404s.unresolved)} 404s`,
      why: `Bleeding crawl budget — Google is wasting time on dead URLs.`,
      cta: "Open 404 log",
      href: "/admin/missing-pages",
      score: 100,
    });
  }

  if (s.contentPages.pending > 2000) {
    actions.push({
      severity: "important",
      title: `${fmt(s.contentPages.pending)} generated pages awaiting publish`,
      why: `Run bulk publish to unlock organic traffic.`,
      cta: "Bulk publish",
      href: "/admin/content-pages?status=pending",
      score: 50,
    });
  }

  const spCov = pct(s.spanish.cities_with_es, s.spanish.cities_eligible);
  if (spCov < 25) {
    actions.push({
      severity: "opportunity",
      title: `Spanish coverage at ${spCov}%`,
      why: `Generate next 100 cities to capture es-MX search demand.`,
      cta: "Queue Spanish batch",
      href: "/admin/dashboard#factory",
      score: 20,
    });
  }

  if (s.leads.new > 0 && (s.leads.oldestAgeHours ?? 0) > 24) {
    actions.push({
      severity: "critical",
      title: `${s.leads.new} leads unactioned, oldest ${ageLabel(s.leads.oldestAgeHours)} old`,
      why: `Leads cool fast — every hour past 24h cuts close rate.`,
      cta: "Open leads",
      href: "/admin/leads",
      score: 100 + (s.leads.oldestAgeHours ?? 0),
    });
  }

  if (s.providers.pending > 50) {
    actions.push({
      severity: "important",
      title: `${s.providers.pending} providers awaiting moderation`,
      why: `Unpublished providers can't show in directory or city pages.`,
      cta: "Open directory",
      href: "/admin/directory",
      score: 50 + s.providers.pending,
    });
  }

  if (s.planRequests.pending > 0) {
    actions.push({
      severity: "important",
      title: `${s.planRequests.pending} plan requests waiting`,
      why: `Provider upgrades blocked until you approve.`,
      cta: "Review requests",
      href: "/admin/plan-requests",
      score: 50,
    });
  }

  return actions.sort((a, b) => b.score - a.score).slice(0, 3);
}

// ─── Page component ──────────────────────────────────────────────────────
function AdminDashboard() {
  const [authorized, setAuthorized] = React.useState(false);
  const [stats, setStats] = React.useState<DashboardStats | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase.auth.getUser();
      if (cancelled) return;
      if (error || !data.user) {
        window.location.href = "/auth?redirect=%2Fadmin%2Fdashboard&mode=signin";
        return;
      }
      try {
        const { isAdmin } = await checkAdminRole();
        if (cancelled) return;
        if (!isAdmin) { window.location.replace("/admin/no-access"); return; }
        setAuthorized(true);
      } catch {
        if (!cancelled) window.location.href = "/auth?redirect=%2Fadmin%2Fdashboard&mode=signin";
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true); setErr(null);
    try { setStats(await getDashboardStats()); }
    catch (e: any) { setErr(e?.message || "Failed to load"); }
    finally { setLoading(false); }
  }, []);

  React.useEffect(() => {
    if (!authorized) return;
    void load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [authorized, load]);

  const actions = stats ? buildTopActions(stats) : [];

  return (
    <AdminLayout title="Morning Command Center">
      {!authorized ? (
        <div className="mt-12 text-center text-sm text-muted-foreground">Checking admin access…</div>
      ) : (
        <>
          {/* Header */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-3xl font-bold">Morning Command Center</h1>
              <p className="text-sm text-muted-foreground">
                Your daily operating rhythm. Top to bottom. Coffee in hand.
                {stats && <> · Updated {new Date(stats.generatedAt).toLocaleTimeString()}</>}
              </p>
            </div>
            <button onClick={load} className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {/* Sticky band nav */}
          <nav className="sticky top-0 z-10 -mx-4 mt-4 flex flex-wrap gap-2 overflow-x-auto bg-background/90 px-4 py-2 backdrop-blur sm:mx-0 sm:rounded-full sm:border sm:border-border sm:px-3">
            {[
              { href: "#today", label: "🎯 Today" },
              { href: "#revenue", label: "💰 Revenue" },
              { href: "#seo", label: "📈 SEO" },
              { href: "#factory", label: "⚙️ Factory" },
              { href: "#humans", label: "👥 Humans" },
              { href: "#tools", label: "🔧 Tools" },
            ].map((p) => (
              <a key={p.href} href={p.href}
                className="shrink-0 rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold hover:border-primary hover:bg-primary/5">
                {p.label}
              </a>
            ))}
          </nav>

          {err && <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm">{err}</div>}

          {stats && (
            <>
              {/* ════ BAND 1 — Today ════ */}
              <Band id="today" header="🎯 Today's Top 3 Actions" subtitle="Ranked by revenue/risk impact. Auto-refreshes every 30s.">
                {actions.length === 0 ? (
                  <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-6 text-center">
                    <div className="text-2xl">✨</div>
                    <div className="mt-1 text-sm font-semibold">All clear. Nothing critical.</div>
                    <div className="text-xs text-muted-foreground">Scroll down for the rhythm bands.</div>
                  </div>
                ) : (
                  <div className="grid gap-4 lg:grid-cols-3">
                    {actions.map((a, i) => <ActionCard key={i} action={a} />)}
                  </div>
                )}
              </Band>

              {/* ════ BAND 2 — Revenue ════ */}
              <Band id="revenue" header="💰 Revenue & Conversion Pulse" subtitle="The numbers that pay the bills.">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
                  <Metric label="Host signups" value={fmt(stats.users.newProfilesToday)}
                    sub={`${fmt(stats.users.newProfiles7d)} / 7d · ${fmt(stats.users.newProfiles30d)} / 30d`}
                    href="/admin/team" />
                  <Metric label="New listings" value={fmt(stats.listings.createdToday)}
                    sub={`${fmt(stats.listings.createdLast7d)} this week`}
                    href="/admin/sharetribe-prune" />
                  <Metric label="Booking requests (7d)" value="—" sub="Connect Sharetribe transactions" tone="warn"
                    href="/admin/sharetribe-prune" placeholder />
                  <Metric label="GMV (7d)" value="—" sub="Connect Sharetribe transactions" tone="warn"
                    href="/admin/sharetribe-prune" placeholder />
                  <Metric label="Lead inbox" value={fmt(stats.leads.new)}
                    sub={stats.leads.oldestAgeHours != null ? `oldest ${ageLabel(stats.leads.oldestAgeHours)}` : "no unactioned"}
                    tone={ageTone(stats.leads.oldestAgeHours)}
                    href="/admin/leads" />
                  <Metric label="Visitors → Hosts" value={
                    stats.gsc.clicks7d > 0 && stats.users.newProfiles7d > 0
                      ? `${((stats.users.newProfiles7d / stats.gsc.clicks7d) * 100).toFixed(2)}%`
                      : "—"
                  } sub="organic clicks ÷ new hosts" href="/admin/keyword-opportunities" />
                </div>
              </Band>

              {/* ════ BAND 3 — SEO ════ */}
              <Band id="seo" header="📈 Organic Performance" subtitle="Last 7d vs prior 7d. Source: GSC import.">
                {(() => {
                  const stale = stats.gsc.lastCapturedAt
                    ? (Date.now() - new Date(stats.gsc.lastCapturedAt).getTime()) / 36e5 > 48
                    : true;
                  if (stale) {
                    return (
                      <div className="mb-3 flex items-center justify-between rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm">
                        <span>
                          {stats.gsc.lastCapturedAt
                            ? `GSC data is ${Math.round((Date.now() - new Date(stats.gsc.lastCapturedAt).getTime()) / 86400000)} days old`
                            : "No GSC data imported yet"}
                          {" — "}re-sync to see fresh trends.
                        </span>
                        <Link to="/admin/gsc-import" className="rounded-full bg-yellow-600 px-3 py-1 text-xs font-semibold text-white">Import GSC</Link>
                      </div>
                    );
                  }
                  return null;
                })()}
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <Metric label="Indexed pages" value={fmt(stats.gsc.indexedPages)} href="/admin/indexing" />
                  <Metric label="Clicks (7d)" value={fmt(stats.gsc.clicks7d)}
                    delta={pctChange(stats.gsc.clicks7d, stats.gsc.clicksPrior7d)} href="/admin/keyword-opportunities" />
                  <Metric label="Impressions (7d)" value={fmt(stats.gsc.impressions7d)}
                    delta={pctChange(stats.gsc.impressions7d, stats.gsc.impressionsPrior7d)} href="/admin/keyword-opportunities" />
                  <Metric label="Avg position" value={stats.gsc.avgPosition7d ? stats.gsc.avgPosition7d.toFixed(1) : "—"}
                    sub={stats.gsc.avgPositionPrior7d ? `prior ${stats.gsc.avgPositionPrior7d.toFixed(1)}` : undefined}
                    href="/admin/rank-tracker" />
                </div>
                <div className="mt-4 grid gap-3 lg:grid-cols-2">
                  <WinnersLosers title="🟢 Top 5 Winners" rows={stats.gsc.winners} positive />
                  <WinnersLosers title="🔴 Top 5 Decliners" rows={stats.gsc.losers} positive={false} />
                </div>
              </Band>

              {/* ════ BAND 4 — Factory ════ */}
              <Band id="factory" header="⚙️ Content Factory" subtitle="Goal: 200 published pages/day.">
                <div className="grid gap-4 lg:grid-cols-3">
                  <div className="rounded-2xl border border-border bg-card p-4 lg:col-span-2">
                    <div className="flex items-baseline justify-between">
                      <div>
                        <div className="text-xs uppercase text-muted-foreground">Published</div>
                        <div className="text-3xl font-bold">{fmt(stats.contentPages.published)}</div>
                      </div>
                      <div className="text-xs text-muted-foreground">goal 200/day</div>
                    </div>
                    <Sparkline data={stats.contentPages.publishedPerDay} goal={200} />
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    <Metric label="Total" value={fmt(stats.contentPages.total)} compact />
                    <Metric label="Pending" value={fmt(stats.contentPages.pending)}
                      tone={stats.contentPages.pending > 2000 ? "warn" : "ok"} compact />
                    <Metric label="Last 24h" value={fmt(stats.contentPages.last24h)} compact />
                  </div>
                </div>

                {/* By template — sorted worst-first */}
                <div className="mt-4 overflow-x-auto rounded-xl border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-left text-xs uppercase">
                      <tr>
                        <th className="px-3 py-2">Template</th>
                        <th className="px-3 py-2 text-right">Total</th>
                        <th className="px-3 py-2 text-right">Published</th>
                        <th className="px-3 py-2 text-right">% done</th>
                        <th className="px-3 py-2 text-right">Pending</th>
                        <th className="px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...stats.byTemplate]
                        .sort((a, b) => pct(a.published, a.total) - pct(b.published, b.total))
                        .map((t) => {
                          const p = pct(t.published, t.total);
                          const stuck = t.total > 100 && p < 10;
                          return (
                            <tr key={t.template_type || "(none)"}
                              className={`border-t border-border ${stuck ? "bg-red-500/5" : ""}`}>
                              <td className="px-3 py-2 font-mono text-xs">{t.template_type || "(none)"}</td>
                              <td className="px-3 py-2 text-right">{fmt(t.total)}</td>
                              <td className="px-3 py-2 text-right">{fmt(t.published)}</td>
                              <td className={`px-3 py-2 text-right ${stuck ? "font-bold text-red-600" : ""}`}>{p}%</td>
                              <td className="px-3 py-2 text-right">{fmt(t.total - t.published)}</td>
                              <td className="px-3 py-2 text-right">
                                <PublishButton templateType={t.template_type || ""} disabled={t.total - t.published === 0} />
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>

                {/* Pending diagnostics */}
                <PendingDiagnosticsSection diagnostics={stats.pendingDiagnostics} />

                {/* Spanish */}
                <SpanishEngineSection spanish={stats.spanish} onQueued={load} />

                {/* Inventory */}
                <div className="mt-4">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Content inventory</h3>
                  <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    <Metric label="Blog" value={`${stats.blog.published}/${stats.blog.total}`} compact href="/admin/blog" />
                    <Metric label="Courses" value={`${stats.courses.published}/${stats.courses.total}`} compact href="/admin/learning" />
                    <Metric label="Help" value={`${stats.helpArticles.published}/${stats.helpArticles.total}`} compact />
                    <Metric label="Cities" value={`${stats.cities.published}/${stats.cities.total}`} compact href="/admin/cities-heroes" />
                    <Metric label="Providers" value={`${stats.providers.published}/${stats.providers.total}`} compact href="/admin/directory" />
                    <Metric label="Listings" value={fmt(stats.listings.total)} compact href="/admin/sharetribe-prune" />
                  </div>
                </div>

                {/* Health */}
                <div className="mt-4 rounded-xl border border-border bg-card p-4">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Health</h3>
                  <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <Metric label="Unresolved 404s" value={fmt(stats.missing404s.unresolved)}
                      sub={`${fmt(stats.missing404s.total)} total logged`}
                      tone={stats.missing404s.unresolved > 500 ? "danger" : stats.missing404s.unresolved > 10 ? "warn" : "ok"}
                      href="/admin/missing-pages" compact />
                    <Metric label="SEO health" value="open" href="/admin/seo-health" compact sub="View site issues" />
                  </div>
                </div>
              </Band>

              {/* ════ BAND 5 — Humans ════ */}
              <Band id="humans" header="👥 Humans Waiting On Me" subtitle="Anything red is past 48h.">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
                  <HumanCard label="Lead inbox" count={stats.leads.new} ageHours={stats.leads.oldestAgeHours} href="/admin/leads" />
                  <HumanCard label="Listing claims" count={stats.claims.pending} ageHours={stats.claims.oldestAgeHours} href="/admin/claims" />
                  <HumanCard label="Plan requests" count={stats.planRequests.pending} ageHours={stats.planRequests.oldestAgeHours} href="/admin/plan-requests" />
                  <HumanCard label="Directory mod" count={stats.providers.pending} ageHours={null} href="/admin/directory" />
                  <HumanCard label="Waitlist (7d)" count={stats.waitlist.last7d} ageHours={null} href="/admin/team" />
                </div>
              </Band>

              {/* ════ BAND 6 — Tools ════ */}
              <Band id="tools" header="🔧 All Tools" subtitle="Direct access when you need a specific tool.">
                <div className="grid gap-4 lg:grid-cols-2">
                  {ADMIN_NAV_GROUPS.filter((g) => g.label !== "Overview").map((g) => (
                    <div key={g.label} className="rounded-xl border border-border bg-card p-4">
                      <h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-muted-foreground">{g.label}</h3>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {g.items.map((it) => (
                          <Link key={it.to} to={it.to} className="group flex items-center gap-2.5 rounded-lg border border-border bg-background p-3 text-sm font-medium hover:border-primary hover:bg-primary/5">
                            <it.icon className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary" />
                            <span className="truncate">{it.label}</span>
                          </Link>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Band>
            </>
          )}

          {loading && !stats && <div className="mt-12 text-center text-sm text-muted-foreground">Loading…</div>}
        </>
      )}
    </AdminLayout>
  );
}

// ─── Reusable presentational components ──────────────────────────────────
function Band({ id, header, subtitle, children }: { id: string; header: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-8 scroll-mt-20 border-t border-border pt-6">
      <div className="mb-4">
        <h2 className="text-xl font-bold sm:text-2xl">{header}</h2>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function ActionCard({ action }: { action: Action }) {
  const sev = action.severity;
  const palette = sev === "critical" ? "border-red-500/40 bg-red-500/5"
    : sev === "important" ? "border-yellow-500/40 bg-yellow-500/5"
    : "border-emerald-500/40 bg-emerald-500/5";
  const badge = sev === "critical" ? "🚨 Critical" : sev === "important" ? "⚠️ Important" : "📈 Opportunity";
  const btn = sev === "critical" ? "bg-red-600 hover:bg-red-700"
    : sev === "important" ? "bg-yellow-600 hover:bg-yellow-700"
    : "bg-emerald-600 hover:bg-emerald-700";
  return (
    <div className={`flex flex-col rounded-2xl border-2 p-5 ${palette}`}>
      <span className="self-start rounded-full bg-background px-2 py-0.5 text-xs font-bold">{badge}</span>
      <h3 className="mt-3 text-lg font-bold leading-snug">{action.title}</h3>
      <p className="mt-1 flex-1 text-sm text-muted-foreground">{action.why}</p>
      <Link to={action.href as any} className={`mt-4 inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold text-white ${btn}`}>
        {action.cta} →
      </Link>
    </div>
  );
}

function Metric({ label, value, sub, delta, tone, href, compact, placeholder }: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  delta?: { value: number; positive: boolean } | null;
  tone?: "ok" | "warn" | "danger";
  href?: string;
  compact?: boolean;
  placeholder?: boolean;
}) {
  const toneCls = bandPaint(tone || "neutral");
  const inner = (
    <div className={`rounded-xl border p-4 ${toneCls} ${href ? "transition hover:border-primary" : ""} ${placeholder ? "border-dashed" : ""}`}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 ${compact ? "text-xl" : "text-2xl"} font-bold`}>{value}</div>
      {(sub || delta) && (
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          {delta && (
            <span className={`rounded px-1.5 py-0.5 font-semibold ${delta.positive ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-red-500/15 text-red-700 dark:text-red-300"}`}>
              {delta.positive ? "▲" : "▼"} {delta.value}%
            </span>
          )}
          {sub && <span>{sub}</span>}
        </div>
      )}
    </div>
  );
  return href ? <Link to={href as any} className="block">{inner}</Link> : inner;
}

function Sparkline({ data, goal }: { data: Array<{ date: string; count: number }>; goal: number }) {
  const max = Math.max(goal, ...data.map((d) => d.count), 1);
  return (
    <div className="mt-3">
      <div className="flex h-20 items-end gap-1">
        {data.map((d, i) => {
          const h = (d.count / max) * 100;
          const reached = d.count >= goal;
          return (
            <div key={i} className="flex flex-1 flex-col items-center gap-1">
              <div className={`w-full rounded-t ${reached ? "bg-emerald-500" : "bg-primary/60"}`} style={{ height: `${Math.max(h, 4)}%` }} title={`${d.date}: ${d.count}`} />
              <span className="text-[10px] text-muted-foreground">{d.date.slice(5)}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>last 7d published/day</span>
        <span>goal {goal}/day</span>
      </div>
    </div>
  );
}

function WinnersLosers({ title, rows, positive }: { title: string; rows: Array<{ url_path: string; clicks: number; delta: number }>; positive: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No data — import GSC.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border text-sm">
          {rows.map((r) => (
            <li key={r.url_path} className="flex items-center justify-between gap-2 py-2">
              <Link to={r.url_path as any} className="truncate font-mono text-xs hover:underline">{r.url_path}</Link>
              <div className="flex shrink-0 gap-2 text-xs">
                <span className="text-muted-foreground">{r.clicks} clicks</span>
                <span className={`font-semibold ${positive ? "text-emerald-600" : "text-red-600"}`}>
                  {r.delta > 0 ? "+" : ""}{r.delta}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HumanCard({ label, count, ageHours, href }: { label: string; count: number; ageHours: number | null; href: string }) {
  const tone = count === 0 ? "ok" : ageTone(ageHours);
  return (
    <Link to={href as any} className={`block rounded-xl border p-4 transition hover:border-primary ${bandPaint(tone)}`}>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold">{fmt(count)}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {count === 0 ? "all caught up" : ageHours != null ? `oldest ${ageLabel(ageHours)}` : "no age data"}
      </div>
    </Link>
  );
}

function PublishButton({ templateType, disabled }: { templateType: string; disabled: boolean }) {
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  async function go() {
    setBusy(true); setMsg(null);
    try {
      const r = await retryPendingTemplate({ data: { template_type: templateType, limit: 50 } });
      setMsg(`Queued ${r.retried}`);
    } catch (e: any) {
      setMsg(e?.message || "Failed");
    } finally { setBusy(false); }
  }
  return (
    <div className="flex items-center justify-end gap-2">
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      <button onClick={go} disabled={disabled || busy}
        className="rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-40">
        {busy ? "…" : "Publish next 50"}
      </button>
    </div>
  );
}

// ─── Existing sections (preserved) ───────────────────────────────────────
function PendingDiagnosticsSection({ diagnostics }: { diagnostics: DashboardStats["pendingDiagnostics"] }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [failedFor, setFailedFor] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState<FailedPage[] | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  if (!diagnostics || diagnostics.length === 0) return null;

  async function retry(t: string) {
    setBusy(t); setMsg(null);
    try {
      const r = await retryPendingTemplate({ data: { template_type: t, limit: 500 } });
      setMsg(`Re-queued ${r.retried} pending pages for ${t}.`);
    } catch (e: any) {
      setMsg(e?.message || "Retry failed");
    } finally { setBusy(null); }
  }
  async function viewFailed(t: string) {
    setBusy(t); setFailedFor(t); setFailed(null);
    try {
      const list = await listPendingFailures({ data: { template_type: t, limit: 100 } });
      setFailed(list);
    } catch (e: any) {
      setMsg(e?.message || "Load failed");
    } finally { setBusy(null); }
  }

  return (
    <div className="mt-6">
      <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Pending queue diagnostics</h3>
      {msg && <div className="mt-2 rounded border border-border bg-muted/30 p-2 text-xs">{msg}</div>}
      <div className="mt-3 space-y-3">
        {diagnostics.map((d) => (
          <div key={d.template_type || "(none)"} className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-mono text-sm font-bold">{d.template_type || "(none)"}</div>
                <div className="text-xs text-muted-foreground">
                  {d.pending} pending · {d.missing_body} missing body · {d.missing_title} missing title · {d.missing_meta} missing meta · {d.missing_slug} missing slug
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => retry(d.template_type || "")} disabled={busy === d.template_type} className="rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50">
                  {busy === d.template_type ? "…" : "Retry all pending"}
                </button>
                <button onClick={() => viewFailed(d.template_type || "")} className="rounded-full border border-border px-3 py-1.5 text-xs font-semibold">
                  View failed
                </button>
              </div>
            </div>
            {d.top_errors.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs">
                {d.top_errors.map((e, i) => (
                  <li key={i} className="flex gap-2"><span className="rounded bg-red-500/15 px-1.5 font-bold text-red-700 dark:text-red-300">{e.count}×</span><span className="text-muted-foreground">{e.reason}</span></li>
                ))}
              </ul>
            )}
            {failedFor === d.template_type && failed && (
              <div className="mt-3 max-h-64 overflow-auto rounded border border-border bg-background">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-left"><tr><th className="px-2 py-1">Slug</th><th className="px-2 py-1">Status</th><th className="px-2 py-1">Last error</th></tr></thead>
                  <tbody>
                    {failed.map((p) => (
                      <tr key={p.slug} className="border-t border-border">
                        <td className="px-2 py-1 font-mono">{p.slug}</td>
                        <td className="px-2 py-1">{p.status}</td>
                        <td className="px-2 py-1 text-muted-foreground">{p.last_error || "—"}</td>
                      </tr>
                    ))}
                    {failed.length === 0 && <tr><td colSpan={3} className="px-2 py-3 text-center text-muted-foreground">No pending pages.</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SpanishEngineSection({ spanish, onQueued }: { spanish: DashboardStats["spanish"]; onQueued: () => void }) {
  const [count, setCount] = React.useState(100);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  async function queue() {
    setBusy(true); setMsg(null);
    try {
      const r = await queueSpanishCityBatch({ data: { count } });
      setMsg(`Queued ${r.inserted} new Spanish city plan rows (skipped ${r.skipped} already covered).`);
      onQueued();
    } catch (e: any) {
      setMsg(e?.message || "Queue failed");
    } finally { setBusy(false); }
  }

  const queuedPct = spanish.cities_eligible > 0
    ? Math.round((spanish.cities_with_es / spanish.cities_eligible) * 100)
    : 0;

  return (
    <div className="mt-4 rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">Spanish content engine</h3>
        <span className="text-xs text-muted-foreground">{queuedPct}% city coverage</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4 text-sm">
        <div><div className="text-xs uppercase text-muted-foreground">Spanish pages</div><div className="font-bold">{spanish.pages_published}/{spanish.pages_total}</div></div>
        <div><div className="text-xs uppercase text-muted-foreground">Pending</div><div className="font-bold">{spanish.pages_pending}</div></div>
        <div><div className="text-xs uppercase text-muted-foreground">Plan rows pending</div><div className="font-bold">{spanish.plan_pending}</div></div>
        <div><div className="text-xs uppercase text-muted-foreground">Cities w/ ES</div><div className="font-bold">{spanish.cities_with_es}/{spanish.cities_eligible}</div></div>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-emerald-500" style={{ width: `${queuedPct}%` }} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted-foreground">Cities to queue:</label>
        <input type="number" min={1} max={500} value={count} onChange={(e) => setCount(Math.max(1, Math.min(500, Number(e.target.value) || 0)))} className="w-24 rounded border border-border bg-background px-2 py-1 text-sm" />
        <button onClick={queue} disabled={busy} className="rounded-full bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? "Queueing…" : "Generate Spanish city batch"}
        </button>
        <span className="text-xs text-muted-foreground">Sorted by population, skips existing.</span>
      </div>
      {msg && <div className="mt-2 text-xs">{msg}</div>}
    </div>
  );
}
