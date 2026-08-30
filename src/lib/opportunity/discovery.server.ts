/**
 * CANDIDATE DISCOVERY + DECISION.
 *
 * V1 uses only high-signal sources — no arbitrary city x category
 * cross-products. A candidate is not a recommendation; every candidate runs
 * the deterministic gate battery before anything is shown to a customer.
 *
 *   Source 1: GSC query clusters with demand and no strong matching page
 *   Source 2: inventory-supported geographies with no page
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  buildIntentKey,
  canonicalTokens,
  categoryFromPhrase,
  detectCollision,
  normalizeCategory,
  normalizeGeo,
  slugForIntent,
  titleForIntent,
  type ComparableIntent,
} from "./intent";
import { evaluate, resolveGateConfig, type CandidateSignals, type GateConfig } from "./gates";
import { countUniqueFacts, loadInventoryMap, type InventoryFact } from "./inventory.server";

const sb = () => supabaseAdmin as any;

type GscRow = {
  query: string;
  url_path: string;
  impressions: number;
  clicks: number;
  position: number | null;
};

type Candidate = {
  intentKey: string;
  label: string;
  categoryKey: string;
  geoKey: string;
  city: string;
  state: string;
  queries: string[];
  rankingUrls: string[];
  impressions: number;
  clicks: number;
  bestPosition: number | null;
  source: "gsc_gap" | "inventory_gap";
};

export type DiscoveryReport = {
  candidatesGenerated: number;
  candidatesRejected: number;
  buildNewPage: number;
  improveExisting: number;
  waitForInventory: number;
  doNotBuild: number;
  bySource: Record<string, number>;
};

/** Reverse-lookup: geo token -> {city,state} using the customer's inventory. */
async function geoLabels(workspaceId: string): Promise<Map<string, { city: string; state: string }>> {
  const m = new Map<string, { city: string; state: string }>();
  const { data } = await sb()
    .from("tenant_listings")
    .select("city, state")
    .eq("workspace_id", workspaceId)
    .not("city", "is", null)
    .limit(5000);
  for (const r of (data ?? []) as Array<{ city: string; state: string | null }>) {
    const key = normalizeGeo(r.city, r.state);
    if (key && !m.has(key)) m.set(key, { city: r.city, state: r.state ?? "" });
  }
  return m;
}

function clusterGscRows(rows: GscRow[], geoMap: Map<string, { city: string; state: string }>): Candidate[] {
  const byIntent = new Map<string, Candidate>();

  for (const r of rows) {
    if (!r.query) continue;
    // Find which known geography this query mentions, if any.
    const qTokens = new Set(canonicalTokens(r.query));
    let matchedGeo = "";
    let city = "";
    let state = "";
    for (const [geoKey, label] of geoMap) {
      const cityTok = canonicalTokens(label.city);
      if (cityTok.length && cityTok.every((t) => qTokens.has(t))) {
        matchedGeo = geoKey;
        city = label.city;
        state = label.state;
        break;
      }
    }
    if (!matchedGeo) continue; // V1 is location-intent only — highest signal

    const categoryKey = categoryFromPhrase(r.query, city, state);
    if (!categoryKey) continue;

    const intentKey = buildIntentKey(categoryKey, matchedGeo);
    let c = byIntent.get(intentKey);
    if (!c) {
      c = {
        intentKey,
        label: titleForIntent(categoryKey, city, state),
        categoryKey,
        geoKey: matchedGeo,
        city,
        state,
        queries: [],
        rankingUrls: [],
        impressions: 0,
        clicks: 0,
        bestPosition: null,
        source: "gsc_gap",
      };
      byIntent.set(intentKey, c);
    }
    c.queries.push(r.query);
    c.impressions += r.impressions ?? 0;
    c.clicks += r.clicks ?? 0;
    if (r.url_path && !c.rankingUrls.includes(r.url_path)) c.rankingUrls.push(r.url_path);
    if (typeof r.position === "number") {
      c.bestPosition = c.bestPosition === null ? r.position : Math.min(c.bestPosition, r.position);
    }
  }
  return [...byIntent.values()];
}

function inventoryCandidates(
  inventory: Map<string, InventoryFact>,
  cfg: GateConfig,
  existing: Set<string>,
): Candidate[] {
  const out: Candidate[] = [];
  for (const [, inv] of inventory) {
    if (!inv.categoryKey) continue; // need a category to write a page about
    if (inv.listingCount < cfg.minListings) continue;
    if (inv.providerCount < cfg.minProviders) continue;
    const intentKey = buildIntentKey(inv.categoryKey, inv.geoKey);
    if (existing.has(intentKey)) continue;
    out.push({
      intentKey,
      label: titleForIntent(inv.categoryKey, inv.city ?? "", inv.state ?? ""),
      categoryKey: inv.categoryKey,
      geoKey: inv.geoKey,
      city: inv.city ?? "",
      state: inv.state ?? "",
      queries: [],
      rankingUrls: [],
      impressions: 0,
      clicks: 0,
      bestPosition: null,
      source: "inventory_gap",
    });
  }
  return out;
}

export async function runDiscovery(workspaceId: string): Promise<DiscoveryReport> {
  const { data: ws } = await sb()
    .from("workspaces")
    .select("opportunity_gate_config")
    .eq("id", workspaceId)
    .maybeSingle();
  const cfg = resolveGateConfig(ws?.opportunity_gate_config);

  const [inventory, geoMap] = await Promise.all([
    loadInventoryMap(workspaceId),
    geoLabels(workspaceId),
  ]);

  // ---- Existing pages, for collision detection ----------------------------
  const { data: tenantPages } = await sb()
    .from("tenant_pages")
    .select("id, slug, title, status, variables")
    .eq("workspace_id", workspaceId)
    .in("status", ["published", "draft"]);

  const existingIntents: Array<ComparableIntent & { ref: string }> = [];
  for (const p of (tenantPages ?? []) as any[]) {
    const vars = (p.variables ?? {}) as Record<string, string>;
    const geo = normalizeGeo(vars.city ?? "", vars.state ?? "") || null;
    const cat = categoryFromPhrase(p.title ?? p.slug ?? "", vars.city ?? "", vars.state ?? "");
    existingIntents.push({
      ref: `/a/${p.slug}`,
      categoryKey: cat,
      geoKey: geo ?? "",
      titleTokens: canonicalTokens(`${p.title ?? ""} ${p.slug ?? ""}`),
      queries: [],
      rankingUrls: [`/a/${p.slug}`],
    });
  }

  // The customer's own existing site counts too — SITE_COVERAGE.
  const { data: scanPages } = await sb()
    .from("site_scan_pages")
    .select("url, title, inferred_category, inferred_geo")
    .eq("workspace_id", workspaceId)
    .limit(500);
  const siteIntents: Array<ComparableIntent & { ref: string }> = [];
  for (const p of (scanPages ?? []) as any[]) {
    siteIntents.push({
      ref: p.url,
      categoryKey: p.inferred_category ?? "",
      geoKey: p.inferred_geo ?? "",
      titleTokens: canonicalTokens(p.title ?? ""),
      queries: [],
      rankingUrls: [],
    });
  }

  // ---- Candidate generation ----------------------------------------------
  const { data: gsc } = await sb()
    .from("gsc_query_data")
    .select("query, url_path, impressions, clicks, position")
    .eq("workspace_id", workspaceId)
    .limit(5000);

  const gscCandidates = clusterGscRows((gsc ?? []) as GscRow[], geoMap);
  const seen = new Set(gscCandidates.map((c) => c.intentKey));
  const invCandidates = inventoryCandidates(inventory, cfg, seen);
  const candidates = [...gscCandidates, ...invCandidates];

  const report: DiscoveryReport = {
    candidatesGenerated: candidates.length,
    candidatesRejected: 0,
    buildNewPage: 0,
    improveExisting: 0,
    waitForInventory: 0,
    doNotBuild: 0,
    bySource: {},
  };

  // Candidates are compared against each other too, so a run cannot propose
  // fifty wordings of the same intent.
  const acceptedIntents: Array<ComparableIntent & { ref: string }> = [];

  for (const c of candidates) {
    report.bySource[c.source] = (report.bySource[c.source] ?? 0) + 1;

    const inv =
      inventory.get(`${c.geoKey}::${c.categoryKey}`) ?? inventory.get(`${c.geoKey}::`);

    const me: ComparableIntent = {
      categoryKey: c.categoryKey,
      geoKey: c.geoKey,
      titleTokens: canonicalTokens(c.label),
      queries: c.queries,
      rankingUrls: c.rankingUrls,
    };

    // Best collision across all three corpora.
    let bestSim = 0;
    let bestReasons: string[] = [];
    let bestRef: string | null = null;
    let bestKind: string | null = null;
    let siteCovers = false;

    for (const [kind, corpus] of [
      ["tenant_page", existingIntents],
      ["site_scan_page", siteIntents],
      ["opportunity", acceptedIntents],
    ] as const) {
      for (const other of corpus) {
        const r = detectCollision(me, other);
        if (kind === "site_scan_page" && r.similarity >= 0.75) siteCovers = true;
        if (r.similarity > bestSim) {
          bestSim = r.similarity;
          bestReasons = r.reasons;
          bestRef = other.ref;
          bestKind = kind;
        }
      }
    }

    const freshDays = inv?.freshestAt
      ? Math.floor((Date.now() - new Date(inv.freshestAt).getTime()) / 86_400_000)
      : null;

    const signals: CandidateSignals = {
      impressions: c.impressions,
      clicks: c.clicks,
      bestPosition: c.bestPosition,
      queryCount: c.queries.length,
      rankingUrl: c.rankingUrls[0] ?? null,
      listingCount: inv?.listingCount ?? 0,
      providerCount: inv?.providerCount ?? 0,
      inventoryAgeDays: freshDays,
      priceSpread: Boolean(inv && inv.priceMin !== null && inv.priceMax !== null && inv.priceMax > inv.priceMin),
      hasSitePageForIntent: siteCovers,
      // BUSINESS_COVERAGE is inventory or category presence on the site —
      // deliberately NOT "a page for this exact location exists".
      businessServesCategory:
        (inv?.listingCount ?? 0) > 0 ||
        siteIntents.some((s) => s.categoryKey && s.categoryKey === c.categoryKey),
      collisionSimilarity: bestSim,
      collisionReasons: bestReasons,
      collisionRef: bestRef,
      uniqueFactCount: countUniqueFacts(inv),
    };

    const decision = evaluate(signals, cfg);

    if (decision.recommendation === "BUILD_NEW_PAGE") {
      report.buildNewPage++;
      acceptedIntents.push({ ...me, ref: c.label });
    } else {
      report.candidatesRejected++;
      if (decision.recommendation === "IMPROVE_EXISTING") report.improveExisting++;
      if (decision.recommendation === "WAIT_FOR_INVENTORY") report.waitForInventory++;
      if (decision.recommendation === "DO_NOT_BUILD") report.doNotBuild++;
    }

    const status =
      decision.recommendation === "BUILD_NEW_PAGE"
        ? "recommended"
        : decision.recommendation === "WAIT_FOR_INVENTORY"
          ? "deferred"
          : "blocked";

    const { data: oppRow } = await sb()
      .from("seo_opportunities")
      .upsert(
        {
          workspace_id: workspaceId,
          intent_key: c.intentKey,
          intent_label: c.label,
          normalized_category: c.categoryKey,
          normalized_geo: c.geoKey,
          geo_city: c.city,
          geo_state: c.state,
          query_variants: c.queries.slice(0, 50),
          ranking_urls: c.rankingUrls.slice(0, 20),
          proposed_slug: slugForIntent(c.categoryKey, c.city, c.state),
          proposed_title: c.label,
          recommendation: decision.recommendation,
          band: decision.band,
          opportunity_score: decision.score,
          confidence: decision.confidence,
          score_breakdown: decision.breakdown,
          gate_results: decision.gates,
          explanation: decision.explanation,
          nearest_page_kind: bestKind,
          nearest_page_ref: bestRef,
          nearest_page_similarity: bestSim,
          status,
          source: c.source,
          recommended_at: new Date().toISOString(),
        },
        { onConflict: "workspace_id,intent_key" },
      )
      .select("id")
      .maybeSingle();

    // Evidence is persisted per-signal so the UI can explain itself and the
    // recommendation stays auditable after the data moves on.
    if (oppRow?.id) {
      await sb().from("opportunity_evidence").delete().eq("opportunity_id", oppRow.id);
      const ev: any[] = [];
      const push = (source: string, metric: string, num: number | null, text: string | null, detail: string) =>
        ev.push({
          opportunity_id: oppRow.id,
          workspace_id: workspaceId,
          source,
          metric,
          value_num: num,
          value_text: text,
          detail,
        });

      if (c.impressions > 0) {
        push("GSC", "impressions", c.impressions, null, `${c.impressions} impressions across ${c.queries.length} queries`);
        if (c.bestPosition !== null)
          push("GSC", "best_position", c.bestPosition, c.rankingUrls[0] ?? null, `Best position ${Math.round(c.bestPosition)}`);
      }
      if (inv) {
        push("INVENTORY", "listing_count", inv.listingCount, null, `${inv.listingCount} active listings`);
        push("INVENTORY", "provider_count", inv.providerCount, null, `${inv.providerCount} providers`);
        if (inv.priceMin !== null && inv.priceMax !== null)
          push("INVENTORY", "price_range", null, `${inv.priceMin}-${inv.priceMax} ${inv.currency ?? ""}`, "Price range available");
      }
      push(
        "SITE_COVERAGE",
        "has_page",
        siteCovers ? 1 : 0,
        bestRef,
        siteCovers ? "Your site already covers this intent" : "No page on your site targets this intent",
      );
      push(
        "BUSINESS_COVERAGE",
        "serves_category",
        signals.businessServesCategory ? 1 : 0,
        null,
        signals.businessServesCategory
          ? "Business offers this category"
          : "No evidence this business offers this category",
      );
      if (ev.length) await sb().from("opportunity_evidence").insert(ev);
    }
  }

  return report;
}
