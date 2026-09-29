/**
 * THE PROPS EVERY PAGE TEMPLATE RENDERS FROM — pure data, no fetching.
 *
 * The public renderer (src/routes/a.$slug.tsx), the platform preview
 * (src/routes/s.$ws.$slug.tsx) and the in-app editor preview all hand a
 * template the same shape. The server builds it (src/lib/tenant-page-data.server.ts:
 * the page's own listings through the one inventory query, prices already
 * formatted with formatMoney/perUnit, listing links already derived through
 * the marketplace adapter), so a template only lays facts out and can never
 * disagree with the structured data built from the same object.
 */
import type { PageKind } from "@/lib/coverage/target";

export type TemplateKind = PageKind;

export type TemplateImage = {
  /** http(s) only. */
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
};

export type TemplatePrice = {
  /** formatMoney(amountMinor, currency): "$125", "$125.50", "¥5,000". */
  text: string;
  /** perUnit(unit): "per night" — "" when the marketplace reported no known unit. */
  unitText: string;
  /** The same amount in major units as an exact decimal string ("125.00", "5000") — structured data. */
  amount: string;
  /** ISO 4217, upper case. */
  currency: string;
};

export type TemplateListing = {
  id: string;
  title: string;
  /** The listing on the customer's own marketplace (http/https), or null when none can be built. */
  url: string | null;
  image: TemplateImage | null;
  /** "Portland, OR" — null when the listing records no place. */
  location: string | null;
  /** null = no price is shown (unknown amount or currency). */
  price: TemplatePrice | null;
};

export type TemplatePlace = {
  city: string | null;
  region: string | null;
  country: string | null;
};

export type TemplatePage = {
  /** null for an unsaved draft in the editor preview. */
  id: string | null;
  kind: TemplateKind;
  slug: string;
  /** The page's title (link text elsewhere, <title> fallback). */
  title: string;
  /** The writer's <title>, when it produced one. */
  seoTitle: string | null;
  /** The visible heading: h1, else title. */
  h1: string;
  metaDescription: string | null;
  /** The lede under the heading (variables.intro, else the meta description). */
  intro: string | null;
  bodyMarkdown: string | null;
  /** The owner asked search engines not to index this page. */
  noindex: boolean;
  publishedAt: string | null;
  updatedAt: string | null;
  /** The place the page's filter names (display labels, as the listings record them). */
  place: TemplatePlace;
  /** The category the page's filter names (display label). */
  category: string | null;
  /** A plural noun for this page's listings ("pool rentals"), when the page carries one. */
  listingNoun: string | null;
  /** Exact number of published listings matching the page's filter; null when not known. */
  matchingListings: number | null;
  /** A pre-unification content_pages row, served read-only. */
  legacy: boolean;
};

export type TemplateRelation = "same_city" | "same_category" | "same_region" | "other";

export type TemplateRelatedPage = {
  slug: string;
  /** Link text: the page's heading, else its title. */
  title: string;
  kind: TemplateKind;
  /** "Portland, OR" when the page names a place. */
  place: string | null;
  category: string | null;
  /** How it relates to the page being shown (strongest first when ranked). */
  relation: TemplateRelation;
};

export type TemplateBranding = {
  /** workspaces.brand_name, else the workspace name; "" when neither is set. */
  name: string;
  /** A validated #rrggbb, or null → the neutral palette. */
  color: string | null;
  /** http(s) only. */
  logoUrl: string | null;
};

export type TemplateMarketplace = {
  /** The marketplace's home (tenant_integrations.marketplace_url). */
  homeUrl: string | null;
  /** Its unfiltered search page ("Browse all"), else the home. */
  browseUrl: string | null;
};

/** Everything one page renders from. */
export type TemplateData = {
  page: TemplatePage;
  listings: TemplateListing[];
  related: TemplateRelatedPage[];
  branding: TemplateBranding;
  marketplace: TemplateMarketplace;
};

export type TemplatePageProps = TemplateData & {
  /**
   * Prefix for links to sibling pages: "/a" on a customer's domain (the
   * default); the platform preview passes "/s/{workspace}" so its links stay
   * inside the preview. null renders related pages as plain text (an editor
   * preview with nowhere to link to).
   */
  basePath?: string | null;
};
