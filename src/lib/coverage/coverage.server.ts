/**
 * INVENTORY-BACKED COVERAGE — the one opportunity service.
 *
 * Which pages would the marketplace's own published inventory support, and
 * which of them exist? Built from exact aggregates (inventory_coverage_groups,
 * one call), a complete read of the workspace's pages, the sync's freshness
 * and the customer's dismissals. No truncation: every target is returned and
 * every total is exact; the UI pages through the list without changing the
 * totals. A database error is thrown — it never reads as "no opportunities".
 *
 * These are coverage opportunities, not demand data: nothing here claims
 * search volume, difficulty, revenue or rankings.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  MIN_LISTINGS_FOR_PAGE,
  makeFilter,
  pageCoversTarget,
  placeLabel,
  resolveFilter,
  scopeFor,
  targetKey,
  type InventoryFilterV2,
  type PageKind,
  type ResolvedFilter,
  type TargetKeys,
  type TargetLabels,
} from "./target";
import { readAll } from "./inventory.server";

const sb = () => supabaseAdmin as any;

export type CoverageState =
  | "published"
  | "suspended"
  | "draft"
  | "archived"
  | "missing"
  | "insufficient";

export type EvidenceState = "complete" | "stale" | "incomplete" | "never_synced";

export type CoveragePageRef = {
  id: string;
  slug: string;
  title: string;
  status: string;
  updatedAt: string | null;
};

export type CoverageItem = {
  targetKey: string;
  kind: Extract<PageKind, "city_hub" | "category_page">;
  labels: TargetLabels;
  keys: TargetKeys;
  /** The filter a new page for this target is created with. */
  filter: InventoryFilterV2;
  listingCount: number;
  pricedCount: number;
  currencies: string[];
  state: CoverageState;
  /** The page to resume or review (published first, then suspended, draft, archived). */
  page: CoveragePageRef | null;
  /** Every page of this workspace that covers the target. */
  pages: CoveragePageRef[];
  dismissed: boolean;
  reason: string;
  warnings: string[];
};

export type CoverageEvidence = {
  state: EvidenceState;
  connected: boolean;
  lastSuccessAt: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  listingsCount: number | null;
  upstreamTotal: number | null;
  message: string;
};

export type CoverageTotals = {
  targets: number;
  missing: number;
  insufficient: number;
  draft: number;
  published: number;
  suspended: number;
  archived: number;
  dismissed: number;
  /** Published listings in the workspace (sum over every group). */
  listings: number;
  /** Published listings with no city (on no City Hub). */
  withoutCity: number;
  /** Published listings with no category (on no Category Page). */
  withoutCategory: number;
  /** Listings synced before keys existed: they need one more sync to be counted. */
  needsResync: number;
};

export type CoverageReport = {
  evidence: CoverageEvidence;
  totals: CoverageTotals;
  items: CoverageItem[];
  /** What was and was not checked — shown on the screen, never hidden. */
  scopeNote: string;
};

/** A day without a successful sync makes the evidence stale. */
export const STALE_AFTER_MS = 24 * 3600_000;

export const COVERAGE_SCOPE_NOTE =
  "Opportunities come from your published Sharetribe listings and the pages you created in Founders.click. Pages that live elsewhere on your website were not checked, and nothing here is search-volume data.";

type GroupRow = {
  country_key: string | null;
  region_key: string | null;
  city_key: string | null;
  category_key: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  category: string | null;
  listing_count: number | string;
  priced_count: number | string;
  currencies: string[] | null;
  price_units: string[] | null;
  unkeyed_count: number | string;
};

type PageRow = {
  id: string;
  slug: string;
  title: string | null;
  status: string | null;
  listing_filter: unknown;
  target_key: string | null;
  updated_at: string | null;
  page_templates: { slug: string | null } | null;
};

type Acc = {
  keys: TargetKeys;
  labels: TargetLabels;
  listingCount: number;
  pricedCount: number;
  currencies: Set<string>;
};

const num = (v: number | string | null | undefined) => Number(v ?? 0) || 0;

/** Pure: build the report from the three reads. Exported for tests. */
export function buildCoverageReport(input: {
  groups: GroupRow[];
  pages: PageRow[];
  dismissedKeys: Set<string>;
  integration: {
    status: string | null;
    last_success_at: string | null;
    last_sync_at: string | null;
    last_sync_status: string | null;
    listings_count: number | null;
    upstream_total: number | null;
  } | null;
  now?: number;
}): CoverageReport {
  const now = input.now ?? Date.now();
  const cities = new Map<string, Acc>();
  const categories = new Map<string, Acc>();
  let listings = 0;
  let withoutCity = 0;
  let withoutCategory = 0;
  let needsResync = 0;

  const add = (
    map: Map<string, Acc>,
    key: string,
    keys: TargetKeys,
    labels: TargetLabels,
    g: GroupRow,
  ) => {
    const acc = map.get(key);
    const n = num(g.listing_count);
    if (acc) {
      acc.listingCount += n;
      acc.pricedCount += num(g.priced_count);
      for (const c of g.currencies ?? []) acc.currencies.add(c);
    } else {
      map.set(key, {
        keys,
        labels,
        listingCount: n,
        pricedCount: num(g.priced_count),
        currencies: new Set(g.currencies ?? []),
      });
    }
  };

  for (const g of input.groups) {
    const n = num(g.listing_count);
    listings += n;
    needsResync += num(g.unkeyed_count);
    if (g.city_key) {
      const keys: TargetKeys = {
        countryKey: g.country_key,
        regionKey: g.region_key,
        cityKey: g.city_key,
        categoryKey: null,
      };
      const labels: TargetLabels = {
        country: g.country,
        region: g.region,
        city: g.city,
        category: null,
      };
      add(cities, `${g.country_key ?? "-"}|${g.region_key ?? "-"}|${g.city_key}`, keys, labels, g);
    } else {
      withoutCity += n;
    }
    if (g.category_key) {
      const keys: TargetKeys = {
        countryKey: null,
        regionKey: null,
        cityKey: null,
        categoryKey: g.category_key,
      };
      const labels: TargetLabels = {
        country: null,
        region: null,
        city: null,
        category: g.category,
      };
      add(categories, g.category_key, keys, labels, g);
    } else {
      withoutCategory += n;
    }
  }

  // Existing pages, by kind, with their resolved filters.
  type ResolvedPage = {
    ref: CoveragePageRef;
    kind: PageKind;
    filter: ResolvedFilter | null;
    targetKey: string | null;
  };
  const resolvedPages: ResolvedPage[] = input.pages.map((p) => {
    const kind = (p.page_templates?.slug ?? "city_hub") as PageKind;
    return {
      ref: {
        id: p.id,
        slug: p.slug,
        title: p.title ?? p.slug,
        status: p.status ?? "draft",
        updatedAt: p.updated_at,
      },
      kind,
      filter: resolveFilter(p.listing_filter ?? {}),
      targetKey: p.target_key,
    };
  });
  const byTargetKey = new Map<string, ResolvedPage[]>();
  for (const rp of resolvedPages) {
    if (!rp.targetKey) continue;
    const list = byTargetKey.get(rp.targetKey) ?? [];
    list.push(rp);
    byTargetKey.set(rp.targetKey, list);
  }
  const legacyPages = resolvedPages.filter((rp) => !rp.targetKey && rp.filter);

  const evidence = evidenceOf(input.integration, now);

  const items: CoverageItem[] = [];
  const build = (kind: CoverageItem["kind"], acc: Acc) => {
    const filter = makeFilter(scopeFor(kind, false), acc.keys, acc.labels);
    const resolved = resolveFilter(filter)!;
    const key = targetKey(kind, resolved)!;
    const covering = [
      ...(byTargetKey.get(key) ?? []),
      ...legacyPages.filter((rp) =>
        pageCoversTarget({ kind: rp.kind, filter: rp.filter! }, { kind, filter: resolved }),
      ),
    ];
    const pick = (status: string) => covering.find((c) => c.ref.status === status)?.ref ?? null;
    const published = pick("published");
    const suspended = pick("billing_suspended");
    const draft = pick("draft");
    const archived = pick("archived");
    let state: CoverageState;
    let page: CoveragePageRef | null = null;
    if (published) {
      state = "published";
      page = published;
    } else if (suspended) {
      state = "suspended";
      page = suspended;
    } else if (draft) {
      state = "draft";
      page = draft;
    } else if (archived && acc.listingCount >= MIN_LISTINGS_FOR_PAGE) {
      state = "archived";
      page = archived;
    } else if (acc.listingCount < MIN_LISTINGS_FOR_PAGE) {
      state = "insufficient";
      page = archived;
    } else {
      state = "missing";
    }
    const warnings: string[] = [];
    if (evidence.state !== "complete") warnings.push(evidence.message);
    items.push({
      targetKey: key,
      kind,
      labels: acc.labels,
      keys: acc.keys,
      filter,
      listingCount: acc.listingCount,
      pricedCount: acc.pricedCount,
      currencies: [...acc.currencies].sort(),
      state,
      page,
      pages: covering.map((c) => c.ref),
      dismissed: input.dismissedKeys.has(key),
      reason: reasonFor(kind, state, acc),
      warnings,
    });
  };
  for (const acc of cities.values()) build("city_hub", acc);
  for (const acc of categories.values()) build("category_page", acc);

  const order: Record<CoverageState, number> = {
    missing: 0,
    draft: 1,
    suspended: 2,
    archived: 3,
    published: 4,
    insufficient: 5,
  };
  items.sort(
    (a, b) =>
      Number(a.dismissed) - Number(b.dismissed) ||
      order[a.state] - order[b.state] ||
      b.listingCount - a.listingCount ||
      a.targetKey.localeCompare(b.targetKey),
  );

  const count = (s: CoverageState) => items.filter((i) => i.state === s && !i.dismissed).length;
  return {
    evidence,
    totals: {
      targets: items.length,
      missing: count("missing"),
      insufficient: count("insufficient"),
      draft: count("draft"),
      published: count("published"),
      suspended: count("suspended"),
      archived: count("archived"),
      dismissed: items.filter((i) => i.dismissed).length,
      listings,
      withoutCity,
      withoutCategory,
      needsResync,
    },
    items,
    scopeNote: COVERAGE_SCOPE_NOTE,
  };
}

function evidenceOf(
  integration: {
    status: string | null;
    last_success_at: string | null;
    last_sync_at: string | null;
    last_sync_status: string | null;
    listings_count: number | null;
    upstream_total: number | null;
  } | null,
  now: number,
): CoverageEvidence {
  if (!integration) {
    return {
      state: "never_synced",
      connected: false,
      lastSuccessAt: null,
      lastSyncAt: null,
      lastSyncStatus: null,
      listingsCount: null,
      upstreamTotal: null,
      message:
        "Connect Sharetribe and run a sync — opportunities come from your published listings.",
    };
  }
  const base = {
    connected: integration.status === "connected",
    lastSuccessAt: integration.last_success_at,
    lastSyncAt: integration.last_sync_at,
    lastSyncStatus: integration.last_sync_status,
    listingsCount: integration.listings_count,
    upstreamTotal: integration.upstream_total,
  };
  if (!integration.last_success_at) {
    return {
      ...base,
      state: "never_synced",
      message: "No complete sync yet — these numbers may not include every listing.",
    };
  }
  const lastAttemptAfterSuccess =
    integration.last_sync_at &&
    Date.parse(integration.last_sync_at) > Date.parse(integration.last_success_at);
  if (
    lastAttemptAfterSuccess &&
    integration.last_sync_status &&
    integration.last_sync_status !== "success"
  ) {
    return {
      ...base,
      state: "incomplete",
      message: "The latest sync did not complete — counts reflect the last complete sync.",
    };
  }
  if (now - Date.parse(integration.last_success_at) > STALE_AFTER_MS) {
    return {
      ...base,
      state: "stale",
      message:
        "Your listings haven't synced successfully in over a day — counts may be out of date.",
    };
  }
  return { ...base, state: "complete", message: "Listings are up to date." };
}

function reasonFor(kind: CoverageItem["kind"], state: CoverageState, acc: Acc): string {
  const what =
    kind === "city_hub"
      ? placeLabel(acc.labels) || "this place"
      : acc.labels.category || "this category";
  const n = acc.listingCount;
  const listings = `${n} published listing${n === 1 ? "" : "s"}`;
  switch (state) {
    case "missing":
      return `${listings} in ${what} and no page for it yet.`;
    case "draft":
      return `A draft for ${what} is in progress — resume it instead of starting another.`;
    case "published":
      return `${what} already has a published page (${listings}).`;
    case "suspended":
      return `The page for ${what} is paused by your plan's page limit.`;
    case "archived":
      return `The page for ${what} was archived — it isn't live. ${listings} could support a new one.`;
    case "insufficient":
      return `Only ${listings} in ${what} — a page needs at least ${MIN_LISTINGS_FOR_PAGE} to be useful.`;
  }
}

/** Read everything and build the report. Throws on any read error. */
export async function loadCoverage(workspaceId: string): Promise<CoverageReport> {
  const groupsRes = await sb().rpc("inventory_coverage_groups", { _workspace_id: workspaceId });
  if (groupsRes.error) throw new Error(`coverage groups failed: ${groupsRes.error.message}`);

  const { rows: pages, complete: pagesComplete } = await readAll<PageRow>(
    () =>
      sb()
        .from("tenant_pages")
        .select(
          "id, slug, title, status, listing_filter, target_key, updated_at, page_templates:template_id(slug)",
        )
        .eq("workspace_id", workspaceId)
        .order("id", { ascending: true }),
    100_000,
  );
  if (!pagesComplete) throw new Error("coverage: too many pages to read completely");

  const [{ data: dismissals, error: dErr }, { data: integration, error: iErr }] = await Promise.all(
    [
      sb().from("coverage_dismissals").select("target_key").eq("workspace_id", workspaceId),
      sb()
        .from("tenant_integrations")
        .select(
          "status, last_success_at, last_sync_at, last_sync_status, listings_count, upstream_total",
        )
        .eq("workspace_id", workspaceId)
        .eq("provider", "sharetribe")
        .maybeSingle(),
    ],
  );
  if (dErr) throw new Error(`coverage dismissals failed: ${dErr.message}`);
  if (iErr) throw new Error(`coverage sync state failed: ${iErr.message}`);

  return buildCoverageReport({
    groups: (groupsRes.data ?? []) as GroupRow[],
    pages,
    dismissedKeys: new Set(
      ((dismissals ?? []) as Array<{ target_key: string }>).map((d) => d.target_key),
    ),
    integration: (integration as any) ?? null,
  });
}

/** One coverage item by key, from a fresh report (for the builder). */
export async function findCoverageItem(
  workspaceId: string,
  key: string,
): Promise<CoverageItem | null> {
  const report = await loadCoverage(workspaceId);
  return report.items.find((i) => i.targetKey === key) ?? null;
}
