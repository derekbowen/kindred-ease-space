import * as React from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";
import {
  listContentPages,
  bulkUpdateContentPages,
  getContentPage,
  updateContentPage,
  appendAiContentToPage,
  generateFullPageContent,
  improvePageContent,
  generateSeoMeta,
  generateSectionPreset,
  SECTION_PRESETS,
  autoFixSeo,
  enqueueSeoFixJobs,
  processSeoFixQueue,
  getSeoJobStatus,
  listSectionPresets,
  saveSectionPreset,
  deleteSectionPreset,
  generateCustomSection,
  type ContentPageRow,
  type ContentPageFull,
  type CustomSectionPreset,
} from "@/server/admin-tools.functions";

export const Route = createFileRoute("/admin/content-pages")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return;
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth", search: { redirect: "/admin/content-pages", mode: "signin" } });
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({ meta: [{ title: "Bulk page editor — Admin" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: BulkEditor,
});

function BulkEditor() {
  const [q, setQ] = React.useState("");
  const [status, setStatus] = React.useState<"all" | "published" | "pending" | "draft" | "scraped">("all");
  const [template, setTemplate] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState<number>(50);
  const [rows, setRows] = React.useState<ContentPageRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await listContentPages({ data: { q, status, template, page, pageSize } });
      setRows(r.rows); setTotal(r.total);
    } finally { setLoading(false); }
  }, [q, status, template, page, pageSize]);
  React.useEffect(() => { void load(); }, [load]);

  function toggle(id: string) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSelected((s) => s.size === rows.length ? new Set() : new Set(rows.map((r) => r.id)));
  }

  const [fixProgress, setFixProgress] = React.useState<{ done: number; failed: number; total: number } | null>(null);

  async function bulkAutoFix() {
    if (!selected.size) return;
    const ids = Array.from(selected);
    if (!confirm(`Auto-fix SEO on ${ids.length} page${ids.length > 1 ? "s" : ""}? This runs in the background via a queue. Overwrites focus keyword, SEO/OG fields, and may rewrite thin bodies. Uses AI credits.`)) return;
    setBusy(true);
    setFixProgress({ done: 0, failed: 0, total: ids.length });
    try {
      // Enqueue in chunks of 500 (server validator cap)
      let batchId: string | undefined;
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const r: any = await enqueueSeoFixJobs({ data: { pageIds: chunk, mode: "full" } });
        if (!r?.ok) throw new Error(r?.error || "Failed to enqueue");
        if (!batchId) batchId = r.batchId;
      }
      if (!batchId) throw new Error("No batch created");
      // Drain the queue, polling status between passes
      // Each pass processes up to 10 jobs server-side
      let safety = 0;
      while (safety++ < 1000) {
        await processSeoFixQueue({ data: { batchId, max: 10 } });
        const status: any = await getSeoJobStatus({ data: { batchId } });
        const s = status?.summary || {};
        setFixProgress({ done: s.done || 0, failed: s.failed || 0, total: ids.length });
        if (((s.queued || 0) + (s.processing || 0)) === 0) break;
      }
      const status: any = await getSeoJobStatus({ data: { batchId } });
      const s = status?.summary || {};
      alert(`Auto-fix complete. Done: ${s.done || 0}, failed: ${s.failed || 0}, cancelled: ${s.cancelled || 0}.`);
      setSelected(new Set());
      await load();
    } catch (e) {
      alert(`Auto-fix error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setFixProgress(null);
    }
  }

  async function bulk(action: "publish" | "unpublish" | "delete") {
    if (!selected.size) return;
    if (action === "delete" && !confirm(`Delete ${selected.size} pages?`)) return;
    setBusy(true);
    try {
      const r: any = await bulkUpdateContentPages({ data: { ids: Array.from(selected), action } });
      if (action === "publish" && r?.ok) {
        const skipped = r.skipped ?? 0;
        const count = r.count ?? 0;
        if (skipped > 0) {
          const sample = (r.skippedSlugs || []).slice(0, 5).join(", ");
          const more = (r.skippedSlugs || []).length > 5 ? ` (+${r.skippedSlugs.length - 5} more)` : "";
          alert(`Published ${count}. Kept ${skipped} as draft (fewer than 300 words):\n${sample}${more}`);
        }
      }
      setSelected(new Set());
      await load();
    } finally { setBusy(false); }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <AdminLayout title="Bulk page editor">
      <h1 className="text-3xl font-bold">Bulk page editor</h1>
      <p className="text-sm text-muted-foreground">Filter, select, and bulk-update /p/* pages. Click <span className="font-medium">Edit</span> on any row to add content with AI or edit manually.</p>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search url or title…"
          className="w-64 rounded-md border border-border bg-background px-3 py-1.5 text-sm" />
        <select value={status} onChange={(e) => { setStatus(e.target.value as any); setPage(1); }}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm">
          <option value="all">All status</option>
          <option value="published">Published</option>
          <option value="draft">Unpublished (draft)</option>
          <option value="pending">Pending</option>
          <option value="scraped">Scraped</option>
        </select>
        <input value={template} onChange={(e) => { setTemplate(e.target.value); setPage(1); }} placeholder="Template type…"
          className="w-48 rounded-md border border-border bg-background px-3 py-1.5 text-sm" />
        <select
          value={pageSize}
          onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
          title="Rows per page"
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
        >
          {[50, 100, 250, 500, 1000].map((n) => (
            <option key={n} value={n}>{n} / page</option>
          ))}
        </select>
        <span className="ml-auto text-sm text-muted-foreground">{total.toLocaleString()} total</span>
      </div>

      {selected.size > 0 && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <button disabled={busy} onClick={bulkAutoFix} title="Queue Auto-fix SEO on all selected pages" className="ml-auto rounded bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-50">{fixProgress ? `Fixing ${fixProgress.done + fixProgress.failed}/${fixProgress.total}…` : `✨ Fix ${selected.size}`}</button>
          <button disabled={busy} onClick={() => bulk("publish")} className="rounded bg-green-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">Publish</button>
          <button disabled={busy} onClick={() => bulk("unpublish")} className="rounded bg-yellow-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">Unpublish</button>
          <button disabled={busy} onClick={() => bulk("delete")} className="rounded bg-red-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">Delete</button>
          <button onClick={() => setSelected(new Set())} className="rounded border border-border px-3 py-1 text-xs">Clear</button>
        </div>
      )}

      <div className="mt-4 overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase">
            <tr>
              <th className="px-3 py-2"><input type="checkbox" checked={rows.length > 0 && selected.size === rows.length} onChange={toggleAll} /></th>
              <th className="px-3 py-2">URL</th>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Template</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Words</th>
              <th className="px-3 py-2 text-right">Updated</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-3 py-2"><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                <td className="px-3 py-2 font-mono text-xs"><a href={r.url_path || "#"} target="_blank" rel="noreferrer" className="hover:underline">{r.url_path}</a></td>
                <td className="px-3 py-2 max-w-xs truncate">{r.title || "—"}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{r.template_type || "—"}</td>
                <td className="px-3 py-2"><span className={`rounded px-1.5 py-0.5 text-xs ${r.status === "published" ? "bg-green-500/20 text-green-700 dark:text-green-300" : "bg-yellow-500/20 text-yellow-700 dark:text-yellow-300"}`}>{r.status}</span></td>
                <td className="px-3 py-2 text-right">{r.words}</td>
                <td className="px-3 py-2 text-right text-xs text-muted-foreground">{new Date(r.updated_at).toLocaleDateString()}</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => setEditingId(r.id)} className="rounded border border-border px-2 py-1 text-xs hover:bg-muted">Edit</button>
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">No matches.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Page {page} of {totalPages}</span>
        <div className="flex gap-2">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border border-border px-3 py-1 disabled:opacity-50">← Prev</button>
          <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded border border-border px-3 py-1 disabled:opacity-50">Next →</button>
        </div>
      </div>

      {editingId && (
        <PageEditorModal
          id={editingId}
          onClose={() => setEditingId(null)}
          onSaved={() => { void load(); }}
        />
      )}
    </AdminLayout>
  );
}

function PageEditorModal({ id, onClose, onSaved }: { id: string; onClose: () => void; onSaved: () => void }) {
  const [page, setPage] = React.useState<ContentPageFull | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [aiBusy, setAiBusy] = React.useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = React.useState("");
  const [aiAppend, setAiAppend] = React.useState(true);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<
    | null
    | { kind: "body"; markdown: string; label: string }
    | { kind: "meta"; seo_title: string; seo_description: string; og_title: string; og_description: string }
    | { kind: "section"; markdown: string; label: string }
  >(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await getContentPage({ data: { id } });
        if (cancelled) return;
        if (r.ok) setPage(r.page);
        else setErr(r.error);
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [id]);

  async function save() {
    if (!page) return;
    setSaving(true); setMsg(null); setErr(null);
    try {
      const r = await updateContentPage({
        data: {
          id: page.id,
          title: page.title ?? undefined,
          seo_title: page.seo_title ?? undefined,
          seo_description: page.seo_description ?? undefined,
          og_title: page.og_title ?? null,
          og_description: page.og_description ?? null,
          focus_keyword: page.focus_keyword ?? null,
          canonical_override: page.canonical_override ?? null,
          hero_image_url: page.hero_image_url ?? null,
          body_markdown: page.body_markdown ?? undefined,
          status: page.status as any,
        },
      });
      if (r.ok) { setMsg("Saved."); onSaved(); }
      else setErr(r.error || "Save failed");
    } finally { setSaving(false); }
  }

  async function runSection(presetKeyOrPrompt: { presetKey: string } | { prompt: string }) {
    if (!page) return;
    setAiBusy("section"); setMsg(null); setErr(null); setPreview(null);
    try {
      if ("presetKey" in presetKeyOrPrompt) {
        const r = await generateSectionPreset({ data: { id: page.id, preset_key: presetKeyOrPrompt.presetKey } });
        if (r.ok) {
          const label = SECTION_PRESETS.find((p) => p.key === presetKeyOrPrompt.presetKey)?.label ?? "Section";
          setPreview({ kind: "section", markdown: r.markdown, label });
        } else setErr(r.error);
      } else {
        const r = await appendAiContentToPage({ data: { id: page.id, prompt: presetKeyOrPrompt.prompt, append: aiAppend } });
        if (r.ok) {
          setPage({ ...page, body_markdown: r.body_markdown });
          setAiPrompt("");
          setMsg(aiAppend ? "Section appended and saved." : "Body replaced and saved.");
          onSaved();
        } else setErr(r.error);
      }
    } finally { setAiBusy(null); }
  }

  async function runFullPage() {
    if (!page) return;
    setAiBusy("full"); setMsg(null); setErr(null); setPreview(null);
    try {
      const r = await generateFullPageContent({ data: { id: page.id } });
      if (r.ok) setPreview({ kind: "body", markdown: r.body_markdown, label: "Generated full page" });
      else setErr(r.error);
    } finally { setAiBusy(null); }
  }

  async function runImprove() {
    if (!page) return;
    setAiBusy("improve"); setMsg(null); setErr(null); setPreview(null);
    try {
      const r = await improvePageContent({ data: { id: page.id } });
      if (r.ok) setPreview({ kind: "body", markdown: r.body_markdown, label: "Improved page" });
      else setErr(r.error);
    } finally { setAiBusy(null); }
  }

  async function runMeta() {
    if (!page) return;
    setAiBusy("meta"); setMsg(null); setErr(null); setPreview(null);
    try {
      const r = await generateSeoMeta({ data: { id: page.id } });
      if (r.ok) setPreview({ kind: "meta", seo_title: r.seo_title, seo_description: r.seo_description, og_title: r.og_title, og_description: r.og_description });
      else setErr(r.error);
    } finally { setAiBusy(null); }
  }

  async function runAutoFix() {
    if (!page) return;
    if (!confirm("Auto-fix SEO will overwrite focus keyword, SEO title/description, OG fields — and may rewrite the body if it's thin or under-linked. Continue?")) return;
    setAiBusy("autofix"); setMsg(null); setErr(null); setPreview(null);
    try {
      const r = await autoFixSeo({ data: { id: page.id } });
      if (r.ok) {
        setPage({ ...page, ...r.page });
        setMsg(`Auto-fix saved. Updated: ${r.changed.join(", ")}.`);
        onSaved();
      } else setErr(r.error);
    } finally { setAiBusy(null); }
  }

  // ─── Custom AI section presets ─────────────────────────────────────────────
  const [customPresets, setCustomPresets] = React.useState<CustomSectionPreset[]>([]);
  const [presetMgrOpen, setPresetMgrOpen] = React.useState(false);
  const [editingPreset, setEditingPreset] = React.useState<{ id?: string; label: string; prompt: string }>({ label: "", prompt: "" });

  const loadPresets = React.useCallback(async () => {
    try { const r = await listSectionPresets(); setCustomPresets(r.rows); } catch {/* ignore */}
  }, []);
  React.useEffect(() => { void loadPresets(); }, [loadPresets]);

  async function runCustomPreset(presetId: string) {
    if (!page) return;
    setAiBusy("section"); setMsg(null); setErr(null); setPreview(null);
    try {
      const r = await generateCustomSection({ data: { id: page.id, preset_id: presetId } });
      if (r.ok) setPreview({ kind: "section", markdown: r.markdown, label: r.label });
      else setErr(r.error);
    } finally { setAiBusy(null); }
  }

  async function savePreset() {
    if (!editingPreset.label.trim() || editingPreset.prompt.trim().length < 5) {
      setErr("Label and prompt are required (prompt at least 5 chars)."); return;
    }
    const r = await saveSectionPreset({ data: { id: editingPreset.id, label: editingPreset.label.trim(), prompt: editingPreset.prompt.trim(), sort_order: 0 } });
    if (r.ok) { setEditingPreset({ label: "", prompt: "" }); await loadPresets(); }
    else setErr(r.error);
  }

  async function removePreset(id: string) {
    if (!confirm("Delete this custom prompt?")) return;
    const r = await deleteSectionPreset({ data: { id } });
    if (r.ok) await loadPresets();
    else setErr(r.error);
  }
  function acceptPreview() {
    if (!page || !preview) return;
    if (preview.kind === "body") {
      setPage({ ...page, body_markdown: preview.markdown });
    } else if (preview.kind === "section") {
      const next = aiAppend
        ? `${(page.body_markdown ?? "").trimEnd()}\n\n${preview.markdown}\n`
        : preview.markdown;
      setPage({ ...page, body_markdown: next });
    } else if (preview.kind === "meta") {
      setPage({
        ...page,
        seo_title: preview.seo_title,
        seo_description: preview.seo_description,
        og_title: preview.og_title,
        og_description: preview.og_description,
      });
    }
    setPreview(null);
    setMsg("Applied. Don't forget to click Save changes.");
  }

  // ── SEO score calculations ───────────────────────────────────────────────
  const score = React.useMemo(() => {
    if (!page) return null;
    const body = page.body_markdown ?? "";
    const wordCount = body.split(/\s+/).filter(Boolean).length;
    const titleLen = (page.seo_title ?? "").length;
    const descLen = (page.seo_description ?? "").length;
    const fk = (page.focus_keyword ?? "").trim().toLowerCase();
    const hasH1 = !!(page.title && page.title.trim());
    const internalLinks = (body.match(/\]\(\/[^)]+\)/g) ?? []).length;
    const fkInTitle = !!fk && (page.seo_title ?? "").toLowerCase().includes(fk);
    const fkInDesc = !!fk && (page.seo_description ?? "").toLowerCase().includes(fk);
    const fkInBody = !!fk && body.slice(0, 800).toLowerCase().includes(fk);
    return { wordCount, titleLen, descLen, fk, hasH1, internalLinks, fkInTitle, fkInDesc, fkInBody };
  }, [page]);

  function ScoreRow({ ok, warn, label }: { ok: boolean; warn?: boolean; label: string }) {
    const cls = ok ? "text-green-600" : warn ? "text-amber-600" : "text-red-600";
    const icon = ok ? "✓" : warn ? "⚠" : "✗";
    return <div className={`flex items-start gap-1.5 text-xs ${cls}`}><span className="font-bold">{icon}</span><span>{label}</span></div>;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <h2 className="text-lg font-semibold">Edit page</h2>
            {page && <p className="font-mono text-xs text-muted-foreground">{page.url_path}</p>}
          </div>
          <div className="flex items-center gap-2">
            {page?.url_path && (
              <a href={page.url_path} target="_blank" rel="noreferrer" className="rounded border border-border px-3 py-1 text-xs hover:bg-muted">Open page ↗</a>
            )}
            <button onClick={onClose} className="rounded border border-border px-3 py-1 text-xs hover:bg-muted">Close</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {err && <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{err}</div>}
          {msg && <div className="mb-3 rounded border border-green-500/40 bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-300">{msg}</div>}

          {page && (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_240px]">
              {/* LEFT — fields */}
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <label className="text-sm">
                    <span className="mb-1 block font-medium">Title (H1)</span>
                    <input value={page.title || ""} onChange={(e) => setPage({ ...page, title: e.target.value })}
                      className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm" />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block font-medium">Status</span>
                    <select value={page.status} onChange={(e) => setPage({ ...page, status: e.target.value })}
                      className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm">
                      <option value="draft">draft</option>
                      <option value="pending">pending</option>
                      <option value="published">published</option>
                    </select>
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block font-medium">SEO title <span className="text-xs text-muted-foreground">(50–60)</span></span>
                    <input value={page.seo_title || ""} onChange={(e) => setPage({ ...page, seo_title: e.target.value })}
                      className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm" />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block font-medium">SEO description <span className="text-xs text-muted-foreground">(140–155)</span></span>
                    <input value={page.seo_description || ""} onChange={(e) => setPage({ ...page, seo_description: e.target.value })}
                      className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm" />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block font-medium">OG title <span className="text-xs text-muted-foreground">(social share)</span></span>
                    <input value={page.og_title || ""} onChange={(e) => setPage({ ...page, og_title: e.target.value })}
                      placeholder="Falls back to SEO title"
                      className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm" />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block font-medium">OG description <span className="text-xs text-muted-foreground">(social share)</span></span>
                    <input value={page.og_description || ""} onChange={(e) => setPage({ ...page, og_description: e.target.value })}
                      placeholder="Falls back to SEO description"
                      className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm" />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block font-medium">Hero / OG image URL</span>
                    <input value={page.hero_image_url || ""} onChange={(e) => setPage({ ...page, hero_image_url: e.target.value })}
                      placeholder="https://…/image.jpg"
                      className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm" />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block font-medium">Focus keyword</span>
                    <input value={page.focus_keyword || ""} onChange={(e) => setPage({ ...page, focus_keyword: e.target.value })}
                      placeholder="e.g. pool rental Los Angeles"
                      className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm" />
                  </label>
                  <label className="text-sm md:col-span-2">
                    <span className="mb-1 block font-medium">Canonical URL override <span className="text-xs text-muted-foreground">(rare)</span></span>
                    <input value={page.canonical_override || ""} onChange={(e) => setPage({ ...page, canonical_override: e.target.value })}
                      placeholder="Leave empty unless this page should canonical to a different URL"
                      className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm" />
                  </label>
                </div>

                {/* AI tools */}
                <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
                  <div className="mb-2 text-sm font-semibold">AI tools</div>
                  <div className="flex flex-wrap gap-2">
                    <button disabled={!!aiBusy} onClick={runFullPage}
                      className="rounded bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50">
                      {aiBusy === "full" ? "Generating…" : "✨ Generate full page"}
                    </button>
                    <button disabled={!!aiBusy} onClick={runImprove}
                      className="rounded border border-primary px-3 py-1.5 text-xs font-semibold text-primary disabled:opacity-50">
                      {aiBusy === "improve" ? "Improving…" : "🪄 Improve this page"}
                    </button>
                    <button disabled={!!aiBusy} onClick={runMeta}
                      className="rounded border border-primary px-3 py-1.5 text-xs font-semibold text-primary disabled:opacity-50">
                      {aiBusy === "meta" ? "Generating…" : "🏷️ Generate SEO meta"}
                    </button>
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">Each shows a preview before changing your page. Click Save changes to persist.</p>
                </div>

                {/* Preview pane */}
                {preview && (
                  <div className="rounded-lg border border-amber-500/50 bg-amber-50 p-3 dark:bg-amber-950/30">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-sm font-semibold">
                        Preview: {preview.kind === "meta" ? "SEO metadata" : preview.kind === "body" ? preview.label : `Section — ${preview.label}`}
                      </span>
                      <div className="flex gap-2">
                        <button onClick={acceptPreview}
                          className="rounded bg-green-600 px-3 py-1 text-xs font-semibold text-white hover:bg-green-700">
                          Accept
                        </button>
                        <button onClick={() => setPreview(null)}
                          className="rounded border border-border px-3 py-1 text-xs hover:bg-muted">
                          Reject
                        </button>
                      </div>
                    </div>
                    {preview.kind === "meta" ? (
                      <div className="space-y-1.5 text-xs">
                        <div><span className="font-semibold">SEO title:</span> {preview.seo_title}</div>
                        <div><span className="font-semibold">SEO description:</span> {preview.seo_description}</div>
                        <div><span className="font-semibold">OG title:</span> {preview.og_title}</div>
                        <div><span className="font-semibold">OG description:</span> {preview.og_description}</div>
                      </div>
                    ) : (
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-background p-2 font-mono text-[11px]">{preview.markdown}</pre>
                    )}
                  </div>
                )}

                {/* Add a section — preset chips + custom */}
                <div className="rounded-lg border border-border bg-card p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium">Add a section with AI</span>
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <input type="checkbox" checked={aiAppend} onChange={(e) => setAiAppend(e.target.checked)} />
                      Append (uncheck to replace body)
                    </label>
                  </div>
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {SECTION_PRESETS.map((p) => (
                      <button key={p.key} disabled={!!aiBusy}
                        onClick={() => runSection({ presetKey: p.key })}
                        className="rounded-full border border-border bg-background px-3 py-1 text-xs hover:border-primary hover:bg-primary/10 disabled:opacity-50">
                        + {p.label}
                      </button>
                    ))}
                    {customPresets.map((cp) => (
                      <span key={cp.id} className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/5 pr-1 text-xs">
                        <button disabled={!!aiBusy}
                          onClick={() => runCustomPreset(cp.id)}
                          className="rounded-l-full px-3 py-1 hover:bg-primary/10 disabled:opacity-50">
                          ★ {cp.label}
                        </button>
                        <button title="Edit" onClick={() => { setEditingPreset({ id: cp.id, label: cp.label, prompt: cp.prompt }); setPresetMgrOpen(true); }}
                          className="px-1 text-muted-foreground hover:text-foreground">✎</button>
                        <button title="Delete" onClick={() => removePreset(cp.id)}
                          className="px-1 text-muted-foreground hover:text-red-600">✕</button>
                      </span>
                    ))}
                    <button onClick={() => { setPresetMgrOpen((v) => !v); setEditingPreset({ label: "", prompt: "" }); }}
                      className="rounded-full border border-dashed border-border bg-background px-3 py-1 text-xs text-muted-foreground hover:border-primary hover:text-primary">
                      ⚙ {presetMgrOpen ? "Close manager" : "Manage prompts"}
                    </button>
                  </div>

                  {presetMgrOpen && (
                    <div className="mb-3 rounded-md border border-border bg-muted/30 p-2 space-y-2">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {editingPreset.id ? "Edit custom prompt" : "New custom prompt"}
                      </div>
                      <input value={editingPreset.label} onChange={(e) => setEditingPreset({ ...editingPreset, label: e.target.value })}
                        placeholder="Button label (e.g. Local SEO block)"
                        className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs" />
                      <textarea value={editingPreset.prompt} onChange={(e) => setEditingPreset({ ...editingPreset, prompt: e.target.value })}
                        placeholder="Prompt sent to AI. e.g. 'Add a section listing 5 local pool-permit rules with citations.'"
                        rows={3}
                        className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs" />
                      <div className="flex justify-end gap-2">
                        {editingPreset.id && (
                          <button onClick={() => setEditingPreset({ label: "", prompt: "" })}
                            className="rounded border border-border px-2 py-1 text-[11px]">Cancel edit</button>
                        )}
                        <button onClick={savePreset}
                          className="rounded bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground">
                          {editingPreset.id ? "Update prompt" : "Save prompt"}
                        </button>
                      </div>
                    </div>
                  )}

                  <textarea value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="Or write a one-off prompt. e.g. Add an FAQ about pool rental insurance in this city."
                    rows={3}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
                  <div className="mt-2 flex justify-end">
                    <button disabled={!!aiBusy || !aiPrompt.trim()} onClick={() => runSection({ prompt: aiPrompt.trim() })}
                      className="rounded bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50">
                      {aiBusy === "section" ? "Generating…" : "Generate & save"}
                    </button>
                  </div>
                </div>

                {/* Body */}
                <label className="block text-sm">
                  <span className="mb-1 flex items-center justify-between font-medium">
                    <span>Body (Markdown)</span>
                    <span className="text-xs text-muted-foreground">{(page.body_markdown || "").split(/\s+/).filter(Boolean).length} words</span>
                  </span>
                  <textarea value={page.body_markdown || ""} onChange={(e) => setPage({ ...page, body_markdown: e.target.value })}
                    rows={20}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs" />
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    Markdown is required so headings and lists render correctly. Use <code>##</code> for H2, <code>**bold**</code>, <code>- item</code> for bullets, <code>[text](/p/slug)</code> for links.
                  </span>
                </label>
              </div>

              {/* RIGHT — SEO score panel */}
              <aside className="hidden lg:block">
                <div className="sticky top-0 space-y-3">
                  <div className="rounded-lg border border-border bg-card p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">SEO score</div>
                      <button disabled={!!aiBusy} onClick={runAutoFix}
                        title="Use AI to set focus keyword, perfect-length meta, and (if needed) rewrite the body so every check passes."
                        className="rounded bg-green-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-green-700 disabled:opacity-50">
                        {aiBusy === "autofix" ? "Fixing…" : "✨ Auto-fix all"}
                      </button>
                    </div>
                    {score && (
                      <div className="space-y-1.5">
                        <ScoreRow ok={score.titleLen >= 50 && score.titleLen <= 60}
                          warn={score.titleLen >= 40 && score.titleLen < 50}
                          label={`Title length: ${score.titleLen}/60`} />
                        <ScoreRow ok={score.descLen >= 140 && score.descLen <= 155}
                          warn={score.descLen >= 120 && score.descLen < 140}
                          label={`Description: ${score.descLen}/155`} />
                        <ScoreRow ok={score.hasH1} label="H1 present" />
                        <ScoreRow ok={score.wordCount >= 800}
                          warn={score.wordCount >= 400 && score.wordCount < 800}
                          label={`Word count: ${score.wordCount}`} />
                        <ScoreRow ok={score.internalLinks >= 3}
                          warn={score.internalLinks >= 1 && score.internalLinks < 3}
                          label={`Internal links: ${score.internalLinks}`} />
                        {score.fk ? (
                          <>
                            <ScoreRow ok={score.fkInTitle} label="Keyword in SEO title" />
                            <ScoreRow ok={score.fkInDesc} label="Keyword in description" />
                            <ScoreRow ok={score.fkInBody} label="Keyword in first 800 chars" />
                          </>
                        ) : (
                          <ScoreRow ok={false} warn label="No focus keyword set" />
                        )}
                      </div>
                    )}
                  </div>
                  <div className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
                    <div>Last edited: {new Date(page.updated_at).toLocaleDateString()}</div>
                    <div>Created: {new Date(page.created_at).toLocaleDateString()}</div>
                    <div className="mt-2 break-all font-mono text-[10px]">{page.url_path}</div>
                  </div>
                </div>
              </aside>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
          <button onClick={onClose} className="rounded border border-border px-4 py-1.5 text-sm">Cancel</button>
          <button disabled={saving || !page} onClick={save}
            className="rounded bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
