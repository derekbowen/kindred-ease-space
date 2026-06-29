import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Sparkles, Send, Loader2, AlertCircle, MessagesSquare } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getMe } from "@/lib/auth.functions";
import { listConversations, getMessages, createConversation } from "@/lib/coach.functions";
import { CoachConversationList } from "@/components/coach/CoachConversationList";
import { CoachMessage, type CoachMsg, type ToolCallShape } from "@/components/coach/CoachMessage";
import { SUGGESTED_PROMPTS } from "@/lib/coach-prompts";

export const Route = createFileRoute("/_authenticated/app/coach")({
  head: () => ({ meta: [{ title: "Coach — founders.click" }] }),
  component: CoachPage,
});

function CoachPage() {
  const qc = useQueryClient();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftMessages, setDraftMessages] = useState<CoachMsg[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeStreamConvRef = useRef<string | null>(null);

  useEffect(() => {
    getMe().then((me) => setWorkspaceId(me.memberships[0]?.workspace_id ?? null));
  }, []);

  const { data: convData, isLoading: convLoading } = useQuery({
    queryKey: ["coach-conversations", workspaceId],
    queryFn: () => listConversations({ data: { workspaceId: workspaceId! } }),
    enabled: !!workspaceId,
  });

  const { data: msgData, isLoading: msgLoading } = useQuery({
    queryKey: ["coach-messages", activeConvId],
    queryFn: () => getMessages({ data: { conversationId: activeConvId! } }),
    enabled: !!activeConvId,
  });

  // Reset drafts when switching conversations; ignore in-flight stream updates.
  useEffect(() => {
    activeStreamConvRef.current = null;
    setDraftMessages([]);
    setError(null);
  }, [activeConvId]);

  const persistedMessages: CoachMsg[] = (msgData?.messages ?? []).map((m) => ({
    id: m.id as string,
    role: m.role as CoachMsg["role"],
    content: (m.content ?? "") as string,
    tool_calls: m.tool_calls as ToolCallShape[] | undefined,
    created_at: m.created_at as string,
  }));

  const messages = activeConvId ? [...persistedMessages, ...draftMessages] : draftMessages;

  // Auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, draftMessages]);

  const send = useCallback(
    async (text: string) => {
      if (!workspaceId || !text.trim() || streaming) return;
      setError(null);

      let convId = activeConvId;
      if (!convId) {
        const { conversation } = await createConversation({ data: { workspaceId } });
        convId = conversation!.id as string;
        qc.invalidateQueries({ queryKey: ["coach-conversations", workspaceId] });
        setActiveConvId(convId);
      }

      const userMsg: CoachMsg = { id: `u-${Date.now()}`, role: "user", content: text };
      const asstMsg: CoachMsg = {
        id: `a-${Date.now()}`,
        role: "assistant",
        content: "",
        isStreaming: true,
        tool_calls: [],
      };
      setDraftMessages((prev) => [...prev, userMsg, asstMsg]);
      setInput("");
      setStreaming(true);
      activeStreamConvRef.current = convId;

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
          }),
        });
        if (!resp.ok || !resp.body) {
          const errText = await resp.text();
          throw new Error(errText || `HTTP ${resp.status}`);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let assembled = "";

        while (true) {
          if (activeStreamConvRef.current !== convId) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            let event = "message";
            let dataStr = "";
            for (const ln of block.split("\n")) {
              if (ln.startsWith("event: ")) event = ln.slice(7);
              else if (ln.startsWith("data: ")) dataStr = ln.slice(6);
            }
            if (!dataStr) continue;
            let data: Record<string, unknown> = {};
            try {
              data = JSON.parse(dataStr);
            } catch {
              continue;
            }

            if (event === "tool_start") {
              setDraftMessages((prev) =>
                prev.map((m) =>
                  m.id === asstMsg.id
                    ? {
                        ...m,
                        tool_calls: [
                          ...(m.tool_calls ?? []),
                          {
                            name: data.name as string,
                            input: data.input,
                            status: "running",
                          } as ToolCallShape,
                        ],
                      }
                    : m,
                ),
              );
            } else if (event === "tool_result") {
              setDraftMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== asstMsg.id) return m;
                  const tcs = (m.tool_calls ?? []).map((tc) =>
                    tc.name === (data.name as string) && tc.status === "running"
                      ? { ...tc, status: "done" as const, output: data.output }
                      : tc,
                  );
                  return { ...m, tool_calls: tcs };
                }),
              );
            } else if (event === "delta") {
              assembled += data.text as string;
              setDraftMessages((prev) =>
                prev.map((m) => (m.id === asstMsg.id ? { ...m, content: assembled } : m)),
              );
            } else if (event === "done") {
              setDraftMessages((prev) =>
                prev.map((m) => (m.id === asstMsg.id ? { ...m, isStreaming: false } : m)),
              );
            } else if (event === "error") {
              throw new Error((data.message as string) ?? "Coach error");
            }
          }
        }
        if (activeStreamConvRef.current === convId) {
          await qc.invalidateQueries({ queryKey: ["coach-messages", convId] });
          await qc.invalidateQueries({ queryKey: ["coach-conversations", workspaceId] });
          setDraftMessages([]);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Something went wrong";
        setError(msg);
        setDraftMessages((prev) => prev.filter((m) => m.id !== asstMsg.id));
      } finally {
        setStreaming(false);
      }
    },
    [workspaceId, activeConvId, streaming, qc],
  );

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  if (!workspaceId) {
    return <div className="p-6 text-sm text-muted-foreground">Loading workspace…</div>;
  }

  const isEmpty = messages.length === 0;

  return (
    <div className="h-[calc(100vh-4rem)] flex">
      <Card className="w-72 shrink-0 rounded-none border-y-0 border-l-0 flex flex-col">
        <CoachConversationList
          workspaceId={workspaceId}
          conversations={
            (convData?.conversations ?? []) as Array<{
              id: string;
              title: string | null;
              context_type: string | null;
              updated_at: string;
            }>
          }
          activeId={activeConvId}
          onSelect={setActiveConvId}
          loading={convLoading}
        />
      </Card>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="border-b border-border px-4 py-3 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <h1 className="text-sm font-medium">
            {activeConvId
              ? (convData?.conversations.find((c) => c.id === activeConvId)?.title ?? "Untitled")
              : "Coach"}
          </h1>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
          {isEmpty && !msgLoading ? (
            <div className="max-w-2xl mx-auto py-12 space-y-6">
              <div className="text-center space-y-2">
                <MessagesSquare className="h-10 w-10 text-primary mx-auto" />
                <h2 className="text-lg font-semibold">Start a coach conversation</h2>
                <p className="text-sm text-muted-foreground">
                  Ask anything about your workspace. The coach reads your data and gives specific
                  actions with citations.
                </p>
              </div>
              <div className="grid sm:grid-cols-2 gap-2">
                {SUGGESTED_PROMPTS.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => send(p.prompt)}
                    className="text-left text-sm px-3 py-2.5 rounded-md border border-border hover:bg-muted transition"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          ) : msgLoading ? (
            <p className="text-xs text-muted-foreground">Loading messages…</p>
          ) : (
            <div className="max-w-3xl mx-auto space-y-4">
              {messages.map((m) => (
                <CoachMessage key={m.id} msg={m} />
              ))}
              {error && (
                <div className="flex gap-2 items-start p-3 rounded-md bg-destructive/10 border border-destructive/30 text-xs text-destructive">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span className="break-words">{error}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-border p-3">
          <div className="max-w-3xl mx-auto space-y-2">
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
                {streaming ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Send className="h-3 w-3" />
                )}
                <span className="ml-1.5">Send</span>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
