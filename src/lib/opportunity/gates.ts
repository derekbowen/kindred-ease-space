/**
 * HARD GATES + SCORING.
 *
 * Two rules govern this file:
 *
 * 1. Thresholds are NEVER global constants. They come from the workspace's
 *    gate config, because marketplace verticals have different inventory
 *    economics — 3 listings is plenty for yacht charters and useless for
 *    parking spaces. Defaults below are deliberately conservative starting
 *    points, not universal truths.
 *
 * 2. The LLM does not decide. Every gate and every score component here is
 *    arithmetic over stored evidence. If a model could emit BUILD_NEW_PAGE the
 *    moat would be a prompt.
 */

export type GateConfig = {
  minListings: number;
  minProviders: number;
  maxInventoryAgeDays: number;
  minUniqueFacts: number;
  /** An existing page at or above this position already owns the intent. */
  ownedPositionThreshold: number;
  /** Intent-collision similarity at or above this blocks a new page. */
  collisionThreshold: number;
  /** Minimum GSC impressions for demand to count as measured. */
  minImpressions: number;
  /** Bands over the internal score. */
  highBand: number;
  mediumBand: number;
};

export const DEFAULT_GATE_CONFIG: GateConfig = {
  minListings: 3,
  minProviders: 2,
  maxInventoryAgeDays: 180,
  minUniqueFacts: 3,
  ownedPositionThreshold: 3,
  collisionThreshold: 0.75,
  minImpressions: 20,
  highBand: 55,
  mediumBand: 30,
};

export function resolveGateConfig(raw: unknown): GateConfig {
  const cfg = (raw && typeof raw === "object" ? raw : {}) as Partial<GateConfig>;
  const num = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? v : d);
  return {
    minListings: num(cfg.minListings, DEFAULT_GATE_CONFIG.minListings),
    minProviders: num(cfg.minProviders, DEFAULT_GATE_CONFIG.minProviders),
    maxInventoryAgeDays: num(cfg.maxInventoryAgeDays, DEFAULT_GATE_CONFIG.maxInventoryAgeDays),
    minUniqueFacts: num(cfg.minUniqueFacts, DEFAULT_GATE_CONFIG.minUniqueFacts),
    ownedPositionThreshold: num(cfg.ownedPositionThreshold, DEFAULT_GATE_CONFIG.ownedPositionThreshold),
    collisionThreshold: num(cfg.collisionThreshold, DEFAULT_GATE_CONFIG.collisionThreshold),
    minImpressions: num(cfg.minImpressions, DEFAULT_GATE_CONFIG.minImpressions),
    highBand: num(cfg.highBand, DEFAULT_GATE_CONFIG.highBand),
    mediumBand: num(cfg.mediumBand, DEFAULT_GATE_CONFIG.mediumBand),
  };
}

export type Recommendation =
  | "BUILD_NEW_PAGE"
  | "IMPROVE_EXISTING"
  | "WAIT_FOR_INVENTORY"
  | "DO_NOT_BUILD";

export type GateOutcome = {
  gate: string;
  passed: boolean;
  detail: string;
  /** Set when failing this gate dictates the recommendation. */
  forces?: Recommendation;
};

export type CandidateSignals = {
  /** GSC */
  impressions: number;
  clicks: number;
  bestPosition: number | null;
  queryCount: number;
  /** Whether an existing URL already ranks for this intent */
  rankingUrl: string | null;
  /** INVENTORY — distinct from site coverage */
  listingCount: number;
  providerCount: number;
  inventoryAgeDays: number | null;
  priceSpread: boolean;
  /** SITE_COVERAGE — the customer's existing site */
  hasSitePageForIntent: boolean;
  /** BUSINESS_COVERAGE — evidence the business serves this at all */
  businessServesCategory: boolean;
  /** Collision against existing tenant pages / scan pages / other candidates */
  collisionSimilarity: number;
  collisionReasons: string[];
  collisionRef: string | null;
  /** How many distinct facts a brief could be written from */
  uniqueFactCount: number;
};

export type Decision = {
  recommendation: Recommendation;
  band: "HIGH" | "MEDIUM" | "LOW" | null;
  score: number;
  confidence: "strong" | "moderate" | "weak";
  gates: GateOutcome[];
  breakdown: Record<string, number>;
  explanation: string[];
};

/**
 * IMPORTANT (correction #2): the absence of a page on the customer's site is
 * NOT evidence they don't serve that location — very often it is precisely why
 * the opportunity exists. Unsupported geography is concluded ONLY from missing
 * inventory AND missing business-coverage evidence, never from site coverage
 * alone.
 */
export function evaluate(sig: CandidateSignals, cfg: GateConfig): Decision {
  const gates: GateOutcome[] = [];
  const explanation: string[] = [];

  const hasMeasuredDemand = sig.impressions >= cfg.minImpressions;
  const hasInventory = sig.listingCount >= cfg.minListings && sig.providerCount >= cfg.minProviders;

  // ---- Gate: business coverage --------------------------------------------
  // Only fires when BOTH inventory and business evidence are absent.
  const unsupported = !sig.businessServesCategory && sig.listingCount === 0;
  gates.push({
    gate: "business_coverage",
    passed: !unsupported,
    detail: unsupported
      ? "No inventory and no sign this business offers this category"
      : "Business appears to serve this category",
    forces: unsupported ? "DO_NOT_BUILD" : undefined,
  });

  // ---- Gate: intent collision ---------------------------------------------
  const collides = sig.collisionSimilarity >= cfg.collisionThreshold;
  gates.push({
    gate: "intent_collision",
    passed: !collides,
    detail: collides
      ? `Overlaps an existing page (${sig.collisionReasons.join("; ") || "same intent"})`
      : "No existing page targets this intent",
    forces: collides ? "IMPROVE_EXISTING" : undefined,
  });

  // ---- Gate: already ranking well -----------------------------------------
  const alreadyOwned =
    sig.bestPosition !== null && sig.bestPosition <= cfg.ownedPositionThreshold && Boolean(sig.rankingUrl);
  gates.push({
    gate: "already_ranking",
    passed: !alreadyOwned,
    detail: alreadyOwned
      ? `An existing page already ranks #${Math.round(sig.bestPosition!)} for this intent`
      : "No page of yours owns these searches yet",
    forces: alreadyOwned ? "DO_NOT_BUILD" : undefined,
  });

  // ---- Gate: inventory support --------------------------------------------
  gates.push({
    gate: "inventory_support",
    passed: hasInventory,
    detail: hasInventory
      ? `${sig.listingCount} listings from ${sig.providerCount} providers`
      : `Only ${sig.listingCount} listings from ${sig.providerCount} providers (needs ${cfg.minListings}/${cfg.minProviders})`,
    forces: hasInventory ? undefined : "WAIT_FOR_INVENTORY",
  });

  // ---- Gate: inventory freshness ------------------------------------------
  const stale =
    sig.inventoryAgeDays !== null && sig.inventoryAgeDays > cfg.maxInventoryAgeDays;
  gates.push({
    gate: "inventory_freshness",
    passed: !stale,
    detail: stale
      ? `Newest listing is ${sig.inventoryAgeDays} days old`
      : "Inventory is current",
    forces: stale ? "WAIT_FOR_INVENTORY" : undefined,
  });

  // ---- Gate: enough to write about ----------------------------------------
  // This only forces DO_NOT_BUILD when inventory IS adequate — i.e. we have
  // supply and still have nothing distinctive to say, which is a genuinely
  // thin page. When inventory is the missing piece, the inventory gate owns
  // the verdict and WAIT_FOR_INVENTORY is the more useful, recoverable answer:
  // it tells the customer what would change our mind.
  const enoughFacts = sig.uniqueFactCount >= cfg.minUniqueFacts;
  gates.push({
    gate: "unique_data",
    passed: enoughFacts,
    detail: enoughFacts
      ? `${sig.uniqueFactCount} distinct facts available for the page`
      : `Only ${sig.uniqueFactCount} distinct facts — page would be thin`,
    forces: !enoughFacts && hasInventory ? "DO_NOT_BUILD" : undefined,
  });

  // ---- Gate: any evidence at all ------------------------------------------
  const anyEvidence = hasMeasuredDemand || sig.listingCount > 0;
  gates.push({
    gate: "sufficient_evidence",
    passed: anyEvidence,
    detail: anyEvidence ? "Backed by measured evidence" : "No demand or inventory evidence",
    forces: anyEvidence ? undefined : "DO_NOT_BUILD",
  });

  // ---- Resolve forced recommendation --------------------------------------
  // Precedence: DO_NOT_BUILD beats IMPROVE_EXISTING beats WAIT_FOR_INVENTORY.
  const failed = gates.filter((g) => !g.passed && g.forces);
  const order: Recommendation[] = ["DO_NOT_BUILD", "IMPROVE_EXISTING", "WAIT_FOR_INVENTORY"];
  let forced: Recommendation | null = null;
  for (const r of order) {
    if (failed.some((g) => g.forces === r)) {
      forced = r;
      break;
    }
  }

  // ---- Scoring (internal only) --------------------------------------------
  const breakdown: Record<string, number> = {};

  // Search demand 0-20, log-scaled so one huge term doesn't dominate.
  breakdown.search_demand = sig.impressions > 0
    ? Math.min(20, Math.round((Math.log10(sig.impressions + 1) / Math.log10(5000)) * 20))
    : 0;

  // Current Google signal 0-20 — position 5-30 is the sweet spot. Already top-3
  // scores low because there is nothing to win.
  if (sig.bestPosition === null) breakdown.google_signal = sig.impressions > 0 ? 6 : 0;
  else if (sig.bestPosition <= 3) breakdown.google_signal = 2;
  else if (sig.bestPosition <= 10) breakdown.google_signal = 20;
  else if (sig.bestPosition <= 30) breakdown.google_signal = 15;
  else breakdown.google_signal = 7;

  // Inventory fit 0-20
  let inv = 0;
  if (sig.listingCount >= cfg.minListings) inv += 8;
  if (sig.listingCount >= cfg.minListings * 4) inv += 4;
  if (sig.providerCount >= cfg.minProviders) inv += 4;
  if (sig.providerCount >= cfg.minProviders * 3) inv += 2;
  if (sig.priceSpread) inv += 2;
  breakdown.inventory_fit = Math.min(20, inv);

  // Coverage gap 0-15 — no page for real demand is the core opportunity.
  breakdown.coverage_gap = !sig.hasSitePageForIntent && (hasMeasuredDemand || hasInventory) ? 15 : 0;

  // Unique data 0-10
  breakdown.unique_data = Math.min(10, sig.uniqueFactCount * 2);

  // Penalties
  breakdown.cannibalization_risk = -Math.round(sig.collisionSimilarity * 15);
  breakdown.thin_risk = hasInventory ? 0 : -12;

  const score = Math.max(
    0,
    Object.values(breakdown).reduce((a, b) => a + b, 0),
  );

  // ---- Confidence — measured vs inferred ----------------------------------
  const measuredSignals = [hasMeasuredDemand, sig.listingCount > 0, sig.bestPosition !== null].filter(Boolean).length;
  const confidence: Decision["confidence"] =
    measuredSignals >= 3 ? "strong" : measuredSignals === 2 ? "moderate" : "weak";

  const recommendation: Recommendation = forced ?? "BUILD_NEW_PAGE";
  const band =
    recommendation !== "BUILD_NEW_PAGE"
      ? null
      : score >= cfg.highBand
        ? "HIGH"
        : score >= cfg.mediumBand
          ? "MEDIUM"
          : "LOW";

  // ---- Deterministic explanation (no LLM call in V1) ----------------------
  if (sig.impressions > 0) {
    explanation.push(
      `${sig.impressions.toLocaleString()} Google impressions across ${sig.queryCount} related ${sig.queryCount === 1 ? "search" : "searches"}`,
    );
  }
  if (sig.rankingUrl && sig.bestPosition !== null) {
    explanation.push(
      `These searches currently land on ${sig.rankingUrl} at position ${Math.round(sig.bestPosition)}`,
    );
  }
  if (sig.listingCount > 0) {
    explanation.push(
      `${sig.listingCount} matching active ${sig.listingCount === 1 ? "listing" : "listings"} from ${sig.providerCount} ${sig.providerCount === 1 ? "provider" : "providers"}`,
    );
  }
  if (!sig.hasSitePageForIntent) {
    explanation.push("No dedicated page for this intent exists on your site");
  }
  if (sig.collisionSimilarity > 0.4 && sig.collisionRef) {
    explanation.push(`Closest existing page: ${sig.collisionRef} (${sig.collisionReasons[0] ?? "related"})`);
  }
  for (const g of gates) {
    if (!g.passed) explanation.push(g.detail);
  }

  return { recommendation, band, score, confidence, gates, breakdown, explanation };
}
