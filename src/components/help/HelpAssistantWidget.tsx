import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { MessageCircle, X, Send, Sparkles, RefreshCw, AlertCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Role = "user" | "assistant";
type Source = { title: string; url: string };
type Msg = {
  id: string;
  role: Role;
  content: string;
  sources?: Source[];
  isStreaming?: boolean;
};

const SUGGESTIONS = [
  "How do I connect my Sharetribe marketplace?",
  "What's a City Hub page?",
  "How does billing work?",
  "Why aren't my listings syncing?",
];

const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/help-assistant-chat`;

export function HelpAssistantWidget() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, open]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setError(null);
    setInput("");

    const userMsg: Msg = { id: crypto.randomUUID(), role: "user", content: trimmed };
    const botId = crypto.randomUUID();
    const botMsg: Msg = { id: botId, role: "assistant", content: "", isStreaming: true };

    const history = [...messages, userMsg];
    setMessages([...history, botMsg]);
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        if (res.status === 429) throw new Error("Too many requests. Please wait a moment.");
        if (res.status === 402) throw new Error("Service temporarily unavailable.");
        throw new Error("Failed to reach the assistant.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let acc = "";
      let sources: Source[] | undefined;
      let done = false;

      while (!done) {
        const { done: d, value } = await reader.read();
        if (d) break;
        buffer += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line) continue;
          if (line.startsWith("event: sources")) continue;
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") { done = true; break; }
          // Sources event payload (JSON array)
          if (payload.startsWith("[") && !sources) {
            try { sources = JSON.parse(payload) as Source[]; continue; } catch { /* fall through */ }
          }
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed.choices?.[0]?.delta?.content as string | undefined;
            if (delta) {
              acc += delta;
              setMessages((prev) => prev.map((m) => (m.id === botId ? { ...m, content: acc } : m)));
            }
          } catch {
            buffer = line + "\n" + buffer;
            break;
          }
        }
      }

      setMessages((prev) => prev.map((m) => (m.id === botId ? { ...m, isStreaming: false, sources } : m)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong.";
      setError(msg);
      setMessages((prev) => prev.filter((m) => m.id !== botId));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [busy, messages]);

  return (
    <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-50 flex flex-col items-end">
      {open && (
        <div className="w-[calc(100vw-2rem)] sm:w-[400px] h-[620px] max-h-[calc(100vh-6rem)] bg-card text-card-foreground rounded-2xl shadow-2xl border border-border flex flex-col overflow-hidden mb-3 animate-in slide-in-from-bottom-4 fade-in duration-200">
          <header className="bg-primary text-primary-foreground px-4 py-3 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-primary-foreground/10 flex items-center justify-center">
                <Sparkles size={16} />
              </div>
              <div className="leading-tight">
                <div className="text-sm font-semibold">Help assistant</div>
                <div className="text-[10px] uppercase tracking-wider opacity-70">founders.click</div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button onClick={() => { setMessages([]); setError(null); }} className="p-1.5 rounded-md hover:bg-primary-foreground/10" aria-label="Reset">
                  <RefreshCw size={15} />
                </button>
              )}
              <button onClick={() => setOpen(false)} className="p-1.5 rounded-md hover:bg-primary-foreground/10" aria-label="Close">
                <X size={16} />
              </button>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto p-4 bg-muted/30">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center text-center pt-6">
                <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center mb-3">
                  <Sparkles size={22} />
                </div>
                <h3 className="text-base font-semibold mb-1">Ask about founders.click</h3>
                <p className="text-xs text-muted-foreground mb-5 px-2">Grounded in our help center. I cite the articles I use.</p>
                <div className="flex flex-col gap-2 w-full">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => send(s)} className="text-left px-3 py-2.5 rounded-lg border border-border bg-background hover:border-primary/40 hover:bg-accent transition text-[13px]">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {messages.map((m) => (
                  <Bubble key={m.id} msg={m} />
                ))}
                <div ref={endRef} />
              </div>
            )}
            {error && (
              <div className="mt-3 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                <p className="text-xs">{error}</p>
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); send(input); }}
            className="p-3 bg-card border-t border-border flex-shrink-0"
          >
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); }
                }}
                placeholder="Ask a question…"
                rows={1}
                disabled={busy}
                className="flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring max-h-32"
              />
              <button
                type="submit"
                disabled={busy || !input.trim()}
                className="p-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label="Send"
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </button>
            </div>
            <p className="text-center text-[10px] text-muted-foreground mt-2">AI can make mistakes. Verify important info.</p>
          </form>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all hover:scale-105 focus:outline-none focus:ring-4 focus:ring-ring/30",
          open ? "bg-secondary text-secondary-foreground" : "bg-primary text-primary-foreground"
        )}
        aria-label={open ? "Close help assistant" : "Open help assistant"}
      >
        {open ? <X size={22} /> : <MessageCircle size={22} />}
      </button>
    </div>
  );
}

function Bubble({ msg }: { msg: Msg }) {
  const isUser = msg.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm",
          isUser
            ? "bg-primary text-primary-foreground rounded-br-sm"
            : "bg-background border border-border rounded-bl-sm"
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
        ) : (
          <>
            {msg.content ? (
              <div className="prose prose-sm max-w-none prose-p:my-1.5 prose-ul:my-1.5 prose-li:my-0 prose-headings:my-2 prose-a:text-primary">
                <ReactMarkdown>{msg.content}</ReactMarkdown>
              </div>
            ) : (
              <div className="flex gap-1 py-1">
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:120ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:240ms]" />
              </div>
            )}
            {msg.sources && msg.sources.length > 0 && !msg.isStreaming && (
              <div className="mt-2.5 pt-2.5 border-t border-border">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">Sources</p>
                <ul className="flex flex-col gap-1">
                  {msg.sources.map((s, i) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
                        [{i + 1}] {s.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
