import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { getHelpCategory } from "@/lib/help.functions";
import { Breadcrumb } from "@/components/help/Breadcrumb";
import { ArticleRow } from "@/components/help/ArticleCard";
import { canonicalUrl } from "@/lib/canonical";

export const Route = createFileRoute("/help/$category")({
  loader: async ({ params }) => {
    const data = await getHelpCategory({ data: { slug: params.category } });
    if (!data.category) throw notFound();
    return data;
  },
  head: ({ loaderData }) => {
    const c = loaderData?.category;
    const title = c ? `${c.name} — founders.click Help` : "Help Center";
    const desc = c?.description ?? "founders.click Help Center";
    return {
      meta: [
        { title },
        { name: "description", content: desc },
        { property: "og:title", content: title },
        { property: "og:description", content: desc },
        { property: "og:url", content: canonicalUrl(c ? `/help/${c.slug}` : "/help") },
      ],
      links: c ? [{ rel: "canonical", href: canonicalUrl(`/help/${c.slug}`) }] : [],
    };
  },
  component: CategoryPage,
  notFoundComponent: () => (
    <div className="max-w-2xl mx-auto px-6 py-20 text-center">
      <h1 className="text-2xl font-semibold">Category not found</h1>
      <Link to="/help" className="text-orange-500 hover:underline mt-4 inline-block">← Back to Help Center</Link>
    </div>
  ),
});

function CategoryPage() {
  const { category, articles, otherCategories } = Route.useLoaderData();
  if (!category) return null;

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      <Breadcrumb items={[{ label: category.name }]} />
      <header className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight">{category.name}</h1>
        {category.description && (
          <p className="mt-2 text-muted-foreground max-w-2xl">{category.description}</p>
        )}
      </header>

      <div className="grid lg:grid-cols-[1fr_240px] gap-12">
        <div>
          {articles.length === 0 ? (
            <p className="text-sm text-muted-foreground">No articles yet.</p>
          ) : (
            <div className="border border-border rounded-lg bg-card px-3">
              {articles.map((a) => <ArticleRow key={a.id} article={a} />)}
            </div>
          )}
        </div>

        <aside className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Other categories</h2>
          {otherCategories.map((c) => (
            <Link
              key={c.id}
              to={`/help/${c.slug}`}
              className="block text-sm text-muted-foreground hover:text-foreground py-1.5"
            >
              {c.name}
            </Link>
          ))}
        </aside>
      </div>
    </div>
  );
}
