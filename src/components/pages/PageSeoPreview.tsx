import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { AlertCircle, CheckCircle2, Globe } from "lucide-react";

type Props = {
  title: string;
  slug: string;
  metaDescription: string;
  domain?: string | null;
};

function truncate(s: string, n: number) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

export function PageSeoPreview({ title, slug, metaDescription, domain }: Props) {
  const displayHost =
    domain?.replace(/^https?:\/\//, "").replace(/\/$/, "") || "your-marketplace.com";
  const path = slug ? `/p/${slug}` : "/p/your-slug";
  const canonical = `https://${displayHost.replace(/^www\./, "")}${path}`;

  const issues = useMemo(() => {
    const out: { level: "warn" | "error" | "ok"; msg: string }[] = [];
    if (!title.trim()) out.push({ level: "error", msg: "Add a page title" });
    if (!slug.trim()) out.push({ level: "error", msg: "Add a URL slug" });
    if (!metaDescription.trim())
      out.push({ level: "warn", msg: "Meta description empty — Google will auto-generate one" });
    if (title.length > 60)
      out.push({ level: "warn", msg: `Title is ${title.length} chars — Google truncates near 60` });
    if (metaDescription.length > 160)
      out.push({
        level: "warn",
        msg: `Description is ${metaDescription.length} chars — truncates near 160`,
      });
    if (slug && !/^[a-z0-9][a-z0-9-]*$/.test(slug))
      out.push({ level: "error", msg: "Slug: lowercase letters, numbers, hyphens only" });
    if (out.length === 0) out.push({ level: "ok", msg: "SEO looks solid — ship it" });
    return out;
  }, [title, slug, metaDescription]);

  return (
    <Card className="overflow-hidden border-border/60 bg-card/50">
      <div className="border-b border-border/60 bg-muted/30 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Search preview
          </p>
          <Badge variant="secondary" className="text-[10px] font-normal">
            Live
          </Badge>
        </div>
      </div>
      <div className="space-y-4 p-4">
        <ul className="space-y-1">
          {issues.map((i, idx) => {
            const Icon = i.level === "ok" ? CheckCircle2 : AlertCircle;
            const color =
              i.level === "ok"
                ? "text-emerald-500"
                : i.level === "error"
                  ? "text-destructive"
                  : "text-amber-500";
            return (
              <li key={idx} className="flex items-start gap-1.5 text-xs">
                <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${color}`} />
                <span className="text-muted-foreground">{i.msg}</span>
              </li>
            );
          })}
        </ul>

        <div className="rounded-lg border border-border bg-background p-3 shadow-sm">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Globe className="h-3 w-3" />
            <span className="truncate">{displayHost}</span>
            <span className="text-muted-foreground/40">›</span>
            <span className="truncate font-mono text-[10px]">{path}</span>
          </div>
          <p className="mt-1.5 text-base leading-snug text-[#1a0dab] dark:text-blue-400 line-clamp-1">
            {truncate(title || "Your page title", 70)}
          </p>
          <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
            {truncate(metaDescription || "Your meta description appears here.", 170)}
          </p>
          <p className="mt-2 text-[10px] text-muted-foreground/70">
            title {title.length}/60 · desc {metaDescription.length}/160
          </p>
        </div>

        <p className="truncate font-mono text-[10px] text-muted-foreground">{canonical}</p>
      </div>
    </Card>
  );
}
