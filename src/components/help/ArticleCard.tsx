import { Link } from "@tanstack/react-router";
import { Clock } from "lucide-react";
import type { HelpArticleListItem } from "@/lib/help.server";

export function ArticleCard({
  article,
  showCategory = false,
}: {
  article: HelpArticleListItem;
  showCategory?: boolean;
}) {
  return (
    <Link
      to="/help/$category/$article"
      params={{ category: article.category_slug, article: article.slug }}
      className="group block rounded-lg border border-border bg-card p-5 hover:border-orange-500/40 transition-colors"
    >
      {showCategory && (
        <span className="inline-block text-[10px] uppercase tracking-wider text-orange-500 font-semibold mb-2">
          {article.category_slug.replace(/-/g, " ")}
        </span>
      )}
      <h3 className="text-base font-semibold tracking-tight group-hover:text-orange-500 transition-colors line-clamp-2">
        {article.title}
      </h3>
      {article.excerpt && (
        <p className="mt-2 text-sm text-muted-foreground line-clamp-2">{article.excerpt}</p>
      )}
      {article.reading_time_minutes && (
        <div className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          {article.reading_time_minutes} min read
        </div>
      )}
    </Link>
  );
}

export function ArticleRow({ article }: { article: HelpArticleListItem }) {
  const snippet = article.headline ?? article.excerpt ?? null;
  return (
    <Link
      to="/help/$category/$article"
      params={{ category: article.category_slug, article: article.slug }}
      className="group flex items-start gap-4 py-4 border-b border-border last:border-0 hover:bg-accent/30 -mx-3 px-3 rounded transition-colors"
    >
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-medium group-hover:text-orange-500 transition-colors">
          {article.title}
        </h3>
        {snippet &&
          (article.headline ? (
            <p
              className="mt-1 text-sm text-muted-foreground line-clamp-2 [&_mark]:bg-orange-500/15 [&_mark]:text-foreground [&_mark]:rounded [&_mark]:px-0.5"
              dangerouslySetInnerHTML={{ __html: snippet }}
            />
          ) : (
            <p className="mt-1 text-sm text-muted-foreground line-clamp-1">{snippet}</p>
          ))}
        <p className="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground/70">
          {article.category_slug.replace(/-/g, " ")}
        </p>
      </div>
      {article.reading_time_minutes && (
        <span className="text-xs text-muted-foreground whitespace-nowrap mt-0.5">
          {article.reading_time_minutes} min
        </span>
      )}
    </Link>
  );
}
