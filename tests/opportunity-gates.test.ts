import { evaluate, DEFAULT_GATE_CONFIG, resolveGateConfig, type CandidateSignals } from "../src/lib/opportunity/gates";

const base: CandidateSignals = {
  impressions: 0, clicks: 0, bestPosition: null, queryCount: 0, rankingUrl: null,
  listingCount: 0, providerCount: 0, inventoryAgeDays: 10, priceSpread: false,
  hasSitePageForIntent: false, businessServesCategory: true,
  collisionSimilarity: 0, collisionReasons: [], collisionRef: null, uniqueFactCount: 0,
};
const cfg = DEFAULT_GATE_CONFIG;
let pass = 0, fail = 0;
function t(name: string, got: string, want: string) {
  if (got === want) { pass++; console.log(`  PASS  ${name.padEnd(46)} -> ${got}`); }
  else { fail++; console.log(`  FAIL  ${name.padEnd(46)} -> got ${got}, want ${want}`); }
}

console.log("\n=== Riverside: demand + supply + no page (the money case) ===");
const riverside = evaluate({ ...base, impressions: 340, queryCount: 12, bestPosition: 14,
  rankingUrl: "/", listingCount: 14, providerCount: 9, priceSpread: true, uniqueFactCount: 6 }, cfg);
t("strong demand + strong supply", riverside.recommendation, "BUILD_NEW_PAGE");
console.log(`        band=${riverside.band} score=${riverside.score} confidence=${riverside.confidence}`);
console.log(`        why: ${riverside.explanation.slice(0,4).join(" | ")}`);

console.log("\n=== Boise: a city with no inventory (must NOT build) ===");
const boise = evaluate({ ...base, impressions: 210, queryCount: 5, listingCount: 0,
  providerCount: 0, uniqueFactCount: 0, businessServesCategory: true }, cfg);
t("demand but zero inventory", boise.recommendation, "WAIT_FOR_INVENTORY");

console.log("\n=== Fresno: one listing only (thin) ===");
const fresno = evaluate({ ...base, impressions: 90, queryCount: 3, listingCount: 1,
  providerCount: 1, uniqueFactCount: 1 }, cfg);
t("single listing is not enough", fresno.recommendation, "WAIT_FOR_INVENTORY");

console.log("\n=== Already ranking #2 (nothing to win) ===");
const owned = evaluate({ ...base, impressions: 900, queryCount: 20, bestPosition: 2,
  rankingUrl: "/a/pool-rentals-la", listingCount: 30, providerCount: 12, uniqueFactCount: 6 }, cfg);
t("existing page already ranks top-3", owned.recommendation, "DO_NOT_BUILD");

console.log("\n=== Cannibalization: near-identical existing page ===");
const cannibal = evaluate({ ...base, impressions: 300, queryCount: 8, bestPosition: 12,
  listingCount: 20, providerCount: 8, uniqueFactCount: 5,
  collisionSimilarity: 0.95, collisionReasons: ["same location and same category"],
  collisionRef: "/a/pool-rentals-riverside" }, cfg);
t("collides with existing page", cannibal.recommendation, "IMPROVE_EXISTING");

console.log("\n=== Category the business does not offer ===");
const unrelated = evaluate({ ...base, impressions: 500, queryCount: 9, listingCount: 0,
  providerCount: 0, businessServesCategory: false, uniqueFactCount: 0 }, cfg);
t("no inventory AND no business evidence", unrelated.recommendation, "DO_NOT_BUILD");

console.log("\n=== CORRECTION #2: missing site page is NOT unsupported geography ===");
const gap = evaluate({ ...base, impressions: 260, queryCount: 7, bestPosition: 18,
  listingCount: 11, providerCount: 5, priceSpread: true, uniqueFactCount: 5,
  hasSitePageForIntent: false, businessServesCategory: true }, cfg);
t("no page + real inventory = opportunity", gap.recommendation, "BUILD_NEW_PAGE");

console.log("\n=== CORRECTION #1: thresholds are configurable per vertical ===");
const yacht = resolveGateConfig({ minListings: 1, minProviders: 1 });
const yachtDecision = evaluate({ ...base, impressions: 120, queryCount: 4, bestPosition: 16,
  listingCount: 1, providerCount: 1, uniqueFactCount: 3, priceSpread: false }, yacht);
t("1 listing passes for a low-supply vertical", yachtDecision.recommendation, "BUILD_NEW_PAGE");
const strict = resolveGateConfig({ minListings: 25, minProviders: 10 });
const strictDecision = evaluate({ ...base, impressions: 340, queryCount: 12, bestPosition: 14,
  listingCount: 14, providerCount: 9, uniqueFactCount: 6 }, strict);
t("same candidate fails a high-supply vertical", strictDecision.recommendation, "WAIT_FOR_INVENTORY");

console.log("\n=== No evidence at all ===");
t("empty candidate", evaluate({ ...base, businessServesCategory: false }, cfg).recommendation, "DO_NOT_BUILD");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
