/**
 * RESOURCE ARTICLE — an editorial guide. The article comes first: heading,
 * lede, byline and dates, then the body with its own headings. Listings are
 * optional: a small strip appears only when the page names a filter and it
 * matched something. A clear call to the marketplace and links to related
 * pages close it.
 */
import { TenantMarkdown } from "./TenantMarkdown";
import { brandLabel, formatPageDate, splitRelated } from "./format";
import { Breadcrumbs, ListingStrip, MarketplaceCta, RelatedPages, TemplateShell } from "./parts";
import type { TemplatePageProps } from "./types";

export function ResourceArticle({
  page,
  listings,
  related,
  branding,
  marketplace,
  basePath = "/a",
}: TemplatePageProps) {
  const brand = brandLabel(branding);
  const name = branding.name.trim();
  const published = formatPageDate(page.publishedAt);
  const updated = formatPageDate(page.updatedAt);
  const [guides, more] = splitRelated(related, (r) => r.kind === "resource_article");

  return (
    <TemplateShell kind="resource_article" branding={branding} marketplace={marketplace}>
      <article className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
        <header data-section="hero">
          <Breadcrumbs branding={branding} marketplace={marketplace} current={page.h1} />
          <p className="mt-8 text-sm font-semibold uppercase tracking-wider text-[color:var(--tp-accent)]">
            Guide
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 sm:text-[2.75rem] sm:leading-tight">
            {page.h1}
          </h1>
          {page.intro ? (
            <p className="mt-5 text-xl leading-relaxed text-slate-600">{page.intro}</p>
          ) : null}
          {name || published || updated ? (
            <p className="mt-6 flex flex-wrap gap-x-3 gap-y-1 text-sm text-slate-500">
              {name ? <span>By {name}</span> : null}
              {published && page.publishedAt ? (
                <span>
                  Published <time dateTime={page.publishedAt}>{published}</time>
                </span>
              ) : null}
              {updated && page.updatedAt && updated !== published ? (
                <span>
                  Updated <time dateTime={page.updatedAt}>{updated}</time>
                </span>
              ) : null}
            </p>
          ) : null}
        </header>
        {page.bodyMarkdown?.trim() ? (
          <div data-section="body" className="mt-8 border-t border-slate-200 pt-6">
            <TenantMarkdown markdown={page.bodyMarkdown} />
          </div>
        ) : null}
      </article>

      <ListingStrip
        heading={`Listings on ${brand}`}
        listings={listings}
        branding={branding}
        marketplace={marketplace}
      />

      <MarketplaceCta
        heading={`Find it on ${brand}`}
        text="Put this guide to work: browse the listings available now."
        branding={branding}
        marketplace={marketplace}
      />

      <RelatedPages
        basePath={basePath}
        groups={[
          { heading: "More guides", items: guides },
          { heading: `More from ${brand}`, items: more },
        ]}
      />
    </TemplateShell>
  );
}
