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
 * Both callers import this predicate rather than restating the numbers, so
 * the two cannot drift apart again.
 */
export const THIN_PAGE_MIN_BODY_CHARS = 300;

/** A body's length as the rule counts it: surrounding whitespace excluded. */
export function thinPageBodyChars(bodyMarkdown: string | null | undefined): number {
  return (bodyMarkdown ?? "").trim().length;
}

/**
 * The rule on an already-measured body. The sitemap measures each body as its
 * chunk arrives and keeps only the length (thinPageBodyChars), so a catalogue
 * of thousands of pages never holds every body in memory at once.
 */
export function isThinPageMeasured(page: { listingCount: number; bodyChars: number }): boolean {
  return page.listingCount === 0 && page.bodyChars < THIN_PAGE_MIN_BODY_CHARS;
}

export function isThinPage(page: {
  listingCount: number;
  bodyMarkdown: string | null | undefined;
}): boolean {
  return isThinPageMeasured({
    listingCount: page.listingCount,
    bodyChars: thinPageBodyChars(page.bodyMarkdown),
  });
}

/** The shape of tenant_pages.listing_filter that getPublicTenantPage honours. */
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
