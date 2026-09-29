/**
 * THE THIN-PAGE RULE, in one place.
 *
 * a.$slug.tsx marks a page `noindex, follow` when it has no listings and
 * under 300 characters of body: Google's scaled-content guidance treats a grid
 * of near-empty location pages as abuse, and one deindexing takes the whole
 * domain with it. The tenant sitemap must never advertise a URL the page
 * itself asks Google not to index — a sitemap full of noindex URLs is a mixed
 * signal that Search Console reports as an error and that erodes trust in the
 * rest of the file.
 *
 * Both callers import from here rather than restating the numbers, so the two
 * cannot drift apart again. The sitemap applies isThinForTemplate, which is
 * never LESS strict than isThinPage: every page isThinPage calls thin is thin
 * there too, so a URL the sitemap lists is never one the renderer noindexes.
 */
export const THIN_PAGE_MIN_BODY_CHARS = 300;

/** A body's length as the rule counts it: surrounding whitespace excluded. */
export function thinPageBodyChars(bodyMarkdown: string | null | undefined): number {
  return (bodyMarkdown ?? "").trim().length;
}

/**
 * The rule on an already-measured body. The sitemap measures each body as its
 * read arrives and keeps only the length (thinPageBodyChars), so a catalogue
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

/**
 * THE RULE BY TEMPLATE (what the sitemap applies).
 *
 * - A page whose template exists to show listings — City Hub, Category Page:
 *   TEMPLATE_CONTRACTS[kind].requiresListings — is thin when no published
 *   listing matches it, however long its copy. A place or category page with
 *   no inventory is the doorway pattern the guidance above is about.
 * - A page that needs no listings — Resource Article, and legacy content
 *   pages, which render none — is thin on its body alone: listings neither
 *   rescue nor condemn it.
 *
 * `listingCount` is the number of PUBLISHED listings the page's filter
 * matches (src/lib/coverage/target.ts), counted from the one inventory
 * aggregation, never a per-page query.
 */
export function isThinForTemplate(page: {
  requiresListings: boolean;
  listingCount: number;
  bodyChars: number;
}): boolean {
  if (page.requiresListings) return !(page.listingCount > 0);
  return isThinPageMeasured({ listingCount: 0, bodyChars: page.bodyChars });
}
