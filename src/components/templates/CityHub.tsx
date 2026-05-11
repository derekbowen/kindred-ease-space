import type { PublicTenantPage } from "@/lib/public-tenant-page.functions";

function fmtPrice(amount: number | null, currency: string | null) {
  if (amount == null || !currency) return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency}`;
  }
}

function md(text: string | null) {
  if (!text) return null;
  // very small markdown: paragraphs split on blank lines
  return text.split(/\n{2,}/).map((p, i) => (
    <p key={i} className="text-foreground/90 leading-relaxed mb-4">
      {p}
    </p>
  ));
}

export function CityHub({ page }: { page: PublicTenantPage }) {
  const city = page.variables?.city as string | undefined;
  const state = page.variables?.state as string | undefined;
  const categoryPlural = (page.variables?.category_plural as string) || "listings";
  const count = page.listings.length;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-10">
        <header className="mb-10">
          <p className="text-sm text-muted-foreground uppercase tracking-wide">
            {[city, state].filter(Boolean).join(", ")}
          </p>
          <h1 className="text-3xl sm:text-5xl font-bold mt-2">
            {page.h1 || page.title}
          </h1>
          <p className="text-muted-foreground mt-3">
            {count} {categoryPlural} available {city ? `in ${city}` : ""}.
          </p>
        </header>

        {page.body_markdown && (
          <section className="prose prose-invert max-w-none mb-10">{md(page.body_markdown)}</section>
        )}

        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {page.listings.map((l) => {
            const img = l.images?.[0];
            const price = fmtPrice(l.price_amount, l.price_currency);
            return (
              <article
                key={l.id}
                itemScope
                itemType="https://schema.org/Product"
                className="rounded-xl overflow-hidden border border-border bg-card hover:border-primary/50 transition"
              >
                <a
                  href={l.marketplace_url}
                  target="_blank"
                  rel="noopener nofollow"
                  className="block"
                >
                  {img?.url && (
                    <img
                      src={img.url}
                      alt={img.alt || l.title}
                      loading="lazy"
                      width={img.width ?? undefined}
                      height={img.height ?? undefined}
                      className="w-full aspect-video object-cover"
                      itemProp="image"
                    />
                  )}
                  <div className="p-4">
                    <h2 className="font-semibold line-clamp-2" itemProp="name">
                      {l.title}
                    </h2>
                    {(l.city || l.state) && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {[l.city, l.state].filter(Boolean).join(", ")}
                      </p>
                    )}
                    {price && (
                      <p className="mt-2 font-medium" itemProp="offers" itemScope itemType="https://schema.org/Offer">
                        <span itemProp="price">{price}</span>
                      </p>
                    )}
                    {l.description && (
                      <p className="text-sm text-muted-foreground mt-2 line-clamp-3" itemProp="description">
                        {l.description}
                      </p>
                    )}
                  </div>
                </a>
              </article>
            );
          })}
        </section>

        {count === 0 && (
          <div className="rounded-lg border border-border p-8 text-center text-muted-foreground">
            No listings available right now. Check back soon.
          </div>
        )}
      </main>
    </div>
  );
}
