import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { searchHelp } from "@/lib/help.functions";
import { Breadcrumb } from "@/components/help/Breadcrumb";
import { ArticleRow } from "@/components/help/ArticleCard";
import { canonicalUrl } from "@/lib/canonical";
import { Search } from "lucide-react";

const searchSchema = z.object({ q: z.string().optional().default("") });

export const Route = createFileRoute("/help/search")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: ({ deps }) => searchHelp({ data: { q: deps.q } }),
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData?.query ? `Search: ${loaderData.query} — founders.click Help` : "Search — founders.click Help" },
      { name: "robots", content: "noindex" },
    ],
    links: [{ rel: "canonical", href: canonicalUrl("/help/search") }],
  }),
  component: SearchPage,
});

function SearchPage() {
  const { query, results, categories } = Route.useLoaderData();

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
            className="w-full h-12 pl-11 pr-4 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/40"
          />
        </div>
      </form>

      {!query ? (
        <p className="text-sm text-muted-foreground">Type a search query above.</p>
      ) : results.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">No articles found for <strong className="text-foreground">"{query}"</strong>.</p>
          <Link to="/help/contact" className="mt-4 inline-block text-orange-500 hover:underline">Can't find what you need? Contact support →</Link>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground mb-4">
            {results.length} {results.length === 1 ? "result" : "results"} for <strong className="text-foreground">"{query}"</strong>
          </p>
          <div className="border border-border rounded-lg bg-card px-3">
            {results.map((a) => <ArticleRow key={a.id} article={a} />)}
          </div>
        </>
      )}

      {categories.length > 0 && (
        <aside className="mt-12 pt-8 border-t border-border">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Browse categories</h2>
          <div className="flex flex-wrap gap-2">
            {categories.map((c) => (
              <Link key={c.id} to={`/help/${c.slug}`} className="rounded-full border border-border px-3 py-1 text-sm hover:border-orange-500 hover:text-orange-500">
                {c.name}
              </Link>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}
