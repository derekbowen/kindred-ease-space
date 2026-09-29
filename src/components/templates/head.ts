/**
 * THE <head> OF A CUSTOMER'S PAGE, built from the same TemplateData the page
 * body renders — so the title, description, robots decision, Open Graph tags
 * and structured data can only state what the visitor sees.
 *
 *  - <title> = seo_title, else the page title;
 *  - canonical = https://{the verified hostname the request resolved}/a/{slug};
 *  - robots noindex (follow) when the owner asked for it or the page is thin
 *    (isNoindexPage — the one rule the tenant sitemap applies too; a Resource
 *    Article is judged on its text alone);
 *  - structured data: BreadcrumbList (the visible trail), an ItemList of the
 *    listings shown (an Offer only where the card shows a price, with its
 *    currency), and an Article for a Resource Article. Never availability,
 *    stock, reviews or ratings.
 *
 * Nothing here names the platform: these pages are the customer's.
 */
import { articleJsonLd, breadcrumbJsonLd, itemListJsonLd, safeJsonLd } from "@/lib/json-ld";
import { isNoindexPage, thinPageBodyChars } from "@/lib/thin-page";
import { isoOrNull, pageDescription, pageTitleTag } from "./format";
import type { TemplateData } from "./types";

/**
 * Public page HTML: a browser may reuse it for a minute, so a publish, an
 * edit or an unpublish shows within 60 seconds. PRIVATE: the same path
 * serves every customer's hostname, and a shared cache that ignores Vary
 * (Cloudflare's does) would hand one tenant's page to another — so no CDN
 * may store it. The response still varies by the host it was requested on.
 */
export const PUBLIC_PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "private, max-age=60",
  Vary: "Host, X-Forwarded-Host",
});

/** The platform preview: never stored by any cache, never indexed. */
export const PREVIEW_PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
});

/** An error answer must not be kept by any cache. */
export const NO_STORE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store",
});

export type HeadMeta = {
  title?: string;
  name?: string;
  property?: string;
  content?: string;
};
export type HeadLink = { rel: string; href: string };
export type HeadScript = { type: string; children: string };
export type TenantHead = { meta: HeadMeta[]; links: HeadLink[]; scripts: HeadScript[] };

/** https://{host}/a/{slug} — null when the host is not a plain hostname. */
export function tenantCanonicalUrl(host: string | null | undefined, slug: string): string | null {
  const h = (host ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!h || !h.includes(".") || !/^[a-z0-9.-]+$/.test(h) || h.startsWith(".")) return null;
  if (!/^[a-z0-9-]{1,200}$/.test(slug)) return null;
  return `https://${h}/a/${slug}`;
}

/** Does this page ask not to be indexed? The owner's switch, or the shared thin rule. */
export function pageIsNoindex(data: TemplateData): boolean {
  return isNoindexPage({
    noindex: data.page.noindex,
    kind: data.page.kind,
    listingCount: data.listings.length,
    bodyChars: thinPageBodyChars(data.page.bodyMarkdown),
  });
}

/** "per night" → "night"; "" → null. */
function unitWord(unitText: string): string | null {
  const w = unitText.replace(/^per\s+/i, "").trim();
  return w || null;
}

/** The first listing photo the page shows. */
function firstImage(data: TemplateData): { url: string; alt: string } | null {
  for (const l of data.listings)
    if (l.image) return { url: l.image.url, alt: l.image.alt || l.title };
  return null;
}

/** The page's structured data, as plain objects (serialise with safeJsonLd). */
export function tenantPageJsonLd(
  data: TemplateData,
  canonical: string | null,
): Array<Record<string, unknown>> {
  const { page, listings, branding, marketplace } = data;
  const brand = branding.name.trim();
  const out: Array<Record<string, unknown>> = [];

  if (canonical && marketplace.homeUrl) {
    const crumbs = breadcrumbJsonLd([
      { name: brand || "Home", url: marketplace.homeUrl },
      { name: page.h1, url: canonical },
    ]);
    if (crumbs) out.push(crumbs);
  }

  const list = itemListJsonLd(
    page.h1,
    listings.map((l) => ({
      name: l.title,
      url: l.url,
      image: l.image?.url ?? null,
      price: l.price
        ? { amount: l.price.amount, currency: l.price.currency, unit: unitWord(l.price.unitText) }
        : null,
    })),
  );
  if (list) out.push(list);

  if (page.kind === "resource_article") {
    out.push(
      articleJsonLd({
        headline: page.h1,
        description: page.intro,
        url: canonical,
        image: firstImage(data)?.url ?? null,
        datePublished: isoOrNull(page.publishedAt),
        dateModified: isoOrNull(page.updatedAt) ?? isoOrNull(page.publishedAt),
        publisher: brand ? { name: brand, url: marketplace.homeUrl, logo: branding.logoUrl } : null,
      }),
    );
  }
  return out;
}

/** Everything the public route's head() returns for a served page. */
export function buildTenantPageHead(data: TemplateData, opts: { host: string | null }): TenantHead {
  const { page, branding } = data;
  const canonical = tenantCanonicalUrl(opts.host, page.slug);
  const title = pageTitleTag(page);
  const description = pageDescription(page);
  const brand = branding.name.trim();
  const image = firstImage(data);
  const article = page.kind === "resource_article";

  const meta: HeadMeta[] = [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: article ? "article" : "website" },
  ];
  if (canonical) meta.push({ property: "og:url", content: canonical });
  if (brand) meta.push({ property: "og:site_name", content: brand });
  if (image) {
    meta.push({ property: "og:image", content: image.url });
    meta.push({ property: "og:image:alt", content: image.alt });
  }
  meta.push({ name: "twitter:card", content: image ? "summary_large_image" : "summary" });
  meta.push({ name: "twitter:title", content: title });
  meta.push({ name: "twitter:description", content: description });
  if (image) meta.push({ name: "twitter:image", content: image.url });
  if (article) {
    const published = isoOrNull(page.publishedAt);
    const modified = isoOrNull(page.updatedAt);
    if (published) meta.push({ property: "article:published_time", content: published });
    if (modified) meta.push({ property: "article:modified_time", content: modified });
  }
  if (pageIsNoindex(data)) meta.push({ name: "robots", content: "noindex, follow" });

  return {
    meta,
    links: canonical ? [{ rel: "canonical", href: canonical }] : [],
    scripts: tenantPageJsonLd(data, canonical).map((obj) => ({
      type: "application/ld+json",
      children: safeJsonLd(obj),
    })),
  };
}

/** The platform preview's head: its own title, never indexed, no canonical. */
export function buildPreviewHead(data: TemplateData): TenantHead {
  return {
    meta: [
      { title: `${pageTitleTag(data.page)} — preview` },
      { name: "robots", content: "noindex, nofollow" },
    ],
    links: [],
    scripts: [],
  };
}

/** A 404 or error answer on a customer's page: a plain title, never indexed. */
export function tenantStatusHead(title: string): TenantHead {
  return { meta: [{ title }, { name: "robots", content: "noindex" }], links: [], scripts: [] };
}
