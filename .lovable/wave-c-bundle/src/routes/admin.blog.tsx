import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  adminListBlogPosts,
  adminExpandBlogPost,
  adminGenerateBlogPost,
  adminBulkPublishBlogPosts,
  type AdminBlogRow,
} from "@/server/admin-blog.functions";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { AdminLayout } from "@/components/admin-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/blog")({
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
  component: AdminBlogPage,
  head: () => ({ meta: [{ title: "Blog admin — Pool Rental Near Me" }] }),
});

function AdminBlogPage() {
  const [rows, setRows] = useState<AdminBlogRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState("");
  const [genCount, setGenCount] = useState("3");
  const [genTopic, setGenTopic] = useState("");
  const [genHint, setGenHint] = useState("");
  const [generating, setGenerating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const toggleSel = (slug: string) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(slug) ? next.delete(slug) : next.add(slug);
      return next;
    });

  const generate = async (autoPublish: boolean) => {
    const n = Math.min(Math.max(parseInt(genCount) || 1, 1), 10);
    const verb = autoPublish ? "Generate & publish" : "Generate";
    if (!confirm(`${verb} ${n} new blog post${n > 1 ? "s" : ""} with AI?${autoPublish ? " They will go LIVE immediately." : " They'll be saved as drafts."} Uses credits.`)) return;
    setGenerating(true);
    try {
      const res = await adminGenerateBlogPost({
        data: {
          count: n,
          topic: genTopic.trim() || undefined,
          titleHint: genHint.trim() || undefined,
          autoPublish,
        },
      });
      if (res.created.length > 0) {
        toast.success(
          `Created ${res.created.length} ${autoPublish ? "live post" : "draft"}${res.created.length > 1 ? "s" : ""}.`,
        );
      }
      if (res.errors.length > 0) {
        toast.error(`${res.errors.length} failed: ${res.errors[0]}`);
      }
      if (res.created.length === 0 && res.errors.length === 0) {
        toast.info("No posts generated. Try a different topic.");
      }
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  const bulkPublish = async (publish: boolean) => {
    const slugs = Array.from(selected);
    if (slugs.length === 0) {
      toast.info("Select some posts first.");
      return;
    }
    if (!confirm(`${publish ? "Publish" : "Unpublish"} ${slugs.length} post${slugs.length > 1 ? "s" : ""}?`)) return;
    setBulkBusy(true);
    try {
      await adminBulkPublishBlogPosts({ data: { slugs, publish } });
      toast.success(`${publish ? "Published" : "Unpublished"} ${slugs.length}.`);
      setSelected(new Set());
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBulkBusy(false);
    }
  };

  const refresh = () => {
    adminListBlogPosts({ data: undefined as never })
      .then((r) => setRows(r.rows))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    refresh();
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        (r.topic ?? "").toLowerCase().includes(q) ||
        r.slug.includes(q),
    );
  }, [rows, filter]);

  const expand = async (slug: string) => {
    setBusy((b) => ({ ...b, [slug]: true }));
    try {
      const res = await adminExpandBlogPost({ data: { slug } });
      toast.success(`Expanded: ${res.word_count} words`);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((b) => ({ ...b, [slug]: false }));
    }
  };

  const expandAllShort = async () => {
    if (!filtered) return;
    const targets = filtered.filter((r) => r.word_count < 500);
    if (targets.length === 0) {
      toast.info("Nothing under 500 words to expand.");
      return;
    }
    if (!confirm(`Expand ${targets.length} posts with AI? This will use credits.`)) return;
    for (const t of targets) {
      await expand(t.slug);
      // small delay to be polite to the gateway
      await new Promise((r) => setTimeout(r, 600));
    }
  };

  const grouped = useMemo(() => {
    const m = new Map<string, AdminBlogRow[]>();
    for (const r of filtered ?? []) {
      const k = r.topic ?? "Uncategorized";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <AdminLayout>
        <section className="mb-6 rounded-lg border bg-card p-4">
          <div className="mb-3">
            <h2 className="text-lg font-semibold">Auto-generate posts with AI</h2>
            <p className="text-xs text-muted-foreground">
              Brainstorms titles, writes full ~900-word drafts, saves as unpublished. Optional category and topic hint focus the output.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">How many</span>
              <Input
                type="number"
                min={1}
                max={10}
                value={genCount}
                onChange={(e) => setGenCount(e.target.value)}
                className="w-20"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Category (optional)</span>
              <Input
                placeholder="e.g. Hosting, Pricing, Insurance"
                value={genTopic}
                onChange={(e) => setGenTopic(e.target.value)}
                className="w-56"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs flex-1 min-w-[220px]">
              <span className="text-muted-foreground">Topic hint (optional)</span>
              <Input
                placeholder="e.g. winterizing, pet-friendly rentals, LLC setup"
                value={genHint}
                onChange={(e) => setGenHint(e.target.value)}
              />
            </label>
            <Button onClick={() => generate(false)} disabled={generating} variant="secondary">
              {generating ? "Generating…" : "Generate drafts"}
            </Button>
            <Button onClick={() => generate(true)} disabled={generating}>
              {generating ? "Generating…" : "Generate & publish"}
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Daily auto-generation runs in the background — drafts appear here for review.
          </p>
        </section>


        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold">Blog admin</h1>
            <p className="text-sm text-muted-foreground">
              {rows?.length ?? "…"} posts. Click <em>Expand with AI</em> to replace seed
              content with a full article.
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="Filter by title, topic, slug…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-64"
            />
            <Button variant="secondary" onClick={expandAllShort} disabled={!rows}>
              Expand all short
            </Button>
            <Button variant="secondary" onClick={() => bulkPublish(true)} disabled={bulkBusy || selected.size === 0}>
              Publish selected ({selected.size})
            </Button>
            <Button variant="ghost" onClick={() => bulkPublish(false)} disabled={bulkBusy || selected.size === 0}>
              Unpublish
            </Button>
          </div>
        </div>

        {err && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {err}
          </div>
        )}

        {!rows && <div className="text-sm text-muted-foreground">Loading…</div>}

        {grouped.map(([topic, list]) => (
          <section key={topic} className="mb-8">
            <h2 className="mb-3 text-lg font-semibold">
              {topic}{" "}
              <span className="text-sm font-normal text-muted-foreground">
                ({list.length})
              </span>
            </h2>
            <div className="overflow-hidden rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="px-3 py-2 w-8"></th>
                    <th className="px-3 py-2">Title</th>
                    <th className="px-3 py-2 w-24">Words</th>
                    <th className="px-3 py-2 w-20">Status</th>
                    <th className="px-3 py-2 w-56">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.slug} className="border-t">
                      <td className="px-3 py-2 align-middle">
                        <input
                          type="checkbox"
                          checked={selected.has(r.slug)}
                          onChange={() => toggleSel(r.slug)}
                          aria-label={`Select ${r.title}`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.title}</div>
                        <div className="text-xs text-muted-foreground">/p/{r.slug}</div>
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        <span className={r.word_count < 500 ? "text-amber-600" : ""}>
                          {r.word_count}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {r.is_published ? (
                          <span className="text-green-700">Live</span>
                        ) : (
                          <span className="text-muted-foreground">Draft</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => expand(r.slug)}
                            disabled={busy[r.slug]}
                          >
                            {busy[r.slug] ? "Expanding…" : "Expand with AI"}
                          </Button>
                          <Link
                            to="/p/$slug"
                            params={{ slug: r.slug }}
                            target="_blank"
                            className="text-sm underline self-center"
                          >
                            View
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </AdminLayout>
  );
}
// touch 1777849623
