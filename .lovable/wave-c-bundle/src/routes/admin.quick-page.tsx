import * as React from "react";
import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { checkAdminRole } from "@/server/admin-auth.functions";
import { createQuickPage } from "@/server/admin-quick-page.functions";
import { AdminLayout } from "@/components/admin-layout";

export const Route = createFileRoute("/admin/quick-page")({
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: "/auth", search: { redirect: "/admin/quick-page", mode: "signin" } });
    }
    const { isAdmin } = await checkAdminRole();
    if (!isAdmin) throw redirect({ to: "/admin/no-access" });
  },
  head: () => ({
    meta: [
      { title: "Quick Page Builder — PRNM Admin" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: AdminQuickPage,
});

function AdminQuickPage() {
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [topic, setTopic] = React.useState("");
  const [model, setModel] = React.useState("openai/gpt-5");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{
    page: { url_path: string; title: string; slug: string };
    words: number;
  } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const res = (await createQuickPage({
        data: { title, description, topic, model },
      })) as any;
      setResult({ page: res.page, words: res.words });
      setTitle("");
      setDescription("");
      setTopic("");
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = title.trim().length >= 3 && topic.trim().length >= 10 && !busy;

  return (
    <AdminLayout>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">Quick Page Builder</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Type a title and what the page should be about. We&apos;ll write it on-brand and
              publish it at <code>/p/{`{slug}`}</code> instantly.
            </p>
          </div>
          <Link
            to="/admin/dashboard"
            className="shrink-0 text-sm text-muted-foreground hover:underline"
          >
            ← Dashboard
          </Link>
        </div>

        <form
          onSubmit={submit}
          className="mt-8 space-y-5 rounded-2xl border border-border bg-card p-6"
        >
          <div>
            <label className="block text-sm font-medium">
              Title <span className="text-destructive">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. The host's guide to weekend pricing"
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              maxLength={140}
              required
            />
            <p className="mt-1 text-xs text-muted-foreground">
              The H1 and basis for the URL slug.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium">
              Short description <span className="text-muted-foreground">(optional)</span>
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One line — what's the gist?"
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              maxLength={500}
            />
          </div>

          <div>
            <label className="block text-sm font-medium">
              What should this page be about? <span className="text-destructive">*</span>
            </label>
            <textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Tell us the angle, audience, and any specifics to cover. We'll handle SEO, structure, and PRNM brand voice automatically."
              className="mt-1 min-h-40 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              maxLength={2000}
              required
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {topic.length}/2000 characters. The more specific, the better.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="openai/gpt-5">GPT-5 (best quality)</option>
              <option value="openai/gpt-5-mini">GPT-5 mini (faster)</option>
              <option value="google/gemini-2.5-pro">Gemini 2.5 Pro</option>
              <option value="google/gemini-2.5-flash">Gemini 2.5 Flash (fastest)</option>
            </select>
          </div>

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Writing & publishing…" : "Generate & publish page"}
          </button>
        </form>

        {error && (
          <div className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        {result && (
          <div className="mt-6 rounded-2xl border border-green-500/40 bg-green-500/10 p-5">
            <div className="text-sm font-semibold">
              ✓ Published — {result.words.toLocaleString()} words
            </div>
            <div className="mt-1 font-mono text-xs">{result.page.url_path}</div>
            <a
              href={result.page.url_path}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block rounded-full border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              View page →
            </a>
          </div>
        )}
      </AdminLayout>
  );
}
