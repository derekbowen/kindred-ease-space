/**
 * MARKETPLACE ADAPTER — the only place marketplace URLs are constructed.
 *
 * Before this existed, the listing route `/l/{slug}/{id}` was hard-coded inline
 * in the Sharetribe sync mapper and baked into both `marketplace_url` and the
 * listing JSON-LD at sync time. That meant:
 *
 *   - founders.click supported ONE Sharetribe frontend convention, not
 *     Sharetribe marketplaces generally, and
 *   - changing the convention required re-syncing every listing.
 *
 * Rules:
 *   1. Route shapes are CONFIGURATION, not code. Web Template defaults are a
 *      starting profile, never an assumption.
 *   2. URLs are derived at RENDER time from stored ids, never persisted as
 *      authority. An adapter fix takes effect immediately.
 *   3. The Page Specification references semantic targets
 *      (`target: "marketplace_search"`, `listing_id`) — never URLs. Neither the
 *      compiler nor an LLM may construct a marketplace route.
 *   4. Unsupported search filters are OMITTED, never fabricated.
 */

export type SupportedFilter = "location" | "category" | "keywords" | "bounds" | "dates";

export type MarketplaceRouteConfig = {
  /** Absolute marketplace base, e.g. https://www.example.com */
  baseUrl: string;
  /** Tokens: {slug} {id} */
  listingRouteTemplate: string;
  /** Path portion of search, e.g. "/s" */
  searchPath: string;
  /** Maps a semantic filter to this marketplace's query-parameter name. A
   *  filter absent from this map is NOT supported and is omitted. */
  searchParams: Partial<Record<SupportedFilter, string>>;
  /** Tokens: {id} — omit when the marketplace has no public provider pages. */
  providerRouteTemplate?: string;
  supportedFilters: SupportedFilter[];
};

/** Sharetribe Web Template defaults. A *starting profile*, not an assumption —
 *  every field is overridable per workspace. */
export const SHARETRIBE_DEFAULT_ROUTES: Omit<MarketplaceRouteConfig, "baseUrl"> = {
  listingRouteTemplate: "/l/{slug}/{id}",
  searchPath: "/s",
  searchParams: {
    location: "address",
    keywords: "keywords",
    bounds: "bounds",
    category: "pub_category",
  },
  providerRouteTemplate: "/u/{id}",
  supportedFilters: ["location", "keywords", "bounds", "category"],
};

export function resolveRouteConfig(
  baseUrl: string,
  stored: unknown,
): MarketplaceRouteConfig {
  const cfg = (stored && typeof stored === "object" ? stored : {}) as Partial<MarketplaceRouteConfig>;
  const base = (baseUrl || "").replace(/\/+$/, "");
  // Presence of the key means "explicitly configured", including an explicit
  // "this marketplace has no public provider pages". Falling back on undefined
  // would silently restore the default route and render broken provider links.
  const providerConfigured = Object.prototype.hasOwnProperty.call(cfg, "providerRouteTemplate");
  return {
    baseUrl: base,
    listingRouteTemplate: cfg.listingRouteTemplate || SHARETRIBE_DEFAULT_ROUTES.listingRouteTemplate,
    searchPath: cfg.searchPath || SHARETRIBE_DEFAULT_ROUTES.searchPath,
    searchParams: { ...SHARETRIBE_DEFAULT_ROUTES.searchParams, ...(cfg.searchParams ?? {}) },
    providerRouteTemplate: providerConfigured
      ? (cfg.providerRouteTemplate ?? undefined)
      : SHARETRIBE_DEFAULT_ROUTES.providerRouteTemplate,
    supportedFilters: cfg.supportedFilters ?? SHARETRIBE_DEFAULT_ROUTES.supportedFilters,
  };
}

function fill(template: string, tokens: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(tokens[k] ?? ""));
}

export type ListingRef = { sharetribe_listing_id: string; slug?: string | null };

export function buildListingUrl(cfg: MarketplaceRouteConfig, listing: ListingRef): string | null {
  if (!cfg.baseUrl || !listing?.sharetribe_listing_id) return null;
  const path = fill(cfg.listingRouteTemplate, {
    slug: listing.slug || "listing",
    id: listing.sharetribe_listing_id,
  });
  return `${cfg.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

export function buildProviderUrl(cfg: MarketplaceRouteConfig, providerId: string): string | null {
  if (!cfg.baseUrl || !cfg.providerRouteTemplate || !providerId) return null;
  const path = fill(cfg.providerRouteTemplate, { id: providerId });
  return `${cfg.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

export type SearchFilters = {
  location?: string | null;
  category?: string | null;
  keywords?: string | null;
};

/**
 * Build the customer's real search URL. Filters the marketplace does not
 * declare support for are dropped — fabricating a parameter produces a link
 * that looks right and silently returns the wrong results, which is worse than
 * a broader search.
 */
export function buildSearchUrl(cfg: MarketplaceRouteConfig, filters: SearchFilters): string | null {
  if (!cfg.baseUrl) return null;
  const qs = new URLSearchParams();
  const add = (f: SupportedFilter, value: string | null | undefined) => {
    if (!value) return;
    if (!cfg.supportedFilters.includes(f)) return;
    const param = cfg.searchParams[f];
    if (!param) return;
    qs.set(param, value);
  };
  add("location", filters.location);
  add("category", filters.category);
  add("keywords", filters.keywords);
  const path = cfg.searchPath.startsWith("/") ? cfg.searchPath : `/${cfg.searchPath}`;
  const query = qs.toString();
  return `${cfg.baseUrl}${path}${query ? `?${query}` : ""}`;
}

export function getCapabilities(cfg: MarketplaceRouteConfig) {
  return {
    listingUrls: Boolean(cfg.listingRouteTemplate),
    searchUrls: Boolean(cfg.searchPath),
    providerUrls: Boolean(cfg.providerRouteTemplate),
    filters: cfg.supportedFilters,
  };
}

/** Inventory freshness policy — consumes the sync fields that already exist.
 *  A Sharetribe outage must degrade a page, never 500 it. */
export type InventoryHealth = "OK" | "WARNING" | "DEGRADED" | "UNKNOWN";

export function inventoryHealth(
  lastSyncAt: string | null | undefined,
  lastSyncStatus: string | null | undefined,
  now: number = Date.now(),
): { health: InventoryHealth; ageHours: number | null; showStats: boolean } {
  if (!lastSyncAt) return { health: "UNKNOWN", ageHours: null, showStats: false };
  const ageHours = (now - new Date(lastSyncAt).getTime()) / 3_600_000;
  if (lastSyncStatus === "error" || ageHours > 72) {
    // Counts and price ranges may now be lies — render cards, hide statistics.
    return { health: "DEGRADED", ageHours, showStats: false };
  }
  if (ageHours > 24) return { health: "WARNING", ageHours, showStats: true };
  return { health: "OK", ageHours, showStats: true };
}
