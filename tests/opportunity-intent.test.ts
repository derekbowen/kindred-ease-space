import {
  canonicalTokens, categoryFromPhrase, normalizeGeo, buildIntentKey,
  detectCollision, slugForIntent, titleForIntent, normalizeCategory,
} from "../src/lib/opportunity/intent";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

console.log("\n=== THE CANONICAL CASE: differently-worded same intent ===");
const a = {
  categoryKey: categoryFromPhrase("pool rentals riverside", "Riverside", "CA"),
  geoKey: normalizeGeo("Riverside", "CA"),
  titleTokens: canonicalTokens("pool rentals riverside"),
};
const b = {
  categoryKey: categoryFromPhrase("rent a private pool in riverside", "Riverside", "CA"),
  geoKey: normalizeGeo("Riverside", "CA"),
  titleTokens: canonicalTokens("rent a private pool in riverside"),
};
console.log(`  a.category="${a.categoryKey}"  b.category="${b.categoryKey}"  geo="${a.geoKey}"`);
const c1 = detectCollision(a, b);
t("pool-rentals-riverside vs rent-a-private-pool-riverside COLLIDE",
  c1.collides, `sim=${c1.similarity.toFixed(2)} reasons=${c1.reasons.join("|")}`);

console.log("\n=== Different cities must NOT collide ===");
const c = { categoryKey: a.categoryKey, geoKey: normalizeGeo("Fresno", "CA"), titleTokens: canonicalTokens("pool rentals fresno") };
const c2 = detectCollision(a, c);
t("Riverside vs Fresno do NOT collide", !c2.collides, `sim=${c2.similarity.toFixed(2)}`);

console.log("\n=== Different categories, same city, must NOT collide ===");
const d = { categoryKey: categoryFromPhrase("boat rentals riverside", "Riverside", "CA"), geoKey: a.geoKey, titleTokens: canonicalTokens("boat rentals riverside") };
const c3 = detectCollision(a, d);
t("pool vs boat in same city do NOT collide", !c3.collides, `sim=${c3.similarity.toFixed(2)}`);

console.log("\n=== GSC query overlap forces collision even across wording ===");
const e = { categoryKey: "spa|rental", geoKey: "riverside-ca", titleTokens: canonicalTokens("spa hire riverside"),
  queries: ["pool rental riverside","private pool riverside","rent pool riverside","pool riverside ca"] };
const f = { categoryKey: "pool|rental", geoKey: "riverside-ca", titleTokens: canonicalTokens("pool rentals riverside"),
  queries: ["pool rental riverside","private pool riverside","rent pool riverside","swimming riverside"] };
const c4 = detectCollision(e, f);
t("high GSC query overlap forces collision", c4.collides, `sim=${c4.similarity.toFixed(2)}`);

console.log("\n=== Synonym folding ===");
t('"rentals"/"rent"/"hire" fold together',
  normalizeCategory("pool rentals") === normalizeCategory("pool hire"),
  `${normalizeCategory("pool rentals")} vs ${normalizeCategory("pool hire")}`);
t("state name and abbreviation normalize the same",
  normalizeGeo("Austin", "Texas") === normalizeGeo("Austin", "TX"),
  `${normalizeGeo("Austin","Texas")} vs ${normalizeGeo("Austin","TX")}`);

console.log("\n=== Slug / title generation ===");
console.log(`  slug:  ${slugForIntent("pool|rental", "Riverside", "CA")}`);
console.log(`  title: ${titleForIntent("pool|rental", "Riverside", "CA")}`);
t("intent keys are stable", buildIntentKey("pool|rental","riverside-ca") === "pool|rental::riverside-ca");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
