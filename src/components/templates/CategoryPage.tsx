/**
 * CATEGORY PAGE — a page for one category of listing: the category up front,
 * its live listings, the page's guide text, the cities that have their own
 * pages for it, and the way to the marketplace.
 */
import { TenantMarkdown } from "./TenantMarkdown";
import { brandLabel, humanizeLabel, listingCountText, placeText, splitRelated } from "./format";
import { Breadcrumbs, ListingSection, MarketplaceCta, RelatedPages, TemplateShell } from "./parts";
import type { TemplatePageProps } from "./types";

export function CategoryPage({
  page,
  listings,
  related,
  branding,
  marketplace,
  basePath = "/a",
}: TemplatePageProps) {
  const category = humanizeLabel(page.category);
  const place = placeText(page.place);
  const brand = brandLabel(branding);
  // The exact matching total, only when the server counted it.
  const total = page.matchingListings ?? 0;
  const [cities, more] = splitRelated(related, (r) => r.kind === "city_hub");
  const subject = category ?? "Listings";

  return (
    <TemplateShell kind="category_page" branding={branding} marketplace={marketplace}>
      <section data-section="hero" className="border-b border-slate-200 bg-white">
        <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-16">
          <Breadcrumbs branding={branding} marketplace={marketplace} current={page.h1} />
          <div className="mt-8 text-center">
            {category ? (
              <p className="inline-flex items-center rounded-full bg-[color:var(--tp-brand)] px-3 py-1 text-xs font-semibold uppercase tracking-wider text-[color:var(--tp-on-brand)]">
                {category}
              </p>
            ) : null}
            <h1 className="mt-4 text-3xl font-bold tracking-tight text-slate-900 sm:text-5xl sm:leading-[1.1]">
              {page.h1}
            </h1>
            {page.intro ? (
              <p
                data-section="intro"
                className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-slate-700"
              >
                {page.intro}
              </p>
            ) : null}
            {total > 0 || place ? (
              <ul
                role="list"
                className="mt-8 flex flex-wrap items-center justify-center gap-3 text-sm text-slate-700"
              >
                {total > 0 ? (
                  <li className="rounded-full border border-slate-300 px-4 py-1.5">
                    <strong className="font-semibold text-slate-900">
                      {listingCountText(total, page.listingNoun)}
                    </strong>{" "}
                    available
                  </li>
                ) : null}
                {place ? (
                  <li className="rounded-full border border-slate-300 px-4 py-1.5">in {place}</li>
                ) : null}
              </ul>
            ) : null}
          </div>
        </div>
      </section>

      <ListingSection
        heading={place ? `${subject} in ${place}` : subject}
        subheading={`Live listings from ${brand}`}
        listings={listings}
        emptyText={`There are no ${category ? `${category.toLowerCase()} ` : ""}listings right now.`}
        branding={branding}
        marketplace={marketplace}
      />

      {page.bodyMarkdown?.trim() ? (
        <section data-section="body" className="mx-auto w-full max-w-3xl px-4 pb-12 sm:px-6">
          <TenantMarkdown markdown={page.bodyMarkdown} />
        </section>
      ) : null}

      <RelatedPages
        basePath={basePath}
        groups={[
          { heading: category ? `${category} by city` : "By city", items: cities },
          { heading: `More from ${brand}`, items: more },
        ]}
      />

      <MarketplaceCta
        heading={`See every listing on ${brand}`}
        text="Search the whole marketplace, not just this page."
        branding={branding}
        marketplace={marketplace}
      />
    </TemplateShell>
  );
}
