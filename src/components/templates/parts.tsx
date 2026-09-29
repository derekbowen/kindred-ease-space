/**
 * The chrome and sections the three templates share. Pure components: every
 * fact arrives in TemplatePageProps, nothing is fetched, nothing needs
 * JavaScript in the browser (customers' pages are served as plain HTML).
 */
import type { ReactNode } from "react";
import { ListingCard } from "./ListingCard";
import { brandLabel } from "./format";
import { brandThemeStyle } from "./theme";
import type {
  TemplateBranding,
  TemplateKind,
  TemplateListing,
  TemplateMarketplace,
  TemplateRelatedPage,
} from "./types";

/**
 * Every link to the customer's marketplace opens beside the page (so an
 * editor's in-app preview is never navigated away) and is followed — never
 * nofollow: it is the customer's own marketplace.
 */
const OUT = { target: "_blank", rel: "noopener" } as const;

export const BUTTON =
  "inline-flex items-center justify-center gap-2 rounded-full bg-[color:var(--tp-brand)] px-5 py-2.5 text-sm font-semibold text-[color:var(--tp-on-brand)] shadow-sm transition hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--tp-brand)] focus-visible:ring-offset-2";

export const LINK =
  "font-semibold text-[color:var(--tp-accent)] underline decoration-1 underline-offset-4 hover:decoration-2";

function BrandMark({
  branding,
  marketplace,
}: {
  branding: TemplateBranding;
  marketplace: TemplateMarketplace;
}) {
  const name = branding.name.trim();
  const mark = branding.logoUrl ? (
    <img
      src={branding.logoUrl}
      alt={name || "Home"}
      height={32}
      width={128}
      className="h-8 w-auto max-w-[10rem] object-contain object-left"
    />
  ) : (
    <span className="text-lg font-bold tracking-tight text-slate-900">{name || "Home"}</span>
  );
  return marketplace.homeUrl ? (
    <a href={marketplace.homeUrl} {...OUT} className="inline-flex min-w-0 items-center">
      {mark}
    </a>
  ) : (
    <span className="inline-flex min-w-0 items-center">{mark}</span>
  );
}

/** Header, one <main>, footer — around every template. */
export function TemplateShell({
  kind,
  branding,
  marketplace,
  children,
}: {
  kind: TemplateKind;
  branding: TemplateBranding;
  marketplace: TemplateMarketplace;
  children: ReactNode;
}) {
  const name = branding.name.trim();
  return (
    <div
      data-template={kind}
      style={brandThemeStyle(branding.color)}
      className="flex min-h-screen flex-col bg-white text-slate-900 antialiased"
    >
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <BrandMark branding={branding} marketplace={marketplace} />
          {marketplace.browseUrl ? (
            <a href={marketplace.browseUrl} {...OUT} className={`${BUTTON} shrink-0 px-4 py-2`}>
              Browse listings
            </a>
          ) : null}
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          {name ? <p className="font-semibold text-slate-900">{name}</p> : <span />}
          {marketplace.homeUrl ? (
            <a href={marketplace.homeUrl} {...OUT} className={LINK}>
              {name ? `Visit ${name}` : "Visit the marketplace"}
            </a>
          ) : null}
        </div>
      </footer>
    </div>
  );
}

/** Brand home → this page. The structured data's BreadcrumbList names the same two steps. */
export function Breadcrumbs({
  branding,
  marketplace,
  current,
}: {
  branding: TemplateBranding;
  marketplace: TemplateMarketplace;
  current: string;
}) {
  const name = branding.name.trim() || "Home";
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-slate-600">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <li>
          {marketplace.homeUrl ? (
            <a href={marketplace.homeUrl} {...OUT} className="hover:text-slate-900 hover:underline">
              {name}
            </a>
          ) : (
            <span>{name}</span>
          )}
        </li>
        <li aria-hidden="true" className="text-slate-400">
          /
        </li>
        <li aria-current="page" className="min-w-0 truncate text-slate-900">
          {current}
        </li>
      </ol>
    </nav>
  );
}

export function ListingGrid({ listings }: { listings: TemplateListing[] }) {
  return (
    <ul role="list" className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6">
      {listings.map((l) => (
        <ListingCard key={l.id} listing={l} />
      ))}
    </ul>
  );
}

/** "Browse all listings on {brand}" — the unfiltered marketplace, so the words never promise a filter. */
export function BrowseAllLink({
  branding,
  marketplace,
}: {
  branding: TemplateBranding;
  marketplace: TemplateMarketplace;
}) {
  if (!marketplace.browseUrl) return null;
  return (
    <p className="mt-8">
      <a href={marketplace.browseUrl} {...OUT} className={LINK} data-cta="browse-all">
        Browse all listings on {brandLabel(branding)} <span aria-hidden="true">→</span>
      </a>
    </p>
  );
}

/** The listing grid section, or a plain "none right now" with the way to the marketplace. */
export function ListingSection({
  heading,
  subheading,
  listings,
  emptyText,
  branding,
  marketplace,
}: {
  heading: string;
  subheading?: string | null;
  listings: TemplateListing[];
  emptyText: string;
  branding: TemplateBranding;
  marketplace: TemplateMarketplace;
}) {
  return (
    <section
      data-section="listing_grid"
      aria-labelledby="tp-listings"
      className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-12"
    >
      <div className="mb-6">
        <h2 id="tp-listings" className="text-2xl font-bold tracking-tight text-slate-900">
          {heading}
        </h2>
        {subheading ? <p className="mt-1 text-slate-600">{subheading}</p> : null}
      </div>
      {listings.length > 0 ? (
        <ListingGrid listings={listings} />
      ) : (
        <div className="rounded-2xl border border-dashed border-slate-300 px-6 py-10 text-center">
          <p className="font-medium text-slate-900">{emptyText}</p>
        </div>
      )}
      <BrowseAllLink branding={branding} marketplace={marketplace} />
    </section>
  );
}

/** The Resource Article's small strip of listings — drawn only when there are some. */
export function ListingStrip({
  heading,
  listings,
  branding,
  marketplace,
}: {
  heading: string;
  listings: TemplateListing[];
  branding: TemplateBranding;
  marketplace: TemplateMarketplace;
}) {
  if (listings.length === 0) return null;
  return (
    <section
      data-section="related_listings"
      aria-labelledby="tp-related-listings"
      className="border-t border-slate-200 bg-slate-50"
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
        <h2 id="tp-related-listings" className="text-xl font-bold tracking-tight text-slate-900">
          {heading}
        </h2>
        <ul role="list" className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {listings.map((l) => (
            <ListingCard key={l.id} listing={l} compact />
          ))}
        </ul>
        <BrowseAllLink branding={branding} marketplace={marketplace} />
      </div>
    </section>
  );
}

/** The closing call to action: go to the marketplace. */
export function MarketplaceCta({
  heading,
  text,
  branding,
  marketplace,
}: {
  heading: string;
  text: string;
  branding: TemplateBranding;
  marketplace: TemplateMarketplace;
}) {
  const href = marketplace.browseUrl ?? marketplace.homeUrl;
  if (!href) return null;
  return (
    <section data-section="cta" className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <div className="flex flex-col items-start gap-4 rounded-3xl bg-[color:var(--tp-brand-soft)] px-6 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-10">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">{heading}</h2>
          <p className="mt-1 text-slate-700">{text}</p>
        </div>
        <a href={href} {...OUT} className={BUTTON} data-cta="marketplace">
          Browse {brandLabel(branding)}
        </a>
      </div>
    </section>
  );
}

const KIND_LABEL: Record<TemplateKind, string> = {
  city_hub: "City",
  category_page: "Category",
  resource_article: "Guide",
};

/** Links to the workspace's other published pages — each group only when it has any. */
export function RelatedPages({
  groups,
  basePath,
}: {
  groups: Array<{ heading: string; items: TemplateRelatedPage[] }>;
  basePath: string | null;
}) {
  const shown = groups.filter((g) => g.items.length > 0);
  if (shown.length === 0) return null;
  return (
    <section
      data-section="related_pages"
      aria-label="Related pages"
      className="border-t border-slate-200"
    >
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-10 sm:px-6 md:grid-cols-2">
        {shown.map((g) => (
          <div key={g.heading}>
            <h2 className="text-lg font-bold tracking-tight text-slate-900">{g.heading}</h2>
            <ul role="list" className="mt-4 space-y-3">
              {g.items.map((r) => (
                <li key={r.slug} className="flex items-baseline gap-3">
                  <span className="shrink-0 rounded-full border border-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600">
                    {KIND_LABEL[r.kind]}
                  </span>
                  {basePath === null ? (
                    <span className="text-slate-900">{r.title}</span>
                  ) : (
                    <a href={`${basePath}/${r.slug}`} className="text-slate-900 hover:underline">
                      {r.title}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/** A small location-pin glyph (decorative). */
export function PinIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M10 18s6-5.2 6-10A6 6 0 1 0 4 8c0 4.8 6 10 6 10Zm0-7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"
        clipRule="evenodd"
      />
    </svg>
  );
}
