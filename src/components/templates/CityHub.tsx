import { MarkdownRenderer } from "@/components/help/MarkdownRenderer";
import type { PublicTenantPage } from "@/lib/public-tenant-page.functions";

function fmtPrice(amount: number | null, currency: string | null) {
  if (amount == null || !currency) return null;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency}`;
  }
}

export function CityHub({ page }: { page: PublicTenantPage }) {
  const city = page.variables?.city as string | undefined;
  const state = page.variables?.state as string | undefined;
  const categoryPlural = (page.variables?.category_plural as string) || "listings";
  const count = page.listings.length;
  const location = [city, state].filter(Boolean).join(", ");

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="border-b border-border/60 bg-gradient-to-b from-primary/5 to-transparent">
        <main className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <header className="max-w-3xl">
            {location && (
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary/80">
                {location}
              </p>
            )}
            <h1 className="mt-3 text-3xl font-bold tracking-tight sm:text-5xl sm:leading-tight">
              {page.h1 || page.title}
            </h1>
            {page.meta_description && (
              <p className="mt-4 text-lg text-muted-foreground leading-relaxed">
                {page.meta_description}
              </p>
            )}
            {city && (
              <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-border/60 bg-card px-4 py-1.5 text-sm">
                <span className="font-semibold text-foreground">{count}</span>
                <span className="text-muted-foreground">
                  {categoryPlural} available in {city}
                </span>
              </p>
            )}
          </header>
        </main>
      </div>

      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        {page.body_markdown && (
          <section className="mb-12 max-w-3xl">
            <MarkdownRenderer content={page.body_markdown} />
          </section>
        )}

        {count > 0 && (
          <section>
            <div className="mb-6 flex items-end justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
                  Browse {categoryPlural}
                </h2>
                {city && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    Live inventory from {page.workspace_name || "the marketplace"}
                  </p>
                )}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {page.listings.map((l) => {
                const img = l.images?.[0];
                const price = fmtPrice(l.price_amount, l.price_currency);
                return (
                  <article
                    key={l.id}
                    itemScope
                    itemType="https://schema.org/Product"
                    className="group overflow-hidden rounded-xl border border-border bg-card transition hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5"
                  >
                    <a
                      href={l.marketplace_url}
                      target="_blank"
                      rel="noopener nofollow"
                      className="block"
                    >
                      <div className="relative aspect-video overflow-hidden bg-muted">
                        {img?.url ? (
                          <img
                            src={img.url}
                            alt={img.alt || l.title}
                            loading="lazy"
                            width={img.width ?? undefined}
                            height={img.height ?? undefined}
                            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
                            itemProp="image"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center bg-gradient-to-br from-primary/10 to-muted text-muted-foreground text-sm">
                            No image
                          </div>
                        )}
                        {price && (
                          <span
                            className="absolute bottom-2 right-2 rounded-md bg-background/90 px-2 py-1 text-sm font-semibold backdrop-blur"
                            itemProp="offers"
                            itemScope
                            itemType="https://schema.org/Offer"
                          >
                            <span itemProp="price">{price}</span>
                          </span>
                        )}
                      </div>
                      <div className="p-4">
                        <h3
                          className="font-semibold leading-snug line-clamp-2 group-hover:text-primary transition-colors"
                          itemProp="name"
                        >
                          {l.title}
                        </h3>
                        {(l.city || l.state) && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {[l.city, l.state].filter(Boolean).join(", ")}
                          </p>
                        )}
                        {l.description && (
                          <p
                            className="mt-2 text-sm text-muted-foreground line-clamp-2"
                            itemProp="description"
                          >
                            {l.description}
                          </p>
                        )}
                      </div>
                    </a>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {count === 0 && city && (
          <div className="rounded-xl border border-dashed border-border p-10 text-center">
            <p className="font-medium">Listings coming soon</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Sync your Sharetribe inventory to populate this city grid automatically.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
