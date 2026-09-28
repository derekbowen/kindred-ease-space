/**
 * Reads the facts a page is written from — through the page's own filter, so
 * the copy, the preview, the publish check and the public page all see one
 * listing set. Every read throws on a database error: a broken read must stop
 * the generation (nothing is charged yet), never ground the copy in "zero".
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  countMatchingListings,
  fetchPageListings,
  priceSummary,
  type PriceSummary,
} from "@/lib/coverage/inventory.server";
import { readCoverageGroups, type GroupRow } from "@/lib/coverage/coverage.server";
import {
  listingMatches,
  placeLabel,
  type PageKind,
  type ResolvedFilter,
} from "@/lib/coverage/target";
import {
  GROUNDING_BREAKDOWN_SIZE,
  GROUNDING_SAMPLE_SIZE,
  type GroundingBreakdown,
  type GroundingFacts,
} from "@/lib/page-grounding";

const sb = () => supabaseAdmin as any;

const EMPTY_PRICES: PriceSummary = { groups: [], unpriced: 0, complete: true };

/** The name the marketplace goes by: its brand name, else the workspace name. */
export async function readMarketplaceName(workspaceId: string): Promise<string | null> {
  const { data, error } = await sb()
    .from("workspaces")
    .select("brand_name, name")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(`workspace read failed: ${error.message}`);
  const name = String(data?.brand_name ?? "").trim() || String(data?.name ?? "").trim();
  return name || null;
}

function top(map: Map<string, number>): GroundingBreakdown[] {
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, GROUNDING_BREAKDOWN_SIZE);
}

/** Categories and places among the listings the filter matches, from the exact aggregate. */
export function breakdownsFor(
  groups: GroupRow[],
  filter: ResolvedFilter,
): { categories: GroundingBreakdown[]; places: GroundingBreakdown[] } {
  const categories = new Map<string, number>();
  const places = new Map<string, number>();
  for (const g of groups) {
    const keys = {
      countryKey: g.country_key,
      regionKey: g.region_key,
      cityKey: g.city_key,
      categoryKey: g.category_key,
    };
    if (!listingMatches(keys, filter)) continue;
    const n = Number(g.listing_count) || 0;
    if (g.category) categories.set(g.category, (categories.get(g.category) ?? 0) + n);
    const place = placeLabel({ city: g.city, region: g.region, country: g.country });
    if (g.city && place) places.set(place, (places.get(place) ?? 0) + n);
  }
  return { categories: top(categories), places: top(places) };
}

/**
 * Everything the model may use for one page. `listingCount` is passed in when
 * the caller already counted (the draft pipeline counts before anything else).
 */
export async function readGroundingFacts(
  workspaceId: string,
  kind: PageKind,
  filter: ResolvedFilter,
  listingCount?: number,
): Promise<GroundingFacts> {
  const count = listingCount ?? (await countMatchingListings(workspaceId, filter));
  const [prices, sample, groups, marketplaceName] = await Promise.all([
    count > 0 ? priceSummary(workspaceId, filter) : Promise.resolve(EMPTY_PRICES),
    count > 0 ? fetchPageListings(workspaceId, filter, GROUNDING_SAMPLE_SIZE) : Promise.resolve([]),
    readCoverageGroups(workspaceId),
    readMarketplaceName(workspaceId),
  ]);
  const { categories, places } = breakdownsFor(groups, filter);
  return {
    kind,
    filter,
    marketplaceName,
    listingCount: count,
    prices,
    sample,
    categories,
    places,
    asOf: new Date().toISOString().slice(0, 10),
  };
}
