/**
 * THE THIN-PAGE RULE, in one place.
 *
 * a.$slug.tsx marks a page `noindex, follow` when it has no listings and
 * under 300 characters of body: Google's scaled-content guidance treats a grid
 * of near-empty location pages as abuse, and one deindexing takes the whole
 * domain with it. The tenant sitemap applies the same rule so it never
 * advertises a URL the page itself asks Google not to index — a sitemap full
 * of noindex URLs is a mixed signal that Search Console reports as an error
 * and that erodes trust in the rest of the file.
 *
 * A Resource Article is editorial: it is judged on its text alone. The small
 * strip of listings it may carry does not make a thin article worth indexing,
 * so for `kind: "resource_article"` listings never rescue a short body.
 *
 * The page's own switch (tenant_pages.noindex) joins the rule in
 * isNoindexPage — the one answer to "does this page ask not to be indexed?"
 * that the page head and the sitemap both use.
 *
 * Both callers import these predicates rather than restating the numbers, so
 * the two cannot drift apart again.
 */
import { listingMatches, resolveFilter, type TargetKeys } from "@/lib/coverage/target";

export const THIN_PAGE_MIN_BODY_CHARS = 300;

/** A body's length as the rule counts it: surrounding whitespace excluded. */
export function thinPageBodyChars(bodyMarkdown: string | null | undefined): number {
  return (bodyMarkdown ?? "").trim().length;
}

/**
 * The template slug (page_templates.slug) the rule is applied for. Only
 * "resource_article" changes it; anything else — the inventory templates, a
 * legacy page with no kind — keeps the listings-or-text rule.
 */
export type ThinPageKind = string | null | undefined;

/** Pages of these kinds are judged on their text alone. */
export const TEXT_ONLY_KINDS: ReadonlySet<string> = new Set(["resource_article"]);

/**
 * The rule on an already-measured body. The sitemap measures each body as its
 * chunk arrives and keeps only the length (thinPageBodyChars), so a catalogue
 * of thousands of pages never holds every body in memory at once.
 */
export function isThinPageMeasured(page: {
  listingCount: number;
  bodyChars: number;
  kind?: ThinPageKind;
}): boolean {
  const shortBody = page.bodyChars < THIN_PAGE_MIN_BODY_CHARS;
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
 * `robots: noindex, follow` exactly when this is true, and the sitemap must
 * leave exactly these pages out.
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
 * The legacy (v1) shape of tenant_pages.listing_filter. getPublicTenantPage
 * now reads every filter through resolveFilter (src/lib/coverage/target.ts);
 * buildKeyedListingCounter below answers the way that query does.
 */
export type ListingFilter = { city?: unknown; state?: unknown; category?: unknown };

export type ListingLocation = {
  city: string | null;
  state: string | null;
  category: string | null;
};

const WILDCARD = "*";
const SEP = "\u0000";

/**
 * How many published listings a page's filter would match, computed the way
 * getPublicTenantPage's query matches them: city and state case-insensitively
 * (`ilike` with no wildcard is a case-insensitive equality), category exactly,
 * and a missing or empty filter field matching everything. Built once per
 * workspace from one listings read, then answered per page from a map, so the
 * sitemap does not issue one count query per page.
 */
export function buildListingCounter(
  listings: readonly ListingLocation[],
): (filter: ListingFilter | null | undefined) => number {
  const counts = new Map<string, number>();
  for (const l of listings) {
    // A listing with no city cannot satisfy a city filter, so it contributes
    // only to the "any city" keys; likewise for state and category.
    const cities = l.city == null ? [WILDCARD] : [WILDCARD, l.city.trim().toLowerCase()];
    const states = l.state == null ? [WILDCARD] : [WILDCARD, l.state.trim().toLowerCase()];
    const categories = l.category == null ? [WILDCARD] : [WILDCARD, l.category];
    for (const c of cities) {
      for (const s of states) {
        for (const g of categories) {
          const key = c + SEP + s + SEP + g;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
  }
  return (filter) => {
    const f = filter ?? {};
    const c = f.city ? String(f.city).trim().toLowerCase() : WILDCARD;
    const s = f.state ? String(f.state).trim().toLowerCase() : WILDCARD;
    const g = f.category ? String(f.category) : WILDCARD;
    return counts.get(c + SEP + s + SEP + g) ?? 0;
  };
}

/** One published listing's stored comparison keys (tenant_listings.*_key). */
export type ListingKeyRow = {
  country_key: string | null;
  region_key: string | null;
  city_key: string | null;
  category_key: string | null;
};

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
