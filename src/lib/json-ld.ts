/**
 * Serialise structured data for an inline <script type="application/ld+json">.
 *
 * JSON.stringify does not escape "<", so a value containing "</script>" ends
 * the script element early and the remainder is parsed as HTML. Listing titles
 * come from third-party marketplace sellers and reach the customer's own
 * verified domain, so this is the one place that difference is load-bearing.
 * Escaping "<" as < is valid JSON and inert inside a script element.
 * U+2028/U+2029 are JSON-legal but are line terminators in JavaScript source.
 */
export function safeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// ---------------------------------------------------------------------------
// Builders for customers' pages. Every value they emit is a fact the page
// shows: a listing's name, link, photo and — only when its card shows one — its
// price with the currency. They never state availability, stock, reviews or
// ratings: the page shows none of those, and the listings' stored
// structured_data (which claims InStock) is not emitted at all.
// ---------------------------------------------------------------------------

const CONTEXT = "https://schema.org";

/** One shown listing, as its card shows it. */
export type ItemListEntry = {
  name: string;
  url: string | null;
  image: string | null;
  /** Only when the card shows a price. `amount` is a decimal string in major units. */
  price: { amount: string; currency: string; unit: string | null } | null;
};

/**
 * An ItemList of the listings shown, in order. A priced listing is an Offer
 * (price + priceCurrency, plus the pricing unit the card names); an unpriced
 * one is a plain Thing — no Product (not a product page), no availability.
 */
export function itemListJsonLd(
  name: string,
  entries: readonly ItemListEntry[],
): Record<string, unknown> | null {
  if (entries.length === 0) return null;
  return {
    "@context": CONTEXT,
    "@type": "ItemList",
    name,
    numberOfItems: entries.length,
    itemListElement: entries.map((e, i) => {
      const base: Record<string, unknown> = { name: e.name };
      if (e.url) base.url = e.url;
      if (e.image) base.image = e.image;
      let item: Record<string, unknown>;
      if (e.price && e.price.amount && e.price.currency) {
        item = {
          "@type": "Offer",
          ...base,
          price: e.price.amount,
          priceCurrency: e.price.currency,
        };
        if (e.price.unit) {
          item.priceSpecification = {
            "@type": "UnitPriceSpecification",
            price: e.price.amount,
            priceCurrency: e.price.currency,
            unitText: e.price.unit,
          };
        }
      } else {
        item = { "@type": "Thing", ...base };
      }
      return { "@type": "ListItem", position: i + 1, item };
    }),
  };
}

/** A BreadcrumbList of the visible trail. Fewer than two linked steps → null. */
export function breadcrumbJsonLd(
  items: ReadonlyArray<{ name: string; url: string }>,
): Record<string, unknown> | null {
  const steps = items.filter((s) => s.name.trim() && s.url);
  if (steps.length < 2) return null;
  return {
    "@context": CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: steps.map((s, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: s.name,
      item: s.url,
    })),
  };
}

export type ArticleFacts = {
  headline: string;
  description?: string | null;
  url?: string | null;
  image?: string | null;
  datePublished?: string | null;
  dateModified?: string | null;
  /** The brand the page is published under. */
  publisher?: { name: string; url?: string | null; logo?: string | null } | null;
};

/** An Article for an editorial page. The publisher (and author) is the customer's brand. */
export function articleJsonLd(a: ArticleFacts): Record<string, unknown> {
  const out: Record<string, unknown> = {
    "@context": CONTEXT,
    "@type": "Article",
    headline: a.headline,
  };
  if (a.description) out.description = a.description;
  if (a.url) {
    out.url = a.url;
    out.mainEntityOfPage = { "@type": "WebPage", "@id": a.url };
  }
  if (a.image) out.image = a.image;
  if (a.datePublished) out.datePublished = a.datePublished;
  if (a.dateModified) out.dateModified = a.dateModified;
  const name = a.publisher?.name?.trim();
  if (name) {
    const org: Record<string, unknown> = { "@type": "Organization", name };
    if (a.publisher?.url) org.url = a.publisher.url;
    if (a.publisher?.logo) org.logo = { "@type": "ImageObject", url: a.publisher.logo };
    out.publisher = org;
    out.author = {
      "@type": "Organization",
      name,
      ...(a.publisher?.url ? { url: a.publisher.url } : {}),
    };
  }
  return out;
}
