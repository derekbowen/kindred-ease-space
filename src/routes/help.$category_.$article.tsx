import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { getHelpArticle } from "@/lib/help.functions";
import { safeJsonLd } from "@/lib/json-ld";
import { Breadcrumb } from "@/components/help/Breadcrumb";
import { MarkdownRenderer } from "@/components/help/MarkdownRenderer";
import { HelpfulFeedback } from "@/components/help/HelpfulFeedback";
import { ArticleCard } from "@/components/help/ArticleCard";
import { canonicalUrl } from "@/lib/canonical";
import {
  ARTICLE_BODY_CLASS,
  formatHelpDate,
  helpArticlePath,
  stripLeadingTitle,
} from "@/components/help-article-content";
import { Clock, Calendar, MessageCircle } from "lucide-react";

// NOT NESTED under /help/$category. The trailing underscore on `$category_`
// is TanStack Router's non-nested marker: this route's parent is the /help
// layout (src/routes/help.tsx, which renders the <Outlet/>), and its URL is
// still /help/$category/$article. Nested under the category route — whose
// component renders no <Outlet/> — every article URL showed the category page
// with only the article's <title>, and a 404 category above a found article
// hydrated differently on the client than on the server (React #418).
export const Route = createFileRoute("/help/$category_/$article")({
  loader: async ({ params }) => {
    const data = await getHelpArticle({
      data: { categorySlug: params.category, articleSlug: params.article },
    });
    if (!data.article) throw notFound();
    return data;
  },
  head: ({ loaderData }) => {
    const a = loaderData?.article;
    if (!a) {
      return {
        meta: [
          { title: "Article not found — founders.click Help" },
          { name: "robots", content: "noindex" },
        ],
      };
    }
    // The article's own URL, from the row — the one canonical, og:url and
    // JSON-LD all name. Nothing from a parent route is merged in any more.
    const url = canonicalUrl(helpArticlePath(a.category_slug, a.slug));
    const categoryName = loaderData?.category?.name ?? a.category_slug;
    return {
      meta: [
        { title: `${a.title} — founders.click Help` },
        { name: "description", content: a.excerpt ?? a.title },
        { property: "og:type", content: "article" },
        { property: "og:title", content: a.title },
        { property: "og:description", content: a.excerpt ?? a.title },
        { property: "og:url", content: url },
        { property: "article:published_time", content: a.published_at ?? "" },
        { property: "article:modified_time", content: a.updated_at },
      ],
      links: [{ rel: "canonical", href: url }],
      scripts: [
        {
          type: "application/ld+json",
          children: safeJsonLd({
            "@context": "https://schema.org",
            "@type": "Article",
            headline: a.title,
            description: a.excerpt,
            datePublished: a.published_at,
            dateModified: a.updated_at,
            author: { "@type": "Organization", name: a.author_name ?? "founders.click" },
            mainEntityOfPage: url,
          }),
        },
        {
          type: "application/ld+json",
          children: safeJsonLd({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: "Help", item: canonicalUrl("/help") },
              {
                "@type": "ListItem",
                position: 2,
                name: categoryName,
                item: canonicalUrl(`/help/${a.category_slug}`),
              },
              { "@type": "ListItem", position: 3, name: a.title, item: url },
            ],
          }),
        },
      ],
    };
  },
  component: ArticlePage,
  notFoundComponent: () => (
    <div className="max-w-2xl mx-auto px-6 py-20 text-center">
      <h1 className="text-2xl font-semibold">Article not found</h1>
      <Link to="/help" className="text-orange-500 hover:underline mt-4 inline-block">
        ← Back to Help Center
      </Link>
    </div>
  ),
});

function ArticlePage() {
  const { article, category, related } = Route.useLoaderData();
  if (!article) return null;

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <Breadcrumb
        items={[
          { label: category?.name ?? article.category_slug, to: `/help/${article.category_slug}` },
          { label: article.title },
        ]}
      />

      <header className="mb-8 pb-8 border-b border-border">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">{article.title}</h1>
        {article.excerpt && <p className="mt-3 text-lg text-muted-foreground">{article.excerpt}</p>}
        <div className="mt-5 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          {article.author_name && <span>By {article.author_name}</span>}
          <span className="inline-flex items-center gap-1.5">
            <Calendar className="h-3 w-3" />
            Updated {formatHelpDate(article.updated_at)}
          </span>
          {article.reading_time_minutes && (
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3 w-3" /> {article.reading_time_minutes} min read
            </span>
          )}
        </div>
      </header>

      <article className={ARTICLE_BODY_CLASS}>
        {/* The title above is the page's one <h1>; a leading "# Title" in the
            stored markdown would render a second. */}
        <MarkdownRenderer content={stripLeadingTitle(article.content)} />
      </article>

      <HelpfulFeedback articleId={article.id} />

      {related.length > 0 && (
        <section className="mt-12">
          <h2 className="text-base font-semibold mb-4">Related articles</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            {related.map((a: any) => (
              <ArticleCard key={a.id} article={a} />
            ))}
          </div>
        </section>
      )}

      <section className="mt-12 rounded-lg border border-border bg-card p-6 flex items-start gap-4">
        <MessageCircle className="h-5 w-5 text-orange-500 mt-0.5" />
        <div className="flex-1">
          <h3 className="text-sm font-semibold">Still need help?</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            Our team replies within 1 business day.
          </p>
        </div>
        <Link
          to="/help/contact"
          className="inline-flex items-center rounded-md bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600"
        >
          Contact support
        </Link>
      </section>
    </div>
  );
}
