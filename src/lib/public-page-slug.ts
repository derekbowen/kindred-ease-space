/**
 * What a public page slug may look like. Slugs are produced by slugifyPage
 * (lowercase letters, digits, dashes; 80 characters) and arrive from the URL.
 * Anything else is refused BEFORE the slug touches a query: getPublicTenantPage
 * interpolates it into a PostgREST `.or(...)` expression, where a value such as
 * `x,slug.neq.zzz` is not a slug but two extra filter terms that widen the
 * match to other rows. Refusing early also keeps junk out of the 404 log.
 *
 * Pure and dependency-free so the sitemap applies the same rule: a URL the
 * page route refuses must never be advertised.
 */
export const PUBLIC_PAGE_SLUG_RE = /^[a-z0-9-]{1,200}$/;

export function isPublicPageSlug(slug: string): boolean {
  return PUBLIC_PAGE_SLUG_RE.test(slug);
}
