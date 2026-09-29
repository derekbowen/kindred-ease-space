/**
 * THE DATA A CUSTOMER'S PAGE RENDERS FROM — built on the server, once.
 *
 * buildTenantPageData turns one tenant_pages row into the TemplateData every
 * template renders (src/components/templates/types.ts):
 *
 *  - listings ONLY through fetchPageListings with the page's own filter
 *    (resolveFilter: legacy v1 filters keep their meaning). An invalid filter
 *    renders no listings — never a guess. A failed read throws (never "no
 *    listings"), except on a Resource Article, whose optional strip is dropped;
 *  - each listing's link derived at render time through the marketplace
 *    adapter (the stored marketplace_url is only a fallback), http(s) only;
 *  - prices formatted with formatMoney(amountMinor, currency) + perUnit(unit),
 *    shown only when both amount and currency are known — minor units are
 *    never divided by 100 blindly (JPY has none);
 *  - the listings' stored structured_data (it claims InStock) is dropped;
 *  - related pages: one bounded read of the workspace's published pages,
 *    ranked same city → same category → same region → newest, at most 8;
 *  - the workspace's brand (brand_name, brand_color, logo_url) and the
 *    marketplace's own URLs for the calls to action.
 *
 * getPublicTenantPage (the public route and the platform preview) calls it
 * after its host, billing, redirect and status checks. An editor preview can
 * call it with a draft row it has already authorised.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  countMatchingListings,
  currencyMinorDigits,
  fetchPageListings,
  formatMoney,
  perUnit,
  type PublicListingRow,
} from "@/lib/coverage/inventory.server";
import {
  cleanText,
  resolveFilter,
  type ResolvedFilter,
  type TargetField,
} from "@/lib/coverage/target";
import {
  buildListingUrl,
  buildSearchUrl,
  resolveRouteConfig,
  type MarketplaceRouteConfig,
} from "@/lib/marketplace/adapter";
import { isPublicPageSlug } from "@/lib/public-page-slug";
import { placeText } from "@/components/templates/format";
import { isRenderableKind } from "@/components/templates/registry";
import { safeHttpUrl, sanitizeBrandColor } from "@/components/templates/theme";
import type {
  TemplateBranding,
  TemplateData,
  TemplateImage,
  TemplateKind,
  TemplateListing,
  TemplateMarketplace,
  TemplatePage,
  TemplatePrice,
  TemplateRelatedPage,
  TemplateRelation,
} from "@/components/templates/types";

const sb = () => supabaseAdmin as any;

/** Related-page links a page shows, at most. */
export const RELATED_PAGES_MAX = 8;
/** Published pages read to choose them from (one bounded read, newest first). */
export const RELATED_CANDIDATES_MAX = 200;
/** A Resource Article's listing strip. */
export const ARTICLE_STRIP_LISTINGS = 4;

/** The tenant_pages columns (and embeds) a page renders from. */
export const TENANT_PAGE_COLUMNS =
  "id, slug, title, seo_title, meta_description, h1, body_markdown, variables, listing_filter, noindex, published_at, updated_at, template_id, page_templates:template_id(slug, is_active), workspaces:workspace_id(name, brand_name, brand_color, logo_url)";

export type WorkspaceBrandRow = {
  name?: string | null;
  brand_name?: string | null;
  brand_color?: string | null;
  logo_url?: string | null;
};

export type TenantPageRow = {
  id: string | null;
  slug: string;
  title?: string | null;
  seo_title?: string | null;
  meta_description?: string | null;
  h1?: string | null;
  body_markdown?: string | null;
  variables?: unknown;
  listing_filter?: unknown;
  noindex?: boolean | null;
  published_at?: string | null;
  updated_at?: string | null;
  page_templates?: { slug?: string | null; is_active?: boolean | null } | null;
  workspaces?: WorkspaceBrandRow | null;
};

// ---------------------------------------------------------------------------
// Pure conversions
// ---------------------------------------------------------------------------

/** The workspace's brand, validated: a strict hex colour, an http(s) logo. */
export function brandingFrom(ws: WorkspaceBrandRow | null | undefined): TemplateBranding {
  return {
    name: cleanText(ws?.brand_name) ?? cleanText(ws?.name) ?? "",
    color: sanitizeBrandColor(ws?.brand_color),
    logoUrl: safeHttpUrl(ws?.logo_url),
  };
}

/** Where the calls to action go: the marketplace home and its unfiltered search. */
export function marketplaceFrom(cfg: MarketplaceRouteConfig | null): TemplateMarketplace {
  if (!cfg) return { homeUrl: null, browseUrl: null };
  const homeUrl = safeHttpUrl(cfg.baseUrl);
  if (!homeUrl) return { homeUrl: null, browseUrl: null };
  return { homeUrl, browseUrl: safeHttpUrl(buildSearchUrl(cfg, {})) ?? homeUrl };
}

/** A minor-unit amount as an exact decimal string in major units: (12500, 2) → "125.00". */
export function minorToDecimal(amountMinor: number, digits: number): string {
  const negative = amountMinor < 0;
  const abs = String(Math.abs(Math.trunc(amountMinor)));
  if (digits <= 0) return `${negative ? "-" : ""}${abs}`;
  const padded = abs.padStart(digits + 1, "0");
  return `${negative ? "-" : ""}${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
}

/**
 * The price a card shows, or null. Both the amount (a positive whole number
 * of minor units) and a well-formed currency code must be known.
 */
export function listingPrice(
  amountMinor: unknown,
  currency: unknown,
  unit: unknown,
): TemplatePrice | null {
  if (typeof amountMinor !== "number" || !Number.isInteger(amountMinor) || amountMinor <= 0) {
    return null;
  }
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(code)) return null;
  return {
    text: formatMoney(amountMinor, code),
    unitText: perUnit(typeof unit === "string" && unit.trim() ? unit.trim() : null),
    amount: minorToDecimal(amountMinor, currencyMinorDigits(code)),
    currency: code,
  };
}

/** The listing's URL slug, as the sync builds it (sharetribe-sync.server.ts mapListing). */
export function listingSlug(title: string | null | undefined): string {
  return (
    (title ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "listing"
  );
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** The listing's first usable photo. */
export function firstListingImage(images: unknown, title: string): TemplateImage | null {
  if (!Array.isArray(images)) return null;
  for (const img of images) {
    if (!img || typeof img !== "object") continue;
    const rec = img as Record<string, unknown>;
    const url = safeHttpUrl(rec.url);
    if (!url) continue;
    return {
      url,
      alt: cleanText(rec.alt) ?? title,
      width: positiveInt(rec.width),
      height: positiveInt(rec.height),
    };
  }
  return null;
}

/** One listing as its card shows it. */
export function toTemplateListing(
  row: PublicListingRow,
  cfg: MarketplaceRouteConfig | null,
): TemplateListing {
  const title = cleanText(row.title) ?? "Untitled listing";
  const derived =
    cfg && row.sharetribe_listing_id
      ? buildListingUrl(cfg, {
          sharetribe_listing_id: row.sharetribe_listing_id,
          slug: listingSlug(row.title),
        })
      : null;
  return {
    id: String(row.id),
    title,
    url: safeHttpUrl(derived) ?? safeHttpUrl(row.marketplace_url),
    image: firstListingImage(row.images, title),
    location: placeText({
      city: cleanText(row.city),
      region: cleanText(row.state),
      country: cleanText(row.country),
    }),
    price: listingPrice(row.price_amount, row.price_currency, row.price_unit),
  };
}

function plainObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The page's own fields, as the templates read them. */
export function pageFromRow(
  row: TenantPageRow,
  kind: TemplateKind,
  filter: ResolvedFilter | null,
  extra: { legacy: boolean; matchingListings: number | null },
): TemplatePage {
  const vars = plainObject(row.variables);
  const title = cleanText(row.title) ?? cleanText(row.h1) ?? row.slug;
  const meta = cleanText(row.meta_description);
  const labels = filter?.labels;
  return {
    id: row.id ?? null,
    kind,
    slug: row.slug,
    title,
    seoTitle: cleanText(row.seo_title),
    h1: cleanText(row.h1) ?? title,
    metaDescription: meta,
    intro: cleanText(vars.intro) ?? meta,
    bodyMarkdown: typeof row.body_markdown === "string" ? row.body_markdown : null,
    noindex: row.noindex === true,
    publishedAt: row.published_at ?? null,
    updatedAt: row.updated_at ?? null,
    place: {
      city: labels?.city ?? cleanText(vars.city),
      region: labels?.region ?? cleanText(vars.state),
      country: labels?.country ?? null,
    },
    category: labels?.category ?? null,
    // A builder page's category_plural is the marketplace's raw category id
    // ("pool_spa"), kept for the duplicate check — never a noun to print
    // ("24 pool_spa available"). Only a legacy page's hand-written noun shows.
    listingNoun: filter?.version === 2 ? null : cleanText(vars.category_plural),
    matchingListings: extra.matchingListings,
    legacy: extra.legacy,
  };
}

// ---------------------------------------------------------------------------
// Related pages
// ---------------------------------------------------------------------------

export type RelatedCandidateRow = {
  slug: string | null;
  title?: string | null;
  h1?: string | null;
  listing_filter?: unknown;
  page_templates?: { slug?: string | null; is_active?: boolean | null } | null;
};

type Constraints = ResolvedFilter["constraints"];

/** The field's key when the filter pins it to a value (not "unconstrained", not "no value"). */
function pinned(c: Constraints, field: TargetField): string | null {
  const v = c[field];
  return typeof v === "string" && v ? v : null;
}

/** Equal when both constrain the field; compatible when either leaves it open. */
function agrees(a: Constraints, b: Constraints, field: TargetField): boolean {
  if (!(field in a) || !(field in b)) return true;
  return (a[field] ?? null) === (b[field] ?? null);
}

/**
 * Rank the workspace's other published pages for this page: same city first
 * (Portland, OR is not Portland, ME — region and country must agree when both
 * name them), then same category, then same region, then the rest; newest
 * first within a rank (the order the candidates were read in). Pages whose
 * template has no active renderer are never linked (they would 404).
 */
export function rankRelatedPages(
  current: ResolvedFilter | null,
  candidates: readonly RelatedCandidateRow[],
  max = RELATED_PAGES_MAX,
): TemplateRelatedPage[] {
  const cur: Constraints = current?.constraints ?? {};
  const scored: Array<{ page: TemplateRelatedPage; score: number; order: number }> = [];
  candidates.forEach((c, order) => {
    const kind = c.page_templates?.slug;
    if (!isRenderableKind(kind) || c.page_templates?.is_active === false) return;
    if (!c.slug || !isPublicPageSlug(c.slug)) return;
    const f = resolveFilter(c.listing_filter ?? {});
    const con: Constraints = f?.constraints ?? {};
    const city = pinned(cur, "city");
    const region = pinned(cur, "region");
    const category = pinned(cur, "category");
    const sameCity =
      city !== null &&
      pinned(con, "city") === city &&
      agrees(cur, con, "region") &&
      agrees(cur, con, "country");
    const sameCategory = category !== null && pinned(con, "category") === category;
    const sameRegion =
      !sameCity &&
      region !== null &&
      pinned(con, "region") === region &&
      agrees(cur, con, "country");
    const relation: TemplateRelation = sameCity
      ? "same_city"
      : sameCategory
        ? "same_category"
        : sameRegion
          ? "same_region"
          : "other";
    scored.push({
      order,
      score: (sameCity ? 4 : 0) + (sameCategory ? 2 : 0) + (sameRegion ? 1 : 0),
      page: {
        slug: c.slug,
        title: cleanText(c.h1) ?? cleanText(c.title) ?? c.slug,
        kind,
        place: placeText({
          city: f?.labels.city ?? null,
          region: f?.labels.region ?? null,
          country: f?.labels.country ?? null,
        }),
        category: f?.labels.category ?? null,
        relation,
      },
    });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, Math.max(0, max)).map((s) => s.page);
}

/** One bounded read of the workspace's published pages, ranked for this page. */
export async function fetchRelatedPages(
  workspaceId: string,
  opts: { excludeSlug: string; filter: ResolvedFilter | null },
): Promise<TemplateRelatedPage[]> {
  try {
    const { data, error } = await sb()
      .from("tenant_pages")
      .select(
        "slug, title, h1, listing_filter, published_at, page_templates:template_id(slug, is_active)",
      )
      .eq("workspace_id", workspaceId)
      .eq("status", "published")
      .neq("slug", opts.excludeSlug)
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(RELATED_CANDIDATES_MAX);
    if (error) {
      console.error("[tenant-page] related pages read failed:", workspaceId, error.message);
      return [];
    }
    return rankRelatedPages(opts.filter, (data ?? []) as RelatedCandidateRow[]);
  } catch (e) {
    // Links to other pages are an extra; their failure never takes the page down.
    console.error("[tenant-page] related pages read failed:", workspaceId, String(e));
    return [];
  }
}

// ---------------------------------------------------------------------------
// The marketplace
// ---------------------------------------------------------------------------

/** The workspace's marketplace routes, or null (no connection, or a read failure — logged). */
export async function readRouteConfig(workspaceId: string): Promise<MarketplaceRouteConfig | null> {
  try {
    const { data, error } = await sb()
      .from("tenant_integrations")
      .select("marketplace_url, route_config")
      .eq("workspace_id", workspaceId)
      .eq("provider", "sharetribe")
      .maybeSingle();
    if (error) {
      console.error("[tenant-page] marketplace config read failed:", workspaceId, error.message);
      return null;
    }
    const base = safeHttpUrl(data?.marketplace_url);
    return base ? resolveRouteConfig(base, data?.route_config) : null;
  } catch (e) {
    // Degrades to the stored listing URLs and no marketplace CTA — never a broken page.
    console.error("[tenant-page] marketplace config read failed:", workspaceId, String(e));
    return null;
  }
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/**
 * Everything one page renders from. `row` must already be one the caller may
 * show (the public path passes published rows only). `kind` must be a
 * renderable template slug.
 */
export async function buildTenantPageData(
  workspaceId: string,
  row: TenantPageRow,
  opts: { kind: TemplateKind; legacy?: boolean },
): Promise<TemplateData> {
  const { kind } = opts;
  const legacy = opts.legacy === true;
  const filter = legacy ? null : resolveFilter(row.listing_filter ?? {});
  if (!legacy && !filter) {
    console.warn(
      `[tenant-page] ${workspaceId}/${row.slug}: listing_filter is not valid — rendering without listings`,
    );
  }
  const article = kind === "resource_article";
  // A Resource Article's strip is about something only when its filter names
  // something; an unconstrained filter would just be "the newest listings".
  const wantsListings = filter !== null && (!article || Object.keys(filter.constraints).length > 0);
  const limit = filter
    ? article
      ? Math.min(ARTICLE_STRIP_LISTINGS, filter.limit)
      : filter.limit
    : 0;

  const readListings = async (): Promise<PublicListingRow[]> => {
    if (!wantsListings || !filter) return [];
    if (!article) return fetchPageListings(workspaceId, filter, limit);
    try {
      return await fetchPageListings(workspaceId, filter, limit);
    } catch (e) {
      console.error("[tenant-page] article listing strip unavailable:", workspaceId, String(e));
      return [];
    }
  };

  const [cfg, rows, related] = await Promise.all([
    readRouteConfig(workspaceId),
    readListings(),
    fetchRelatedPages(workspaceId, { excludeSlug: row.slug, filter }),
  ]);

  let matchingListings: number | null = null;
  if (filter && !article) {
    if (rows.length < limit) {
      matchingListings = rows.length;
    } else {
      try {
        matchingListings = await countMatchingListings(workspaceId, filter);
      } catch (e) {
        console.error("[tenant-page] listing count unavailable:", workspaceId, String(e));
      }
    }
  }

  return {
    page: pageFromRow(row, kind, filter, { legacy, matchingListings }),
    listings: rows.map((r) => toTemplateListing(r, cfg)),
    related,
    branding: brandingFrom(row.workspaces),
    marketplace: marketplaceFrom(cfg),
  };
}
