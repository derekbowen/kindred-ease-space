import { MarkdownRenderer } from "@/components/help/MarkdownRenderer";
import { Badge } from "@/components/ui/badge";
import type { PreviewPage } from "./page-builder-utils";

export function PageLivePreview({ page, domain }: { page: PreviewPage; domain?: string | null }) {
  const host = domain?.replace(/^https?:\/\//, "").replace(/\/$/, "") || "your-marketplace.com";
  const location = [page.city, page.state].filter(Boolean).join(", ");
  const count = page.listingCount ?? 0;
  const categoryPlural = page.categoryPlural || "listings";

  return (
    <div className="overflow-hidden rounded-xl border border-border/80 bg-background shadow-xl">
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-2">
        <div className="flex gap-1">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
        </div>
        <div className="mx-auto flex max-w-[70%] flex-1 items-center justify-center rounded-md bg-background/80 px-3 py-1">
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {host}/p/{page.slug || "your-slug"}
          </span>
        </div>
        <Badge variant="outline" className="text-[9px] shrink-0">
          Preview
        </Badge>
      </div>

      <div className="max-h-[min(70vh,640px)] overflow-y-auto bg-background p-5 sm:p-8">
        {location && (
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {location}
          </p>
        )}
        <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
          {page.h1 || page.title || "Page headline"}
        </h1>
        {page.city && (
          <p className="mt-2 text-sm text-muted-foreground">
            {count > 0 ? (
              <>
                <span className="font-medium text-foreground">{count}</span> {categoryPlural} available
                in {page.city}
              </>
            ) : (
              <>Listing grid pulls from your synced Sharetribe inventory</>
            )}
          </p>
        )}

        {page.bodyMarkdown ? (
          <div className="mt-6">
            <MarkdownRenderer content={page.bodyMarkdown} />
          </div>
        ) : (
          <div className="mt-8 space-y-3">
            <div className="h-3 w-full rounded bg-muted/60" />
            <div className="h-3 w-[92%] rounded bg-muted/50" />
            <div className="h-3 w-[88%] rounded bg-muted/40" />
            <div className="h-3 w-[70%] rounded bg-muted/30" />
            <p className="pt-4 text-xs text-muted-foreground">
              Content appears here as you type or when AI finishes generating.
            </p>
          </div>
        )}

        {page.city && (
          <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {Array.from({ length: Math.min(3, Math.max(1, count)) }).map((_, i) => (
              <div
                key={i}
                className="overflow-hidden rounded-lg border border-border/60 bg-card"
              >
                <div className="aspect-video bg-gradient-to-br from-primary/10 via-muted/30 to-primary/5" />
                <div className="space-y-1.5 p-2.5">
                  <div className="h-2.5 w-4/5 rounded bg-muted" />
                  <div className="h-2 w-1/2 rounded bg-muted/60" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}