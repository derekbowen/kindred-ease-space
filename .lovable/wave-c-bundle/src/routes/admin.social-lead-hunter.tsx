import * as React from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import {
  listSocialLeads, runSocialLeadHuntNow, setSocialLeadContacted, updateSocialLeadNotes, deleteSocialLead,
  type SocialLeadRow,
} from "@/server/social-lead-hunter.functions";
import { AdminLayout } from "@/components/admin-layout";
import { Loader2, RefreshCw, ExternalLink, Trash2, Search, Radar } from "lucide-react";

const SOURCES = ["all", "ig", "fb", "tiktok", "nextdoor", "craigslist", "youtube"] as const;
type SourceTab = typeof SOURCES[number];

const SOURCE_LABELS: Record<SourceTab, string> = {
  all: "All",
  ig: "Instagram",
  fb: "Facebook",
  tiktok: "TikTok",
  nextdoor: "Nextdoor",
  craigslist: "Craigslist",
  youtube: "YouTube",
};

export const Route = createFileRoute("/admin/social-lead-hunter")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth", search: { redirect: "/admin/social-lead-hunter", mode: "signin" } });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({ meta: [{ title: "Social Lead Hunter — Admin" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: SocialLeadHunter,
});

function SocialLeadHunter() {
  const [rows, setRows] = React.useState<SocialLeadRow[]>([]);
  const [source, setSource] = React.useState<SourceTab>("all");
  const [filter, setFilter] = React.useState<"new" | "contacted" | "all">("new");
  const [loading, setLoading] = React.useState(true);
  const [running, setRunning] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");

  async function load() {
    setLoading(true);
    try {
      const r: any = await listSocialLeads({ data: { source, filter, limit: 400 } });
      if (r.ok) setRows(r.rows);
      else setMsg(r.error || "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => { load(); }, [source, filter]);

  async function runHunt(only?: Exclude<SourceTab, "all">) {
    setRunning(true); setMsg(null);
    try {
      const sources = only ? [only] : (source === "all" ? undefined : [source as Exclude<SourceTab, "all">]);
      const r: any = await runSocialLeadHuntNow({ data: { sources } });
      const summary = Object.entries(r.by_source || {})
        .map(([s, v]: any) => `${s}: +${v.inserted}/~${v.refreshed}`)
        .join(" · ");
      setMsg(`Done. ${r.inserted} new, ${r.refreshed} refreshed. ${summary}`);
      await load();
    } catch (e: any) {
      setMsg(`Failed: ${e?.message || "unknown"}`);
    } finally {
      setRunning(false);
    }
  }

  async function toggle(row: SocialLeadRow) {
    const next = !row.contacted;
    setRows((r) => r.map((x) => x.id === row.id ? { ...x, contacted: next } : x));
    await setSocialLeadContacted({ data: { id: row.id, contacted: next } });
    if (filter !== "all") load();
  }

  async function remove(row: SocialLeadRow) {
    if (!confirm(`Delete ${row.handle ? "@" + row.handle : "this lead"}?`)) return;
    await deleteSocialLead({ data: { id: row.id } });
    setRows((r) => r.filter((x) => x.id !== row.id));
  }

  async function saveNotes(row: SocialLeadRow, notes: string) {
    setRows((r) => r.map((x) => x.id === row.id ? { ...x, notes } : x));
    await updateSocialLeadNotes({ data: { id: row.id, notes } });
  }

  const filtered = search.trim()
    ? rows.filter((r) =>
        (r.handle || "").toLowerCase().includes(search.toLowerCase()) ||
        (r.display_name || "").toLowerCase().includes(search.toLowerCase()) ||
        (r.title || "").toLowerCase().includes(search.toLowerCase()) ||
        (r.snippet || "").toLowerCase().includes(search.toLowerCase()))
    : rows;

  const totalNew = rows.filter((r) => !r.contacted).length;

  return (
    <AdminLayout>
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <Radar className="h-6 w-6" /> Social Lead Hunter
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Google search across Instagram, Facebook, TikTok, Nextdoor, Craigslist, and YouTube for pool-rental signals.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => runHunt()}
              disabled={running}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
            >
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {source === "all" ? "Run all sources" : `Run ${SOURCE_LABELS[source]}`}
            </button>
          </div>
        </header>

        {msg && <div className="rounded-md border bg-muted/50 px-3 py-2 text-sm">{msg}</div>}

        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex flex-wrap rounded-md border p-1">
            {SOURCES.map((s) => (
              <button
                key={s}
                onClick={() => setSource(s)}
                className={`rounded px-3 py-1 text-sm ${source === s ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              >
                {SOURCE_LABELS[s]}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-md border p-1">
            {(["new", "contacted", "all"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded px-3 py-1 text-sm capitalize ${filter === f ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              >
                {f}{f === "new" ? ` (${totalNew})` : ""}
              </button>
            ))}
          </div>
          <div className="relative ml-auto">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by handle, name, title, snippet…"
              className="w-72 rounded-md border bg-background py-2 pl-8 pr-3 text-sm"
            />
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading leads…</div>
        ) : filtered.length === 0 ? (
          <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
            No leads. Click <strong>Run</strong> to fetch fresh results.
          </div>
        ) : (
          <ul className="divide-y rounded-md border">
            {filtered.map((row) => (
              <li key={row.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:gap-4">
                <label className="flex shrink-0 items-center gap-2 pt-1">
                  <input
                    type="checkbox"
                    checked={row.contacted}
                    onChange={() => toggle(row)}
                    className="h-4 w-4 cursor-pointer accent-primary"
                  />
                </label>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">{row.source}</span>
                    <a
                      href={row.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                    >
                      {row.handle ? `@${row.handle}` : (row.title || row.source_url)}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    {row.profile_url && row.profile_url !== row.source_url && (
                      <a
                        href={row.profile_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-muted-foreground hover:underline"
                      >
                        profile
                      </a>
                    )}
                    {row.display_name && row.display_name !== row.handle && (
                      <span className="text-sm text-muted-foreground line-clamp-1">{row.display_name}</span>
                    )}
                    {row.contacted && row.contacted_at && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        Contacted {new Date(row.contacted_at).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  {row.snippet && (
                    <p className="mt-1 text-sm text-muted-foreground line-clamp-3">{row.snippet}</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {row.location_hint && <span className="rounded bg-muted px-1.5 py-0.5">{row.location_hint}</span>}
                    {row.query && <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{row.query}</span>}
                    <span>seen {new Date(row.last_seen_at).toLocaleDateString()}</span>
                  </div>
                  <textarea
                    defaultValue={row.notes || ""}
                    onBlur={(e) => {
                      if (e.target.value !== (row.notes || "")) saveNotes(row, e.target.value);
                    }}
                    placeholder="Outreach notes…"
                    className="mt-2 w-full rounded border bg-background px-2 py-1 text-xs"
                    rows={1}
                  />
                </div>
                <button
                  onClick={() => remove(row)}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title="Delete lead"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AdminLayout>
  );
}
