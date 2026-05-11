import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Search, FileText, Loader2 } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { quickSearchHelp } from "@/lib/help.functions";
import type { HelpArticleListItem } from "@/lib/help.server";

const RECENT_KEY = "help.recentSearches";

function getRecent(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
}
function pushRecent(q: string) {
  if (typeof window === "undefined" || !q) return;
  const list = [q, ...getRecent().filter((x) => x !== q)].slice(0, 5);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}

export function SearchModal({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<HelpArticleListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const search = useServerFn(quickSearchHelp);

  // Cmd+K
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (open) {
      setRecent(getRecent());
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQ("");
      setResults([]);
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await search({ data: { q } });
        setResults(res.results);
        setActive(0);
      } finally {
        setLoading(false);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [q, search]);

  function go(item: HelpArticleListItem) {
    pushRecent(q.trim());
    onOpenChange(false);
    navigate({ to: `/help/${item.category_slug}/${item.slug}` });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[active]) go(results[active]);
      else if (q.trim()) {
        onOpenChange(false);
        navigate({ to: "/help/search", search: { q: q.trim() } });
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 max-w-2xl overflow-hidden gap-0">
        <DialogTitle className="sr-only">Search the help center</DialogTitle>
        <div className="flex items-center gap-2 px-4 border-b border-border">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search the help center..."
            className="flex-1 h-12 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
          />
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          <kbd className="text-[10px] font-mono text-muted-foreground border border-border rounded px-1.5 py-0.5">ESC</kbd>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {q.trim() === "" ? (
            recent.length > 0 ? (
              <div className="p-2">
                <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Recent searches</div>
                {recent.map((r) => (
                  <button
                    key={r}
                    onClick={() => setQ(r)}
                    className="w-full text-left px-3 py-2 rounded text-sm hover:bg-accent"
                  >
                    {r}
                  </button>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center text-sm text-muted-foreground">
                Start typing to search articles…
              </div>
            )
          ) : results.length === 0 && !loading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No articles found for <strong className="text-foreground">"{q}"</strong>.
            </div>
          ) : (
            <div className="p-2">
              {results.map((r, i) => (
                <button
                  key={r.id}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(r)}
                  className={`w-full text-left px-3 py-2.5 rounded flex items-start gap-3 ${
                    i === active ? "bg-accent" : "hover:bg-accent/50"
                  }`}
                >
                  <FileText className="h-4 w-4 mt-0.5 text-muted-foreground flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{r.title}</div>
                    {r.excerpt && (
                      <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{r.excerpt}</div>
                    )}
                  </div>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground mt-1">
                    {r.category_slug.replace(/-/g, " ")}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
