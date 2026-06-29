import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { searchHelp } from "@/lib/help.functions";
import { Breadcrumb } from "@/components/help/Breadcrumb";
import { ArticleRow, ArticleCard } from "@/components/help/ArticleCard";
import { canonicalUrl } from "@/lib/canonical";
import { Search, Sparkles, LifeBuoy } from "lucide-react";

const searchSchema = z.object({ q: z.string().optional().default("") });

export const Route = createFileRoute("/help/search")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: ({ deps }) => searchHelp({ data: { q: deps.q } }),
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.query
          ? `Search: ${loaderData.query} — founders.click Help`
          : "Search — founders.click Help",
      },
      { name: "robots", content: "noindex" },
    ],
    links: [{ rel: "canonical", href: canonicalUrl("/help/search") }],
  }),
  component: SearchPage,
});

function SearchPage() {
  const { query, results, categories, suggestions, popular } = Route.useLoaderData();

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <Breadcrumb items={[{ label: "Search" }]} />

      <form action="/help/search" method="get" className="mb-8">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            name="q"
            type="search"
            defaultValue={query}
            placeholder="Search articles..."
            autoFocus
            className="w-full h-12 pl-11 pr-4 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/40"
          />
        </div>
      </form>

      {!query ? (
        <EmptyState popular={popular} />
      ) : results.length === 0 ? (
        <NoResults query={query} suggestions={suggestions} popular={popular} />
      ) : (
        <>
          <p className="text-sm text-muted-foreground mb-4">
            {results.length} {results.length === 1 ? "result" : "results"} for{" "}
            <strong className="text-foreground">"{query}"</strong>
          </p>

          {suggestions.length > 0 && <DidYouMean query={query} suggestions={suggestions} compact />}

          <div className="border border-border rounded-lg bg-card px-3">
            {results.map((a: any) => (
              <ArticleRow key={a.id} article={a} />
            ))}
          </div>
        </>
      )}

      {categories.length > 0 && query && results.length > 0 && (
        <aside className="mt-12 pt-8 border-t border-border">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Browse categories
          </h2>
          <div className="flex flex-wrap gap-2">
            {categories.map((c: any) => (
              <Link
                key={c.id}
                to="/help/$category"
                params={{ category: c.slug }}
                className="rounded-full border border-border px-3 py-1 text-sm hover:border-orange-500 hover:text-orange-500"
              >
                {c.name}
              </Link>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}

function DidYouMean({
  query,
  suggestions,
  compact = false,
}: {
  query: string;
  suggestions: { title: string; slug: string; category_slug: string }[];
  compact?: boolean;
}) {
  if (!suggestions.length) return null;
  return (
    <div
      className={`rounded-lg border border-orange-500/20 bg-orange-500/5 px-4 py-3 ${
        compact ? "mb-4" : "mb-6"
      }`}
    >
      <p className="text-xs font-medium text-orange-600 inline-flex items-center gap-1.5">
        <Sparkles className="h-3 w-3" />
        Did you mean
      </p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {suggestions.map((s) => (
          <li key={`${s.category_slug}/${s.slug}`}>
            <Link
              to="/help/$category/$article"
              params={{ category: s.category_slug, article: s.slug }}
              className="inline-flex items-center rounded-full bg-background border border-border px-3 py-1 text-sm hover:border-orange-500 hover:text-orange-500"
            >
              {s.title}
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        Searched for "<span className="font-medium text-foreground">{query}</span>".
      </p>
    </div>
  );
}

function NoResults({
  query,
  suggestions,
  popular,
}: {
  query: string;
  suggestions: { title: string; slug: string; category_slug: string }[];
  popular: {
    id: string;
    slug: string;
    title: string;
    category_slug: string;
    excerpt: string | null;
    reading_time_minutes: number | null;
    view_count: number;
    published_at: string | null;
    updated_at: string;
  }[];
}) {
  return (
    <div>
      <div className="text-center py-10 border border-dashed border-border rounded-lg">
        <Search className="mx-auto h-8 w-8 text-muted-foreground/40" aria-hidden />
        <h2 className="mt-3 text-lg font-semibold">No articles match "{query}"</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">
          Try shorter, more general words — or check the suggestions below.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link
            to="/help"
            className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm hover:border-orange-500 hover:text-orange-500"
          >
            Browse the help center
          </Link>
          <Link
            to="/help/contact"
            className="inline-flex items-center gap-1.5 rounded-md bg-orange-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-600"
          >
            <LifeBuoy className="h-3.5 w-3.5" />
            Contact support
          </Link>
        </div>
      </div>

      {suggestions.length > 0 && (
        <div className="mt-8">
          <DidYouMean query={query} suggestions={suggestions} />
        </div>
      )}

      <div className="mt-8">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Search tips
        </h3>
        <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
          <li>
            Use one or two specific keywords (e.g. "billing" instead of "how do I pay my invoice")
          </li>
          <li>
            Try different wording — synonyms like "login" / "sign in" are matched automatically
          </li>
          <li>Check spelling — we'll suggest close matches when we find them</li>
        </ul>
      </div>

      {popular.length > 0 && (
        <div className="mt-10">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Popular articles
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {popular.slice(0, 6).map((a) => (
              <ArticleCard key={a.id} article={a} showCategory />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({
  popular,
}: {
  popular: {
    id: string;
    slug: string;
    title: string;
    category_slug: string;
    excerpt: string | null;
    reading_time_minutes: number | null;
    view_count: number;
    published_at: string | null;
    updated_at: string;
  }[];
}) {
  return (
    <div>
      <p className="text-sm text-muted-foreground">Type a search query above.</p>
      {popular.length > 0 && (
        <div className="mt-8">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Popular articles
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {popular.slice(0, 6).map((a) => (
              <ArticleCard key={a.id} article={a} showCategory />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
