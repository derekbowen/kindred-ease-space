import { createFileRoute, Link } from "@tanstack/react-router";
import { getHelpHome } from "@/lib/help.functions";
import { CategoryCard } from "@/components/help/CategoryCard";
import { ArticleCard, ArticleRow } from "@/components/help/ArticleCard";
import { canonicalUrl } from "@/lib/canonical";
import { Search, MessageCircle } from "lucide-react";

export const Route = createFileRoute("/help/")({
  loader: () => getHelpHome(),
  head: () => ({
    meta: [
      { title: "Help Center — founders.click" },
      {
        name: "description",
        content:
          "Guides, troubleshooting, and answers for Sharetribe marketplace operators using founders.click.",
      },
      { property: "og:title", content: "founders.click Help Center" },
      {
        property: "og:description",
        content: "Everything you need to launch, sync, and scale your marketplace SEO.",
      },
      { property: "og:url", content: canonicalUrl("/help") },
    ],
    links: [{ rel: "canonical", href: canonicalUrl("/help") }],
  }),
  component: HelpHome,
});

function HelpHome() {
  const { categories, popular, recent, countsBySlug } = Route.useLoaderData();

  return (
    <>
      {/* Hero */}
      <section className="border-b border-border bg-gradient-to-b from-orange-500/5 to-transparent">
        <div className="max-w-4xl mx-auto px-6 py-16 sm:py-20 text-center">
          <h1 className="text-3xl sm:text-5xl font-bold tracking-tight">How can we help?</h1>
          <p className="mt-4 text-base sm:text-lg text-muted-foreground max-w-xl mx-auto">
            Search the docs, browse by category, or get in touch with our team.
          </p>
          <form action="/help/search" method="get" className="mt-8 max-w-xl mx-auto">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                name="q"
                type="search"
                placeholder="Search articles..."
                className="w-full h-12 pl-11 pr-4 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/40 focus:border-orange-500 transition"
              />
            </div>
          </form>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-6 py-12">
        {/* Categories */}
        <section>
          <h2 className="text-xl font-semibold tracking-tight mb-6">Browse by category</h2>
          {categories.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card/50 p-10 text-center">
              <p className="text-sm font-medium">No categories yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                We're putting the finishing touches on our help content. In the meantime,{" "}
                <Link to="/help/contact" className="text-orange-500 hover:underline">
                  contact support
                </Link>{" "}
                and we'll get back to you within one business day.
              </p>
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {categories.map((c: any) => (
                <CategoryCard key={c.id} category={c} count={countsBySlug[c.slug]} />
              ))}
            </div>
          )}
        </section>

        {/* Popular */}
        {popular.length > 0 && (
          <section className="mt-16">
            <h2 className="text-xl font-semibold tracking-tight mb-6">Popular articles</h2>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {popular.map((a: any) => (
                <ArticleCard key={a.id} article={a} showCategory />
              ))}
            </div>
          </section>
        )}

        {/* Recent */}
        {recent.length > 0 && (
          <section className="mt-16">
            <h2 className="text-xl font-semibold tracking-tight mb-2">Recently updated</h2>
            <div className="border border-border rounded-lg bg-card px-3">
              {recent.map((a: any) => (
                <ArticleRow key={a.id} article={a} />
              ))}
            </div>
          </section>
        )}

        {/* CTA */}
        <section className="mt-16 rounded-xl border border-border bg-card p-8 text-center">
          <MessageCircle className="h-8 w-8 text-orange-500 mx-auto" />
          <h2 className="mt-3 text-lg font-semibold">Still need help?</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Our team usually replies within 1 business day.
          </p>
          <Link
            to="/help/contact"
            className="mt-5 inline-flex items-center justify-center rounded-md bg-orange-500 px-5 py-2 text-sm font-medium text-white hover:bg-orange-600 transition-colors"
          >
            Contact support
          </Link>
        </section>
      </div>
    </>
  );
}
