import * as React from "react";
import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { adminListPendingProviders, adminUpdateProvider, adminGenerateProviderContent, adminListProvidersMissingAI } from "@/server/directory.functions";
import { AdminLayout } from "@/components/admin-layout";

export const Route = createFileRoute("/admin/directory")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth", search: { redirect: "/admin/directory", mode: "signin" } });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({ meta: [{ title: "Directory Moderation — Admin" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: AdminDirectory,
});

type StatusFilter = "pending" | "all" | "approved" | "rejected";
type PlanFilter = "all" | "featured_active" | "paid_active" | "expiring_soon" | "expired" | "free";
type SortKey = "newest" | "name" | "paid_until" | "featured_until";

const DAY = 86_400_000;

function planBucket(p: any): PlanFilter {
  const now = Date.now();
  const fUntil = p.featured_until ? new Date(p.featured_until).getTime() : 0;
  const pUntil = p.listing_paid_until ? new Date(p.listing_paid_until).getTime() : 0;
  if (p.is_featured && fUntil > now) return "featured_active";
  if (pUntil > now) return "paid_active";
  if ((fUntil && fUntil <= now) || (pUntil && pUntil <= now)) return "expired";
  return "free";
}

function fmtDate(d: any) {
  return d ? new Date(d).toLocaleDateString() : "—";
}

function fmtRelative(d: any) {
  if (!d) return "";
  const diff = new Date(d).getTime() - Date.now();
  const days = Math.round(diff / DAY);
  if (days === 0) return "today";
  if (days > 0) return `in ${days}d`;
  return `${-days}d ago`;
}

type BulkResult = { id: string; name: string; ok: boolean; error?: string; ms: number };

function AdminDirectory() {
  const [rows, setRows] = React.useState<any[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<StatusFilter>("pending");
  const [planFilter, setPlanFilter] = React.useState<PlanFilter>("all");
  const [sort, setSort] = React.useState<SortKey>("newest");
  const [search, setSearch] = React.useState("");
  const [bulkRunning, setBulkRunning] = React.useState(false);
  const [bulkTotal, setBulkTotal] = React.useState(0);
  const [bulkDone, setBulkDone] = React.useState(0);
  const [bulkCurrent, setBulkCurrent] = React.useState<string>("");
  const [bulkResults, setBulkResults] = React.useState<BulkResult[]>([]);
  const bulkAbort = React.useRef<{ stop: boolean }>({ stop: false });
  const pageSize = 50;

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await adminListPendingProviders({ data: { page, pageSize, status: filter, search } });
      setRows(r.providers);
      setTotal(r.total);
    } finally { setLoading(false); }
  }, [page, filter, search]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => { setPage(1); }, [filter, search]);

  async function act(id: string, action: any) {
    setBusy(id + action);
    try {
      await adminUpdateProvider({ data: { id, action } });
      await load();
    } catch (e: any) { alert(e?.message || "Failed"); }
    finally { setBusy(null); }
  }

  const runBulk = React.useCallback(async (
    targets: { id: string; name: string; city?: string | null; state_code?: string | null }[],
  ) => {
    setBulkRunning(true);
    setBulkResults([]);
    setBulkDone(0);
    setBulkCurrent("");
    setBulkTotal(targets.length);
    bulkAbort.current.stop = false;
    try {
      for (const p of targets) {
        if (bulkAbort.current.stop) break;
        setBulkCurrent(`${p.name}${p.city ? ` — ${p.city}, ${p.state_code}` : ""}`);
        const t0 = Date.now();
        try {
          await adminGenerateProviderContent({ data: { id: p.id } });
          setBulkResults((prev) => [...prev, { id: p.id, name: p.name, ok: true, ms: Date.now() - t0 }]);
        } catch (e: any) {
          setBulkResults((prev) => [...prev, { id: p.id, name: p.name, ok: false, error: e?.message || "Failed", ms: Date.now() - t0 }]);
        }
        setBulkDone((n) => n + 1);
        await new Promise((r) => setTimeout(r, 600));
      }
      setBulkCurrent("");
      await load();
    } finally {
      setBulkRunning(false);
    }
  }, [load]);

  const now = Date.now();
  const visible = React.useMemo(() => {
    let list = rows;
    if (planFilter !== "all") {
      list = list.filter((r) => {
        if (planFilter === "expiring_soon") {
          const f = r.featured_until ? new Date(r.featured_until).getTime() : 0;
          const p = r.listing_paid_until ? new Date(r.listing_paid_until).getTime() : 0;
          const soon = (t: number) => t > now && t - now < 30 * DAY;
          return soon(f) || soon(p);
        }
        return planBucket(r) === planFilter;
      });
    }
    const cmp: Record<SortKey, (a: any, b: any) => number> = {
      newest: (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      name: (a, b) => (a.name || "").localeCompare(b.name || ""),
      paid_until: (a, b) =>
        (b.listing_paid_until ? new Date(b.listing_paid_until).getTime() : 0) -
        (a.listing_paid_until ? new Date(a.listing_paid_until).getTime() : 0),
      featured_until: (a, b) =>
        (b.featured_until ? new Date(b.featured_until).getTime() : 0) -
        (a.featured_until ? new Date(a.featured_until).getTime() : 0),
    };
    return [...list].sort(cmp[sort]);
  }, [rows, planFilter, sort, now]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <AdminLayout>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Directory moderation</h1>
            <p className="text-sm text-muted-foreground">Review and approve provider submissions.</p>
          </div>
          <Link to="/admin/dashboard" className="text-sm text-primary hover:underline">← Dashboard</Link>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {(["pending","approved","rejected","all"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${filter === f ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`}>
              {f}
            </button>
          ))}
          <Link to="/admin/scrape-import" className="rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold hover:bg-secondary">+ Scrape URL</Link>
          <Link to="/admin/gsc-import" className="rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold hover:bg-secondary">↑ Import GSC</Link>
          <button
            onClick={async () => {
              const limStr = prompt("How many providers to generate AI content for? (1-50)", "10");
              const limit = Math.max(1, Math.min(50, parseInt(limStr || "10", 10) || 10));
              const { providers } = await adminListProvidersMissingAI({ data: { limit } });
              if (providers.length === 0) { alert("No published providers are missing AI content."); return; }
              await runBulk(providers.map((p: any) => ({ id: p.id, name: p.name, city: p.city, state_code: p.state_code })));
            }}
            disabled={bulkRunning}
            className="rounded-full bg-primary text-primary-foreground px-3 py-1 text-xs font-semibold disabled:opacity-50"
          >
            {bulkRunning ? `Generating ${bulkDone}/${bulkTotal}…` : "✨ Bulk Gen AI"}
          </button>
          {bulkRunning && (
            <button onClick={() => { bulkAbort.current.stop = true; }} className="rounded-full border border-border bg-card px-3 py-1 text-xs">Stop</button>
          )}
          <button onClick={load} className="ml-auto rounded-full bg-card border border-border px-3 py-1 text-xs">Refresh</button>
        </div>

        {(bulkRunning || bulkResults.length > 0) && (
          <div className="mt-4 rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold">
                Bulk AI generation — {bulkDone}/{bulkTotal}
                {bulkResults.length > 0 && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {bulkResults.filter(r => r.ok).length} ok · {bulkResults.filter(r => !r.ok).length} failed
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                {!bulkRunning && bulkResults.some(r => !r.ok) && (
                  <button
                    onClick={() => {
                      const failed = bulkResults.filter(r => !r.ok).map(r => ({ id: r.id, name: r.name }));
                      void runBulk(failed);
                    }}
                    className="rounded-full bg-primary text-primary-foreground px-3 py-1 text-xs font-semibold"
                  >
                    ↻ Retry failed ({bulkResults.filter(r => !r.ok).length})
                  </button>
                )}
                {!bulkRunning && bulkResults.length > 0 && (
                  <button onClick={() => { setBulkResults([]); setBulkDone(0); setBulkTotal(0); }} className="text-xs text-muted-foreground hover:underline">Clear</button>
                )}
              </div>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${bulkTotal ? (bulkDone / bulkTotal) * 100 : 0}%` }}
              />
            </div>
            {bulkCurrent && <p className="mt-2 text-xs text-muted-foreground">Current: {bulkCurrent}</p>}
            {bulkResults.length > 0 && (
              <div className="mt-3 max-h-72 overflow-auto rounded border border-border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-secondary text-secondary-foreground">
                    <tr>
                      <th className="px-2 py-1 text-left">Provider</th>
                      <th className="px-2 py-1 text-left">Status</th>
                      <th className="px-2 py-1 text-right">Time</th>
                      <th className="px-2 py-1 text-left">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkResults.map((r) => (
                      <tr key={r.id} className="border-t border-border">
                        <td className="px-2 py-1">{r.name}</td>
                        <td className="px-2 py-1">
                          <span className={r.ok ? "text-green-600" : "text-destructive"}>{r.ok ? "✓ ok" : "✗ failed"}</span>
                        </td>
                        <td className="px-2 py-1 text-right text-muted-foreground">{(r.ms / 1000).toFixed(1)}s</td>
                        <td className="px-2 py-1 text-destructive">{r.error || ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase text-muted-foreground">Plan:</span>
          {([
            ["all","All"],
            ["featured_active","Featured active"],
            ["paid_active","Paid active"],
            ["expiring_soon","Expiring ≤30d"],
            ["expired","Expired"],
            ["free","Free"],
          ] as [PlanFilter, string][]).map(([key, label]) => (
            <button key={key} onClick={() => setPlanFilter(key)}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${planFilter === key ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`}>
              {label}
            </button>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, slug, city, email…"
            className="flex-1 min-w-[200px] rounded-lg border border-border bg-card px-3 py-1.5 text-sm"
          />
          <label className="text-xs font-semibold uppercase text-muted-foreground">Sort:</label>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm"
          >
            <option value="newest">Newest</option>
            <option value="name">Name (A–Z)</option>
            <option value="paid_until">Paid until (latest)</option>
            <option value="featured_until">Featured until (latest)</option>
          </select>
          <span className="text-xs text-muted-foreground">
            {total > 0 ? `${(page-1)*pageSize + 1}–${Math.min(page*pageSize, total)} of ${total}` : "0"}
          </span>
        </div>


        {loading ? (
          <p className="mt-8 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ul className="mt-6 space-y-3">
            {visible.map((p) => (
              <li key={p.id} className="rounded-2xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">{p.name}</h3>
                      <Badge tone={p.submission_status === "pending" ? "warn" : p.submission_status === "approved" ? "ok" : "danger"}>{p.submission_status}</Badge>
                      {p.is_published && <Badge tone="ok">published</Badge>}
                      {p.is_featured && <Badge tone="primary">featured</Badge>}
                      {p.plan && p.plan !== "free" && <Badge>{p.plan}</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {[p.primary_category, [p.city, p.state_code].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}
                    </p>
                    <p className="mt-2 max-w-2xl text-sm text-muted-foreground line-clamp-3">{p.description}</p>
                    <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                      {p.email && <span>📧 {p.email}</span>}
                      {p.phone && <span>📞 {p.phone}</span>}
                      {p.website_url && <a href={p.website_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">🔗 site</a>}
                      <a href={`/p/pool-pros/${p.slug}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">/p/pool-pros/{p.slug}</a>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-3 text-xs">
                      <TimestampPill label="Paid until" value={p.listing_paid_until} activeClass="text-green-700" />
                      <TimestampPill label="Featured until" value={p.featured_until} activeClass="text-primary" />
                      {(p.gsc_impressions || p.gsc_clicks) && (
                        <span className="text-muted-foreground" title={p.gsc_updated_at ? `Updated ${new Date(p.gsc_updated_at).toLocaleString()}` : undefined}>
                          GSC: {p.gsc_impressions ?? 0} impr · {p.gsc_clicks ?? 0} clk{p.gsc_position ? ` · pos ${Number(p.gsc_position).toFixed(1)}` : ""}
                        </span>
                      )}
                      {p.ai_content_generated_at && <span className="text-muted-foreground">AI ✓</span>}
                      {p.source_type && <span className="text-muted-foreground">src: {p.source_type}</span>}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {p.submission_status === "pending" && (
                      <>
                        <Btn onClick={() => act(p.id, "approve")} busy={busy === p.id + "approve"} tone="ok">Approve & publish</Btn>
                        <Btn onClick={() => act(p.id, "reject")} busy={busy === p.id + "reject"} tone="danger">Reject</Btn>
                      </>
                    )}
                    {p.submission_status === "approved" && (
                      <>
                        {p.is_published
                          ? <Btn onClick={() => act(p.id, "unpublish")} busy={busy === p.id + "unpublish"}>Unpublish</Btn>
                          : <Btn onClick={() => act(p.id, "publish")} busy={busy === p.id + "publish"} tone="ok">Publish</Btn>}
                        <Btn onClick={() => act(p.id, "mark_paid")} busy={busy === p.id + "mark_paid"} tone="ok">Mark paid ($5/yr)</Btn>
                        {p.listing_paid_until && <Btn onClick={() => act(p.id, "mark_unpaid")} busy={busy === p.id + "mark_unpaid"}>Mark unpaid</Btn>}
                        {p.is_featured
                          ? <Btn onClick={() => act(p.id, "unfeature")} busy={busy === p.id + "unfeature"}>Unfeature</Btn>
                          : <Btn onClick={() => act(p.id, "feature")} busy={busy === p.id + "feature"} tone="primary">Feature ($25/yr)</Btn>}
                      </>
                    )}
                    <Btn onClick={async () => { setBusy(p.id+"ai"); try { await adminGenerateProviderContent({ data: { id: p.id }}); await load(); } catch(e:any){ alert(e?.message||"AI failed"); } finally { setBusy(null); } }} busy={busy === p.id + "ai"} tone="primary">{p.ai_content_generated_at ? "↻ Regen AI" : "✨ Gen AI content"}</Btn>
                    <Btn onClick={() => { if (confirm("Delete this listing?")) act(p.id, "delete"); }} busy={busy === p.id + "delete"} tone="danger">Delete</Btn>
                  </div>
                </div>
              </li>
            ))}
            {visible.length === 0 && <p className="text-sm text-muted-foreground">Nothing here.</p>}
          </ul>
        )}

        {totalPages > 1 && (
          <div className="mt-6 flex items-center justify-center gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p-1))} disabled={page <= 1}
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm disabled:opacity-40">← Prev</button>
            <span className="text-sm text-muted-foreground">Page {page} / {totalPages}</span>
            <button onClick={() => setPage((p) => Math.min(totalPages, p+1))} disabled={page >= totalPages}
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm disabled:opacity-40">Next →</button>
          </div>
        )}
      </AdminLayout>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone?: "ok" | "warn" | "danger" | "primary" }) {
  const cls = tone === "ok" ? "bg-green-500/15 text-green-700"
    : tone === "warn" ? "bg-yellow-500/15 text-yellow-700"
    : tone === "danger" ? "bg-red-500/15 text-red-700"
    : tone === "primary" ? "bg-primary text-primary-foreground"
    : "bg-secondary text-secondary-foreground";
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${cls}`}>{children}</span>;
}

function TimestampPill({ label, value, activeClass }: { label: string; value: string | null | undefined; activeClass: string }) {
  const [copied, setCopied] = React.useState(false);
  const isActive = !!value && new Date(value) > new Date();
  const iso = value ? new Date(value).toISOString() : "";
  async function copy() {
    if (!iso) return;
    try { await navigator.clipboard.writeText(iso); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch {}
  }
  return (
    <span className={`inline-flex items-center gap-1 ${isActive ? activeClass : "text-muted-foreground"}`}>
      <span title={iso || "—"}>
        {label}: {fmtDate(value)}
        {value && <span className="ml-1 opacity-70">({fmtRelative(value)})</span>}
      </span>
      {value && (
        <button
          type="button"
          onClick={copy}
          title={`Copy ISO-8601: ${iso}`}
          className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-mono hover:bg-secondary"
        >
          {copied ? "✓" : "copy"}
        </button>
      )}
    </span>
  );
}

function Btn({ children, onClick, busy, tone }: { children: React.ReactNode; onClick: () => void; busy?: boolean; tone?: "ok" | "danger" | "primary" }) {
  const cls = tone === "ok" ? "bg-green-600 text-white"
    : tone === "danger" ? "bg-red-600 text-white"
    : tone === "primary" ? "bg-primary text-primary-foreground"
    : "bg-secondary text-secondary-foreground";
  return <button onClick={onClick} disabled={busy} className={`rounded-full px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${cls}`}>{busy ? "…" : children}</button>;
}
