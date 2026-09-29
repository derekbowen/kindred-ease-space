/**
 * THE THIN-PAGE RULE, in one place.
 *
 * Google's scaled-content guidance treats a grid of near-empty location pages
 * as abuse, and one deindexing takes the whole domain with it. A thin page
 * renders `noindex, follow`, and the tenant sitemap must never advertise a
 * URL the page itself asks Google not to index — a sitemap full of noindex
 * URLs is a mixed signal that Search Console reports as an error and that
 * erodes trust in the rest of the file.
 *
 * THE RULE BY TEMPLATE — the page head (isNoindexPage) and the sitemap
 * (isThinForTemplate) apply exactly this, so the two sets are identical:
 *   - City Hub, Category Page (templates that exist to show listings): thin
 *     when no published listing matches, however long the copy — a place or
 *     category page with no inventory is the doorway pattern above;
 *   - Resource Article (editorial): judged on its text alone; the small strip
 *     of listings it may carry never rescues a short body;
 *   - a legacy page with no template kind: the original rule — no listings
 *     AND under 300 characters of body.
 * The page's own switch (tenant_pages.noindex) joins the rule in
 * isNoindexPage.
 *
 * Every caller imports these predicates rather than restating the numbers,
 * so they cannot drift apart again.
 */
import { listingMatches, resolveFilter, type TargetKeys } from "@/lib/coverage/target";

export const THIN_PAGE_MIN_BODY_CHARS = 300;

/** A body's length as the rule counts it: surrounding whitespace excluded. */
export function thinPageBodyChars(bodyMarkdown: string | null | undefined): number {
  return (bodyMarkdown ?? "").trim().length;
}

/**
 * The template slug (page_templates.slug) the rule is applied for. Anything
 * other than the known kinds — a legacy page with no kind — keeps the
 * original listings-or-text rule.
 */
export type ThinPageKind = string | null | undefined;

/** Pages of these kinds are judged on their text alone. */
export const TEXT_ONLY_KINDS: ReadonlySet<string> = new Set(["resource_article"]);

/** Pages of these kinds are thin whenever no published listing matches. */
export const LISTING_KINDS: ReadonlySet<string> = new Set(["city_hub", "category_page"]);

/**
 * The rule on an already-measured body. The sitemap measures each body as its
 * read arrives and keeps only the length (thinPageBodyChars), so a catalogue
 * of thousands of pages never holds every body in memory at once.
 */
export function isThinPageMeasured(page: {
  listingCount: number;
  bodyChars: number;
  kind?: ThinPageKind;
}): boolean {
  const shortBody = page.bodyChars < THIN_PAGE_MIN_BODY_CHARS;
  if (page.kind && LISTING_KINDS.has(page.kind)) return !(page.listingCount > 0);
  if (page.kind && TEXT_ONLY_KINDS.has(page.kind)) return shortBody;
  return page.listingCount === 0 && shortBody;
}

export function isThinPage(page: {
  listingCount: number;
  bodyMarkdown: string | null | undefined;
  kind?: ThinPageKind;
}): boolean {
  return isThinPageMeasured({
    listingCount: page.listingCount,
    bodyChars: thinPageBodyChars(page.bodyMarkdown),
    kind: page.kind,
  });
}

/**
 * Does the page ask search engines not to index it? Its own switch
 * (tenant_pages.noindex), or the thin rule. The page renders
 * `robots: noindex, follow` exactly when this is true, and the sitemap leaves
 * exactly these pages out.
 */
export function isNoindexPage(page: {
  noindex?: boolean | null;
  listingCount: number;
  bodyChars: number;
  kind?: ThinPageKind;
}): boolean {
  return page.noindex === true || isThinPageMeasured(page);
}

/**
 * The same rule in the sitemap's terms: `requiresListings` is
 * TEMPLATE_CONTRACTS[kind].requiresListings (City Hub, Category Page), and a
 * page that needs no listings (Resource Article, legacy content pages, which
 * render none) is judged on its body alone.
 */
export function isThinForTemplate(page: {
  requiresListings: boolean;
  listingCount: number;
  bodyChars: number;
}): boolean {
  if (page.requiresListings) return !(page.listingCount > 0);
  return page.bodyChars < THIN_PAGE_MIN_BODY_CHARS;
}

/** One published listing's stored comparison keys (tenant_listings.*_key). */
export type ListingKeyRow = {
  country_key: string | null;
  region_key: string | null;
  city_key: string | null;
  category_key: string | null;
};

const SEP = "\u0000";

/**
 * How many published listings a page's STORED filter (tenant_pages.listing_filter,
 * v1 or v2) matches — the answer getPublicTenantPage's listing query
 * (fetchPageListings → applyFilter) gives, computed in memory: the filter is
 * read with resolveFilter (null = invalid → the page renders no listings → 0)
 * and each constrained field must equal the listing's stored key exactly
 * (a null key in the filter means "has no value"). Listings are grouped by
 * their key tuple once, so each page costs one pass over the distinct
 * places/categories, not over every listing.
 */
export function buildKeyedListingCounter(
  listings: readonly ListingKeyRow[],
): (rawFilter: unknown) => number {
  const groups = new Map<string, { keys: TargetKeys; count: number }>();
  for (const l of listings) {
    const keys: TargetKeys = {
      countryKey: l.country_key ?? null,
      regionKey: l.region_key ?? null,
      cityKey: l.city_key ?? null,
      categoryKey: l.category_key ?? null,
    };
    const id = [keys.countryKey, keys.regionKey, keys.cityKey, keys.categoryKey]
      .map((k) => (k === null ? "\u0001" : k))
      .join(SEP);
    const g = groups.get(id);
    if (g) g.count++;
    else groups.set(id, { keys, count: 1 });
  }
  const cache = new Map<string, number>();
  return (rawFilter) => {
    const filter = resolveFilter(rawFilter ?? {});
    if (!filter) return 0;
    const id = JSON.stringify(filter.constraints);
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    let n = 0;
    for (const g of groups.values()) if (listingMatches(g.keys, filter)) n += g.count;
    cache.set(id, n);
    return n;
  };
}
