import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Plus, Sparkles, Loader2, AlertCircle, ExternalLink } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import {
  listConversations, createConversation, getMessages,
} from "@/lib/coach.functions";
import { SUGGESTED_PROMPTS } from "@/lib/coach-prompts";
import { CoachMessage, type CoachMsg, type ToolCallShape } from "@/components/coach/CoachMessage";

type Msg = CoachMsg;
type ToolEvent = { id: string; name: string; status: "running" | "done"; output?: unknown };

export function CoachPanel({
  open, onOpenChange, workspaceId, context,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspaceId: string | null;
  context?: { page_id?: string; route?: string };
}) {
  const qc = useQueryClient();
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: convData } = useQuery({
    queryKey: ["coach-conversations", workspaceId],
    queryFn: () => listConversations({ data: { workspaceId: workspaceId! } }),
    enabled: !!workspaceId && open,
  });

  // Load messages when conversation changes
  useEffect(() => {
    if (!activeConvId) { setMessages([]); return; }
    getMessages({ data: { conversationId: activeConvId } }).then((r) => {
      setMessages(r.messages.map((m) => ({
        id: m.id as string, role: m.role as Msg["role"], content: (m.content ?? "") as string,
        tool_calls: m.tool_calls as Msg["tool_calls"],
      })));
    });
  }, [activeConvId]);

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, toolEvents]);

  const startNewConversation = useCallback(async () => {
    if (!workspaceId) return null;
    const { conversation } = await createConversation({ data: { workspaceId } });
    qc.invalidateQueries({ queryKey: ["coach-conversations", workspaceId] });
    setActiveConvId(conversation!.id as string);
    setMessages([]);
    setToolEvents([]);
    return conversation!.id as string;
  }, [workspaceId, qc]);

  const send = useCallback(async (text: string) => {
    if (!workspaceId || !text.trim() || streaming) return;
    setError(null);
    let convId = activeConvId;
    if (!convId) convId = await startNewConversation();
    if (!convId) return;

    const userMsg: Msg = { id: `u-${Date.now()}`, role: "user", content: text };
    const asstMsg: Msg = { id: `a-${Date.now()}`, role: "assistant", content: "", isStreaming: true };
    setMessages((prev) => [...prev, userMsg, asstMsg]);
    setInput("");
    setStreaming(true);
    setToolEvents([]);

    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session.session?.access_token;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/coach-chat`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "",
        },
        body: JSON.stringify({
          conversation_id: convId,
          workspace_id: workspaceId,
          user_message: text,
          context,
        }),
      });
      if (!resp.ok || !resp.body) {
        const errText = await resp.text();
        throw new Error(errText || `HTTP ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assembledText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";
        for (const block of lines) {
          const lns = block.split("\n");
          let event = "message";
          let dataStr = "";
          for (const ln of lns) {
            if (ln.startsWith("event: ")) event = ln.slice(7);
            else if (ln.startsWith("data: ")) dataStr = ln.slice(6);
          }
          if (!dataStr) continue;
          let data: Record<string, unknown> = {};
          try { data = JSON.parse(dataStr); } catch { continue; }

          if (event === "tool_start") {
            setToolEvents((prev) => [...prev, { id: data.id as string, name: data.name as string, status: "running" }]);
          } else if (event === "tool_result") {
            setToolEvents((prev) => prev.map((t) => t.id === data.id ? { ...t, status: "done", output: data.output } : t));
          } else if (event === "delta") {
            assembledText += data.text as string;
            setMessages((prev) => prev.map((m) => m.id === asstMsg.id ? { ...m, content: assembledText } : m));
          } else if (event === "done") {
            setMessages((prev) => prev.map((m) => m.id === asstMsg.id ? { ...m, isStreaming: false } : m));
          } else if (event === "error") {
            throw new Error(data.message as string);
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Something went wrong";
      setError(msg);
      setMessages((prev) => prev.filter((m) => m.id !== asstMsg.id));
    } finally {
      setStreaming(false);
    }
  }, [workspaceId, activeConvId, context, streaming, startNewConversation]);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const isEmpty = messages.length === 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col p-0 dark bg-background text-foreground">
        <SheetHeader className="px-4 py-3 border-b border-border flex-row items-center justify-between space-y-0">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            Coach
          </SheetTitle>
          <Button variant="ghost" size="sm" onClick={() => { setActiveConvId(null); setMessages([]); }}>
            <Plus className="h-4 w-4 mr-1" /> New
          </Button>
        </SheetHeader>

        {/* Conversation history dropdown */}
        {convData && convData.conversations.length > 0 && (
          <div className="px-4 py-2 border-b border-border">
            <select
              value={activeConvId ?? ""}
              onChange={(e) => setActiveConvId(e.target.value || null)}
              className="w-full text-xs bg-muted rounded px-2 py-1.5 border border-border"
            >
              <option value="">— New conversation —</option>
              {convData.conversations.map((c) => (
                <option key={c.id as string} value={c.id as string}>
                  {(c.title as string) || "Untitled"}
                </option>
              ))}
            </select>
          </div>
        )}

        <ScrollArea className="flex-1">
          <div ref={scrollRef} className="px-4 py-4 space-y-4">
            {isEmpty && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Ask me anything about your workspace. I read your data and give specific actions.
                </p>
                <div className="space-y-1.5">
                  {SUGGESTED_PROMPTS.map((p) => (
                    <button
                      key={p.label}
                      onClick={() => send(p.prompt)}
                      className="w-full text-left text-xs px-3 py-2 rounded-md border border-border hover:bg-muted transition"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) => <CoachMessage key={m.id} msg={m} dense />)}

            {streaming && toolEvents.length > 0 && (
              <div className="space-y-1">
                {toolEvents.map((t) => (
                  <CoachMessage
                    key={t.id}
                    msg={{
                      id: t.id,
                      role: "tool",
                      content: "",
                      tool_calls: [{
                        name: t.name,
                        output: t.output,
                        status: t.status,
                      } as ToolCallShape],
                    }}
                    dense
                  />
                ))}
              </div>
            )}

            {error && (
              <div className="flex gap-2 items-start p-3 rounded-md bg-destructive/10 border border-destructive/30 text-xs text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span className="break-words">{error}</span>
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="border-t border-border p-3 space-y-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="Ask the coach…"
            rows={2}
            disabled={streaming}
            className="resize-none text-sm"
          />
          <div className="flex justify-between items-center">
            <span className="text-[10px] text-muted-foreground">⏎ to send · ⇧⏎ for newline</span>
            <Button size="sm" onClick={() => send(input)} disabled={streaming || !input.trim()}>
              {streaming ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
              <span className="ml-1.5">Send</span>
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

}
