import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { getMe } from "@/lib/auth.functions";
import { seoCoachChat } from "@/lib/admin-seo-coach.functions";

export const Route = createFileRoute("/_authenticated/app/seo-coach")({
  head: () => ({ meta: [{ title: "SEO Coach — founders.click" }] }),
  component: SeoCoachPage,
});

type Msg = { role: "user" | "assistant"; content: string };

function SeoCoachPage() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chat = useServerFn(seoCoachChat);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null)); }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  async function send(content: string) {
    if (!workspaceId || !content.trim()) return;
    const next: Msg[] = [...messages, { role: "user", content }];
    setMessages(next); setInput(""); setBusy(true); setError(null);
    try {
      const r = await chat({ data: { workspaceId, messages: next } });
      if (r.ok) setMessages([...next, { role: "assistant", content: r.reply }]);
      else setError(r.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally { setBusy(false); }
  }

  async function start() {
    setMessages([]);
    await send("Start a new SEO coaching session. What should I fix first?");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">SEO Coach</h1>
        <p className="text-sm text-muted-foreground">A Socratic mentor that walks you through fixing real issues using your live site data.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Conversation</CardTitle>
          <CardDescription>Powered by Lovable AI Gateway. Snapshot is rebuilt on each turn from your workspace data.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {messages.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center">
              <p className="mb-3 text-sm text-muted-foreground">No conversation yet.</p>
              <Button onClick={start} disabled={busy || !workspaceId} className="gap-2">
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Start session
              </Button>
            </div>
          ) : (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-2">
              {messages.map((m, i) => (
                <div key={i} className={`rounded-md p-3 text-sm ${m.role === "user" ? "bg-muted ml-12" : "bg-card border mr-12"}`}>
                  <div className="text-xs font-semibold uppercase text-muted-foreground mb-1">{m.role}</div>
                  <div className="whitespace-pre-wrap">{m.content}</div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          )}

          {error && <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

          {messages.length > 0 && (
            <div className="space-y-2">
              <Textarea value={input} onChange={(e) => setInput(e.target.value)} rows={3} placeholder="Yes / No / your answer..." onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(input); }} />
              <div className="flex gap-2">
                <Button onClick={() => send(input)} disabled={busy || !input.trim()} className="gap-2">
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />} Send
                </Button>
                <Button variant="outline" onClick={start} disabled={busy}>Restart</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
