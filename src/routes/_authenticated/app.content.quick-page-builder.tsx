import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Loader2, ExternalLink } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { createQuickPage } from "@/lib/admin-quick-page.functions";

export const Route = createFileRoute("/_authenticated/app/content/quick-page-builder")({
  head: () => ({ meta: [{ title: "Quick Page Builder — founders.click" }] }),
  component: QuickPageBuilder,
});

function slugify(s: string) {
  return s.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-");
}

function QuickPageBuilder() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [topic, setTopic] = useState("");
  const [model, setModel] = useState("google/gemini-2.5-flash");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url_path: string; title: string; words: number } | null>(null);

  const create = useServerFn(createQuickPage);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);

  const slug = title ? slugify(title) : "";
  const canSubmit = !!workspaceId && title.trim().length >= 3 && topic.trim().length >= 10 && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId) return;
    setError(null); setResult(null); setBusy(true);
    try {
      const res = await create({ data: { workspaceId, title, description, topic, model } });
      setResult({ url_path: res.page.url_path, title: res.page.title, words: res.words });
      setTitle(""); setDescription(""); setTopic("");
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">Quick Page Builder</h1>
        <Badge variant="outline" className="gap-1"><Sparkles className="h-3 w-3" /> AI</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Generate a new page</CardTitle>
          <CardDescription>
            Type a title and what the page should be about. We&apos;ll write it on-brand and publish it at <code>/p/{slug || "{slug}"}</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">Page title</Label>
              <Input id="title" placeholder="Pool Rental in Los Angeles, CA" value={title} onChange={(e) => setTitle(e.target.value)} />
              {slug && <p className="text-xs text-muted-foreground">URL: <code>/p/{slug}</code></p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Short description (optional)</Label>
              <Input id="description" placeholder="One-line summary the AI will lean on" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="topic">What should this page be about?</Label>
              <Textarea id="topic" rows={5} placeholder="Explain the angle, the audience, key facts to mention, internal links to weave in…" value={topic} onChange={(e) => setTopic(e.target.value)} />
              <p className="text-xs text-muted-foreground">{topic.length} chars (min 10)</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="model">Model</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger id="model"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="google/gemini-2.5-flash">Gemini 2.5 Flash (default, free)</SelectItem>
                  <SelectItem value="google/gemini-2.5-pro">Gemini 2.5 Pro</SelectItem>
                  <SelectItem value="openai/gpt-5">GPT-5</SelectItem>
                  <SelectItem value="openai/gpt-5-mini">GPT-5 Mini</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
            {result && (
              <div className="rounded-md border bg-muted/40 p-4 text-sm">
                <p className="font-medium">Published <code>{result.url_path}</code> ({result.words} words)</p>
                <a href={result.url_path} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-primary hover:underline">
                  View page <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}

            <div className="flex gap-2">
              <Button type="submit" disabled={!canSubmit} className="gap-2">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {busy ? "Generating…" : "Generate & publish"}
              </Button>
            </div>
            {!workspaceId && <p className="text-xs text-muted-foreground">Loading workspace…</p>}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
