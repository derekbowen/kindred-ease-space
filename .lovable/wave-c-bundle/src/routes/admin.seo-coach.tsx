import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import * as React from "react";
import ReactMarkdown from "react-markdown";
import { Sparkles, Send, RotateCcw, ExternalLink, Check } from "lucide-react";
import { AdminLayout } from "@/components/admin-layout";
import { seoCoachChat } from "@/server/admin-seo-coach.functions";

type Msg = { role: "user" | "assistant"; content: string };

// Pull /admin/* routes mentioned in coach replies so we can offer one-click "Do it now"
function extractAdminRoutes(text: string): string[] {
  const re = /\/admin\/[a-z0-9][a-z0-9-/]*/gi;
  const found = new Set<string>();
  for (const m of text.matchAll(re)) {
    // strip trailing punctuation
    const clean = m[0].replace(/[).,;:`'"]+$/, "").toLowerCase();
    if (clean !== "/admin" && clean !== "/admin/") found.add(clean);
  }
  return Array.from(found);
}

const ROUTE_LABELS: Record<string, string> = {
  "/admin/missing-pages": "Triage 404s",
  "/admin/page-auditor": "Audit a page",
  "/admin/listing-auditor": "Audit a listing",
  "/admin/keyword-opportunities": "Find keyword wins",
  "/admin/internal-links": "Add internal links",
  "/admin/seo-health": "Open SEO health",
  "/admin/content-pages": "Bulk-fix pages",
  "/admin/quick-page": "Build a new page",
  "/admin/generate-content": "Batch generate",
  "/admin/gsc-import": "Re-sync GSC",
  "/admin/competitor-radar": "Open competitor radar",
  "/admin/rank-tracker": "Open rank tracker",
  "/admin/indexing": "Open sitemap & indexing",
  "/admin/link-checker": "Run link checker",
  "/admin/competitors": "Open competitor tracker",
};
function labelFor(route: string): string {
  return ROUTE_LABELS[route] || `Open ${route}`;
}

const STARTER_PROMPTS = [
  "What's my single biggest SEO problem right now?",
  "Walk me through fixing my 404s",
  "I have 30 minutes — what should I do?",
  "Which pages need a rewrite first?",
];

export const Route = createFileRoute("/admin/seo-coach")({
  component: SeoCoachPage,
});

function SeoCoachPage() {
  const chat = useServerFn(seoCoachChat);
  const [messages, setMessages] = React.useState<Msg[]>([]);
  const [input, setInput] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [completed, setCompleted] = React.useState<Set<string>>(new Set());
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  // Auto-kickoff on first load
  React.useEffect(() => {
    if (messages.length === 0) void send("Start. Show me my most urgent SEO issue and ask the first yes/no question.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    setError(null);
    const next: Msg[] = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await chat({ data: { messages: next, completedRoutes: Array.from(completed) } });
      if (res.ok) setMessages([...next, { role: "assistant", content: res.reply }]);
      else setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setMessages([]);
    setCompleted(new Set());
    setError(null);
    setTimeout(() => void send("Start. Show me my most urgent SEO issue and ask the first yes/no question."), 50);
  }

  function answerYesNo(answer: "Yes" | "No") {
    void send(answer);
  }

  function doItNow(route: string) {
    // Open the recommended admin tool in a new tab
    if (typeof window !== "undefined") window.open(route, "_blank", "noopener,noreferrer");
    // Mark this step complete and tell the coach to advance
    setCompleted((prev) => {
      const next = new Set(prev);
      next.add(route);
      return next;
    });
    void send(`✅ Done — I just opened ${route} and started working on it. Mark this step as completed and ask me the next yes/no question for the next priority.`);
  }

  return (
    <AdminLayout>
      <div className="flex flex-col h-[calc(100vh-4rem)] max-w-4xl mx-auto">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-semibold">SEO Coach</h1>
            <span className="text-xs text-muted-foreground">Yes/No guided fixes, grounded in your live data</span>
          </div>
          <button
            onClick={reset}
            className="text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="h-3 w-3" /> Restart
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
          {messages.length === 0 && (
            <div className="text-sm text-muted-foreground">Loading your snapshot…</div>
          )}
          {messages.map((m, i) => {
            const routes = m.role === "assistant" ? extractAdminRoutes(m.content) : [];
            return (
              <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div
                  className={
                    m.role === "user"
                      ? "max-w-[80%] rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm"
                      : "max-w-[85%] rounded-lg bg-muted px-4 py-3 text-sm space-y-3"
                  }
                >
                  {m.role === "assistant" ? (
                    <>
                      <div className="prose prose-sm dark:prose-invert max-w-none">
                        <ReactMarkdown
                          components={{
                            a: ({ href, children }) => (
                              <a href={href} className="text-primary underline" target={href?.startsWith("/admin") ? undefined : "_blank"}>
                                {children}
                              </a>
                            ),
                          }}
                        >
                          {m.content}
                        </ReactMarkdown>
                      </div>
                      {routes.length > 0 && (
                        <div className="flex flex-wrap gap-2 pt-2 border-t border-border/40">
                          {routes.map((route) => {
                            const isDone = completed.has(route);
                            return (
                              <button
                                key={route}
                                onClick={() => !isDone && doItNow(route)}
                                disabled={isDone}
                                className={
                                  isDone
                                    ? "inline-flex items-center gap-1.5 rounded-md bg-green-600/10 text-green-700 dark:text-green-400 px-3 py-1.5 text-xs font-medium cursor-default"
                                    : "inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 px-3 py-1.5 text-xs font-semibold"
                                }
                                title={route}
                              >
                                {isDone ? <><Check className="h-3 w-3" /> Done — {labelFor(route)}</> : <><ExternalLink className="h-3 w-3" /> Do it now: {labelFor(route)}</>}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </>
                  ) : (
                    m.content
                  )}
                </div>
              </div>
            );
          })}
          {loading && (
            <div className="flex justify-start">
              <div className="rounded-lg bg-muted px-4 py-2 text-sm text-muted-foreground">Thinking…</div>
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        {/* Yes/No quick reply when last message is from coach */}
        {messages.length > 0 && messages[messages.length - 1].role === "assistant" && !loading && (
          <div className="flex gap-2 px-4 pb-2">
            <button
              onClick={() => answerYesNo("Yes")}
              className="flex-1 rounded-md bg-green-600 hover:bg-green-700 text-white text-sm font-medium py-2"
            >
              Yes
            </button>
            <button
              onClick={() => answerYesNo("No")}
              className="flex-1 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium py-2"
            >
              No
            </button>
            <button
              onClick={() => void send("Why?")}
              className="rounded-md border px-3 text-sm hover:bg-muted"
            >
              Why?
            </button>
            <button
              onClick={() => void send("Skip — next question")}
              className="rounded-md border px-3 text-sm hover:bg-muted"
            >
              Skip
            </button>
          </div>
        )}

        {messages.length <= 1 && (
          <div className="flex flex-wrap gap-2 px-4 pb-2">
            {STARTER_PROMPTS.map((p) => (
              <button
                key={p}
                onClick={() => void send(p)}
                className="text-xs rounded-full border px-3 py-1 hover:bg-muted"
              >
                {p}
              </button>
            ))}
          </div>
        )}

        <form
          onSubmit={(e) => { e.preventDefault(); void send(input); }}
          className="flex gap-2 border-t p-3"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a follow-up, or click Yes/No above…"
            className="flex-1 rounded-md border px-3 py-2 text-sm bg-background"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-md bg-primary text-primary-foreground px-4 text-sm font-medium disabled:opacity-50 flex items-center gap-1"
          >
            <Send className="h-4 w-4" /> Send
          </button>
        </form>
      </div>
    </AdminLayout>
  );
}
