/**
 * THE ONE INVENTORY QUERY — published listings that match a page's filter.
 *
 * The public renderer, the builder/editor preview, AI grounding, publish
 * validation and sitemap eligibility all read listings through this module
 * (applyFilter in ./target is the one translation of a filter to SQL), so the
 * listings a page shows, the facts its copy was written from and the count
 * its publish check saw are the same set.
 *
 * Errors are never zero: every read throws on a database error, so a caller
 * shows "couldn't load" instead of "no listings".
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { applyFilter, type ResolvedFilter } from "./target";

const sb = () => supabaseAdmin as any;

/** What a public page may show about a listing — nothing private. */
export const LISTING_PUBLIC_COLUMNS =
  "id, sharetribe_listing_id, title, description, price_amount, price_currency, price_unit, city, state, country, category, images, marketplace_url, structured_data, synced_at";

export type PublicListingRow = {
  id: string;
  sharetribe_listing_id: string | null;
  title: string | null;
  description: string | null;
  price_amount: number | null;
  price_currency: string | null;
  price_unit: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  category: string | null;
  images: unknown;
  marketplace_url: string | null;
  structured_data: unknown;
  synced_at: string | null;
};

/** PostgREST answers at most this many rows per request (Supabase default). */
export const PAGE_READ_SIZE = 1000;
/** A hard stop for full reads (price summaries): 20 pages of 1,000. */
export const MAX_FULL_READ_ROWS = 20_000;

/** The published-listings query for one workspace and filter. */
export function matchingListingsQuery(
  workspaceId: string,
  filter: ResolvedFilter,
  columns: string = LISTING_PUBLIC_COLUMNS,
  options?: { count?: "exact"; head?: boolean },
) {
  const q = sb()
    .from("tenant_listings")
    .select(columns, options)
    .eq("workspace_id", workspaceId)
    .eq("state_published", true);
  return applyFilter(q, filter);
}

/** Exact number of published listings matching the filter. Throws on error. */
export async function countMatchingListings(
  workspaceId: string,
  filter: ResolvedFilter,
): Promise<number> {
  const { count, error } = await matchingListingsQuery(workspaceId, filter, "id", {
    count: "exact",
    head: true,
  });
  if (error) throw new Error(`listing count failed: ${error.message}`);
  return Number(count ?? 0);
}

/** The listings a page shows: most recently synced first, then id (stable). Throws on error. */
export async function fetchPageListings(
  workspaceId: string,
  filter: ResolvedFilter,
  limit = filter.limit,
): Promise<PublicListingRow[]> {
  const { data, error } = await matchingListingsQuery(workspaceId, filter)
    .order("synced_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 100)));
  if (error) throw new Error(`listing read failed: ${error.message}`);
  return (data ?? []) as PublicListingRow[];
}

/**
 * Read EVERY row of an ordered query, 1,000 at a time — never a silent cap.
 * `order` must make the order total (end with a unique column). Returns
 * { rows, complete }: complete=false when maxRows stopped the read.
 */
export async function readAll<T>(
  makeQuery: () => any,
  maxRows = MAX_FULL_READ_ROWS,
): Promise<{ rows: T[]; complete: boolean }> {
  const rows: T[] = [];
  for (let from = 0; from < maxRows; from += PAGE_READ_SIZE) {
    const to = Math.min(from + PAGE_READ_SIZE, maxRows) - 1;
    const { data, error } = await makeQuery().range(from, to);
    if (error) throw new Error(`read failed: ${error.message}`);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < to - from + 1) return { rows, complete: true };
  }
  return { rows, complete: false };
}

// ---------------------------------------------------------------------------
// Prices — per currency AND per pricing unit, never mixed
// ---------------------------------------------------------------------------

export type PriceGroup = {
  currency: string;
  /** Sharetribe's unit type (hour, day, night, item…) or null when unknown. */
  unit: string | null;
  count: number;
  minMinor: number;
  maxMinor: number;
};

export type PriceSummary = {
  groups: PriceGroup[];
  /** Matching listings with no price, or no currency. */
  unpriced: number;
  /** false when the read stopped at MAX_FULL_READ_ROWS. */
  complete: boolean;
};

export function summarizePrices(
  rows: Array<{
    price_amount: number | null;
    price_currency: string | null;
    price_unit: string | null;
  }>,
): Omit<PriceSummary, "complete"> {
  const groups = new Map<string, PriceGroup>();
  let unpriced = 0;
  for (const r of rows) {
    const amount =
      typeof r.price_amount === "number" && Number.isFinite(r.price_amount) ? r.price_amount : null;
    const currency = (r.price_currency ?? "").trim().toUpperCase();
    if (amount === null || !currency) {
      unpriced++;
      continue;
    }
    const unit = (r.price_unit ?? "").trim().toLowerCase() || null;
    const key = `${currency}|${unit ?? ""}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
      g.minMinor = Math.min(g.minMinor, amount);
      g.maxMinor = Math.max(g.maxMinor, amount);
    } else {
      groups.set(key, { currency, unit, count: 1, minMinor: amount, maxMinor: amount });
    }
  }
  return {
    groups: [...groups.values()].sort(
      (a, b) => b.count - a.count || a.currency.localeCompare(b.currency),
    ),
    unpriced,
  };
}

/** Price facts over ALL matching published listings (bounded). Throws on error. */
export async function priceSummary(
  workspaceId: string,
  filter: ResolvedFilter,
): Promise<PriceSummary> {
  const { rows, complete } = await readAll<{
    price_amount: number | null;
    price_currency: string | null;
    price_unit: string | null;
  }>(() =>
    matchingListingsQuery(
      workspaceId,
      filter,
      "id, price_amount, price_currency, price_unit",
    ).order("id", {
      ascending: true,
    }),
  );
  return { ...summarizePrices(rows), complete };
}

/** Digits after the decimal point for a currency's minor unit (JPY 0, USD 2, KWD 3). */
export function currencyMinorDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** A minor-unit amount as money text: formatMoney(12500, "USD") → "$125". */
export function formatMoney(amountMinor: number, currency: string): string {
  const digits = currencyMinorDigits(currency);
  const major = amountMinor / 10 ** digits;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: Number.isInteger(major) ? 0 : Math.min(2, digits),
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    return `${major.toFixed(Math.min(2, digits))} ${currency}`;
  }
}

const UNIT_WORD: Record<string, string> = {
  hour: "hour",
  day: "day",
  night: "night",
  week: "week",
  month: "month",
  item: "item",
  person: "person",
};

/** "per hour" / "" — only for units Sharetribe actually reported. */
export function perUnit(unit: string | null): string {
  if (!unit) return "";
  const u = UNIT_WORD[unit.toLowerCase()];
  return u ? `per ${u}` : "";
}
