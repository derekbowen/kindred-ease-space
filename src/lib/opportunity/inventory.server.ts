/**
 * INVENTORY INTELLIGENCE — roll tenant_listings up into a queryable supply map.
 *
 * Evaluating candidates against raw listings would mean one aggregate scan per
 * candidate. This computes the rollup once per sync and every gate reads it as
 * a plain indexed lookup.
 *
 * Rows are written at two grains: (geo, category) and (geo, '') — the latter
 * lets a location-only candidate be evaluated without a category.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalizeCategory, normalizeGeo } from "./intent";

const sb = () => supabaseAdmin as any;

type ListingRow = {
  city: string | null;
  state: string | null;
  category: string | null;
  price_amount: number | null;
  price_currency: string | null;
  author_id: string | null;
  images: unknown;
  synced_at: string;
  state_published: boolean;
};

type Bucket = {
  geo_key: string;
  city: string | null;
  state: string | null;
  category_key: string;
  listings: number;
  providers: Set<string>;
  prices: number[];
  currency: string | null;
  freshest: string | null;
  withImages: number;
};

function median(sorted: number[]): number | null {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function rebuildInventoryAggregates(workspaceId: string): Promise<{ rows: number }> {
  const buckets = new Map<string, Bucket>();

  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data } = await sb()
      .from("tenant_listings")
      .select("city, state, category, price_amount, price_currency, author_id, images, synced_at, state_published")
      .eq("workspace_id", workspaceId)
      .eq("state_published", true)
      .range(offset, offset + PAGE - 1);

    const rows = (data ?? []) as ListingRow[];
    if (!rows.length) break;

    for (const r of rows) {
      const geo = normalizeGeo(r.city, r.state);
      if (!geo) continue;
      const cat = normalizeCategory(r.category);
      const hasImage = Array.isArray(r.images) && r.images.length > 0;

      // Write at both grains so category-less candidates still resolve.
      for (const categoryKey of cat ? [cat, ""] : [""]) {
        const key = `${geo}::${categoryKey}`;
        let b = buckets.get(key);
        if (!b) {
          b = {
            geo_key: geo,
            city: r.city,
            state: r.state,
            category_key: categoryKey,
            listings: 0,
            providers: new Set(),
            prices: [],
            currency: null,
            freshest: null,
            withImages: 0,
          };
          buckets.set(key, b);
        }
        b.listings += 1;
        if (r.author_id) b.providers.add(r.author_id);
        if (typeof r.price_amount === "number") b.prices.push(r.price_amount);
        if (!b.currency && r.price_currency) b.currency = r.price_currency;
        if (hasImage) b.withImages += 1;
        if (!b.freshest || r.synced_at > b.freshest) b.freshest = r.synced_at;
      }
    }
    if (rows.length < PAGE) break;
  }

  const now = new Date().toISOString();
  const payload = [...buckets.values()].map((b) => {
    const sorted = [...b.prices].sort((x, y) => x - y);
    return {
      workspace_id: workspaceId,
      geo_key: b.geo_key,
      city: b.city,
      state: b.state,
      category_key: b.category_key,
      listing_count: b.listings,
      provider_count: b.providers.size,
      price_min: sorted.length ? sorted[0] : null,
      price_max: sorted.length ? sorted[sorted.length - 1] : null,
      price_median: median(sorted),
      currency: b.currency,
      freshest_at: b.freshest,
      with_image_count: b.withImages,
      computed_at: now,
    };
  });

  // Replace wholesale — supply shrinks as well as grows, and a stale row that
  // over-reports inventory would let a WAIT_FOR_INVENTORY candidate through.
  await sb().from("inventory_aggregates").delete().eq("workspace_id", workspaceId);
  for (let i = 0; i < payload.length; i += 200) {
    await sb().from("inventory_aggregates").insert(payload.slice(i, i + 200));
  }
  return { rows: payload.length };
}

export type InventoryFact = {
  geoKey: string;
  categoryKey: string;
  city: string | null;
  state: string | null;
  listingCount: number;
  providerCount: number;
  priceMin: number | null;
  priceMax: number | null;
  priceMedian: number | null;
  currency: string | null;
  freshestAt: string | null;
  withImageCount: number;
};

export async function loadInventoryMap(workspaceId: string): Promise<Map<string, InventoryFact>> {
  const map = new Map<string, InventoryFact>();
  const { data } = await sb()
    .from("inventory_aggregates")
    .select("*")
    .eq("workspace_id", workspaceId);
  for (const r of (data ?? []) as any[]) {
    map.set(`${r.geo_key}::${r.category_key}`, {
      geoKey: r.geo_key,
      categoryKey: r.category_key,
      city: r.city,
      state: r.state,
      listingCount: r.listing_count,
      providerCount: r.provider_count,
      priceMin: r.price_min,
      priceMax: r.price_max,
      priceMedian: r.price_median,
      currency: r.currency,
      freshestAt: r.freshest_at,
      withImageCount: r.with_image_count,
    });
  }
  return map;
}

/** Count distinct facts a page could legitimately be written from. Drives the
 *  unique-data gate — a page with nothing specific to say is a thin page. */
export function countUniqueFacts(inv: InventoryFact | undefined): number {
  if (!inv) return 0;
  let n = 0;
  if (inv.listingCount > 0) n++;
  if (inv.providerCount > 1) n++;
  if (inv.priceMin !== null && inv.priceMax !== null && inv.priceMax > inv.priceMin) n++;
  if (inv.priceMedian !== null) n++;
  if (inv.withImageCount > 0) n++;
  if (inv.listingCount >= 10) n++;
  return n;
}
