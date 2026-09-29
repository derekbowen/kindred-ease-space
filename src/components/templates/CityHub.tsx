/**
 * CITY HUB — a landing page for one city, built around that city's live
 * listings: heading and lede, the listing grid, the page's own guide text,
 * links to related pages, and the way to the marketplace.
 */
import { TenantMarkdown } from "./TenantMarkdown";
import { brandLabel, capitalize, listingCountText, placeText, splitRelated } from "./format";
import {
  Breadcrumbs,
  ListingSection,
  MarketplaceCta,
  PinIcon,
  RelatedPages,
  TemplateShell,
} from "./parts";
import type { TemplatePageProps } from "./types";

export function CityHub({
  page,
  listings,
  related,
  branding,
  marketplace,
  basePath = "/a",
}: TemplatePageProps) {
  const place = placeText(page.place);
  const city = page.place.city?.trim() || null;
  const brand = brandLabel(branding);
  // The exact matching total, only when the server counted it — never the
  // length of the (capped) grid dressed up as a total.
  const total = page.matchingListings ?? 0;
  const noun = page.listingNoun;
  const [nearby, more] = splitRelated(related, (r) => r.relation !== "other");
  const where = city ? ` in ${city}` : "";

  return (
    <TemplateShell kind="city_hub" branding={branding} marketplace={marketplace}>
      <section
        data-section="hero"
        className="border-b border-slate-200 bg-[color:var(--tp-brand-soft)]"
      >
        <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
          <Breadcrumbs branding={branding} marketplace={marketplace} current={page.h1} />
          {place ? (
            <p className="mt-7 inline-flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-[color:var(--tp-accent)]">
              <PinIcon />
              {place}
            </p>
          ) : null}
          <h1 className="mt-3 max-w-4xl text-3xl font-bold tracking-tight text-slate-900 sm:text-5xl sm:leading-[1.1]">
            {page.h1}
          </h1>
          {page.intro ? (
            <p
              data-section="intro"
              className="mt-5 max-w-3xl text-lg leading-relaxed text-slate-700"
            >
              {page.intro}
            </p>
          ) : null}
          {total > 0 ? (
            <p className="mt-7 inline-flex items-center rounded-full border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700">
              <strong className="mr-1 font-semibold text-slate-900">
                {listingCountText(total, noun)}
              </strong>
              {city ? `available in ${city}` : "available now"}
            </p>
          ) : null}
        </div>
      </section>

      <ListingSection
        heading={noun ? `${capitalize(noun)}${where}` : `Listings${where}`}
        subheading={`Live listings from ${brand}`}
        listings={listings}
        emptyText={
          city
            ? `There are no listings in ${city} right now.`
            : "There are no listings here right now."
        }
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
          { heading: city ? `More around ${city}` : "Related pages", items: nearby },
          { heading: `More from ${brand}`, items: more },
        ]}
      />

      <MarketplaceCta
        heading={city ? `Looking for more in ${city}?` : `Looking for more?`}
        text={`See every listing available on ${brand}.`}
        branding={branding}
        marketplace={marketplace}
      />
    </TemplateShell>
  );
}
