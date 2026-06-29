import { Link } from "@tanstack/react-router";
import * as Icons from "lucide-react";
import type { HelpCategory } from "@/lib/help.server";
import { ArrowRight } from "lucide-react";

function Icon({ name, className }: { name: string | null; className?: string }) {
  const Cmp = name
    ? (Icons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[name]
    : null;
  if (!Cmp) return <Icons.BookOpen className={className} />;
  return <Cmp className={className} />;
}

export function CategoryCard({
  category,
  topArticles,
  count,
}: {
  category: HelpCategory;
  topArticles?: Array<{ slug: string; title: string }>;
  count?: number;
}) {
  return (
    <Link
      to="/help/$category"
      params={{ category: category.slug }}
      className="group block rounded-xl border border-border bg-card p-6 hover:border-orange-500/50 hover:shadow-lg transition-all"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="h-10 w-10 rounded-lg bg-orange-500/10 flex items-center justify-center text-orange-500">
          <Icon name={category.icon} className="h-5 w-5" />
        </div>
        {typeof count === "number" && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {count} article{count === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <h3 className="mt-4 text-base font-semibold tracking-tight group-hover:text-orange-500 transition-colors">
        {category.name}
      </h3>
      {category.description && (
        <p className="mt-1.5 text-sm text-muted-foreground line-clamp-2">{category.description}</p>
      )}
      {topArticles && topArticles.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {topArticles.slice(0, 3).map((a) => (
            <li key={a.slug} className="text-sm text-muted-foreground line-clamp-1">
              · {a.title}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-5 flex items-center text-xs font-medium text-orange-500 opacity-0 group-hover:opacity-100 transition-opacity">
        Explore <ArrowRight className="ml-1 h-3 w-3" />
      </div>
    </Link>
  );
}
