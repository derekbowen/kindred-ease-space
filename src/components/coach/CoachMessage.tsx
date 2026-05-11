import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { Badge } from "@/components/ui/badge";
import { Wrench, ChevronDown, ChevronRight, ExternalLink, Quote } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToolCallShape = {
  name: string;
  input?: unknown;
  output?: unknown;
  status?: "running" | "done" | "error";
  error?: string;
};

export type Citation = { title?: string; url?: string; snippet?: string; source?: string };

export type CoachMsg = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  tool_calls?: ToolCallShape[];
  created_at?: string;
  isStreaming?: boolean;
};

/**
 * Extract a flat list of citations from a message.
 *
 * Sources, in order:
 *   1. tool_calls entry whose name is "citations" — output is the array
 *   2. any tool_call output that is (or contains) an array of objects with a
 *      `url` field. Common shapes:
 *        - output: [{ url, title, snippet }]
 *        - output: { citations: [...] }
 *        - output: { sources: [...] }
 *        - output: { results: [{ url, title }] }
 */
export function extractCitations(toolCalls?: ToolCallShape[]): Citation[] {
  if (!toolCalls?.length) return [];
  const out: Citation[] = [];
  const looksLikeCitation = (v: unknown): v is Citation =>
    !!v && typeof v === "object" && typeof (v as Record<string, unknown>).url === "string";

  for (const tc of toolCalls) {
    if (tc.name === "citations" && Array.isArray(tc.output)) {
      for (const c of tc.output) if (looksLikeCitation(c)) out.push(c);
      continue;
    }
    const o = tc.output;
    if (Array.isArray(o)) {
      for (const c of o) if (looksLikeCitation(c)) out.push({ ...c, source: tc.name });
    } else if (o && typeof o === "object") {
      const rec = o as Record<string, unknown>;
      for (const key of ["citations", "sources", "results", "items"]) {
        const arr = rec[key];
        if (Array.isArray(arr)) {
          for (const c of arr) if (looksLikeCitation(c)) out.push({ ...c, source: tc.name });
        }
      }
    }
  }
  // Dedup by url
  const seen = new Set<string>();
  return out.filter((c) => {
    if (!c.url || seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
}

export function CoachMessage({ msg, dense = false }: { msg: CoachMsg; dense?: boolean }) {
  const citations = useMemo(() => extractCitations(msg.tool_calls), [msg.tool_calls]);

  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className={cn("bg-primary text-primary-foreground rounded-lg px-3 py-2 text-sm max-w-[85%] whitespace-pre-wrap break-words", dense && "text-xs")}>
          {msg.content}
        </div>
      </div>
    );
  }

  if (msg.role === "system") {
    return (
      <div className="text-[11px] text-muted-foreground italic px-3 py-1.5 border-l-2 border-border">
        {msg.content}
      </div>
    );
  }

  if (msg.role !== "assistant" && msg.role !== "tool") return null;

  return (
    <div className="space-y-2">
      {msg.tool_calls && msg.tool_calls.length > 0 && (
        <div className="space-y-1">
          {msg.tool_calls
            .filter((tc) => tc.name !== "citations")
            .map((tc, i) => <ToolCallCard key={i} tc={tc} />)}
        </div>
      )}

      {msg.content && (
        <div className={cn("prose prose-sm max-w-none break-words", dense && "prose-xs text-sm")}>
          <ReactMarkdown
            components={{
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer" className="underline">{children}</a>
              ),
            }}
          >
            {msg.content || (msg.isStreaming ? "…" : "")}
          </ReactMarkdown>
        </div>
      )}

      {citations.length > 0 && (
        <div className="rounded-md border border-border bg-muted/20 p-2 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Quote className="h-3 w-3" /> Citations
          </div>
          <ul className="space-y-1">
            {citations.map((c, i) => (
              <li key={i} className="text-xs">
                <a
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-start gap-1 hover:underline"
                >
                  <span className="text-muted-foreground tabular-nums shrink-0">[{i + 1}]</span>
                  <span className="font-medium">{c.title ?? c.url}</span>
                  <ExternalLink className="h-3 w-3 mt-0.5 shrink-0 opacity-60" />
                </a>
                {c.snippet && (
                  <p className="text-muted-foreground line-clamp-2 ml-5">{c.snippet}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ToolCallCard({ tc }: { tc: ToolCallShape }) {
  const [open, setOpen] = useState(false);
  const status = tc.status ?? (tc.output !== undefined ? "done" : tc.error ? "error" : "done");
  return (
    <div className="text-xs border border-border rounded-md bg-muted/30">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-muted/50 text-left"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Wrench className="h-3 w-3 text-muted-foreground" />
        <span className="font-mono truncate">{tc.name}</span>
        <Badge
          variant={status === "error" ? "destructive" : "secondary"}
          className="ml-auto h-4 text-[10px] capitalize"
        >
          {status}
        </Badge>
      </button>
      {open && (
        <div className="border-t border-border divide-y divide-border">
          {tc.input !== undefined && (
            <div>
              <div className="px-2 pt-1 text-[10px] uppercase text-muted-foreground">Input</div>
              <pre className="px-2 pb-1 text-[10px] overflow-x-auto max-h-40">
                {safeJson(tc.input)}
              </pre>
            </div>
          )}
          {tc.output !== undefined && (
            <div>
              <div className="px-2 pt-1 text-[10px] uppercase text-muted-foreground">Output</div>
              <pre className="px-2 pb-1 text-[10px] overflow-x-auto max-h-48">
                {safeJson(tc.output)}
              </pre>
            </div>
          )}
          {tc.error && (
            <div>
              <div className="px-2 pt-1 text-[10px] uppercase text-destructive">Error</div>
              <pre className="px-2 pb-1 text-[10px] overflow-x-auto max-h-32 text-destructive">
                {tc.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
