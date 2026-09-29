/**
 * THE ONE PAGE TARGET. Run: bun tests/coverage-target.test.ts
 *
 * Every step that decides which listings a page is about goes through
 * src/lib/coverage/target.ts. These are the correctness cases the MVP brief
 * names: the same city in different regions and countries, category
 * isolation, missing location fields made explicit, legacy pages kept safe,
 * and the one translation to SQL.
 */
import {
  applyFilter,
  categoryKeyOf,
  cityKeyOf,
  countryKeyOf,
  listingKeys,
  listingMatches,
  makeFilter,
  pageCoversTarget,
  regionKeyOf,
  resolveFilter,
  scopeFor,
  slugForTarget,
  targetKey,
  type ResolvedFilter,
} from "../src/lib/coverage/target";

let pass = 0,
  fail = 0;
const failed: string[] = [];
function t(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failed.push(name);
    console.log(`  FAIL  ${name}  ${extra}`);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log("\n1. Keys");
t("country names and codes fold to ISO-2", countryKeyOf("United States") === "us" && countryKeyOf("USA") === "us" && countryKeyOf(" us ") === "us" && countryKeyOf("United Kingdom") === "gb");
t("an unknown country keeps its own key, never guessed", countryKeyOf("Ruritania") === "ruritania");
t("US state names fold to postal codes", regionKeyOf("Texas", "us") === "tx" && regionKeyOf("TX", "us") === "tx" && regionKeyOf("new york", null) === "ny");
t("Georgia the country's region is not the US state", regionKeyOf("Georgia", "ge") === "georgia" && regionKeyOf("Georgia", "us") === "ga");
t("a non-US region keeps its text key", regionKeyOf("Ontario", "ca") === "ontario" && regionKeyOf("ON", "ca") === "on");
t("city keys fold case, accents and punctuation", cityKeyOf(" St. Louis ") === "st-louis" && cityKeyOf("Zürich") === "zurich" && cityKeyOf("SAN  JOSÉ") === "san-jose");
t("category keys stay exact (no synonym folding)", categoryKeyOf("Pool") === "pool" && categoryKeyOf("Swimming") === "swimming" && categoryKeyOf("Pool") !== categoryKeyOf("Swimming"));
t("empty or whitespace is null, never ''", countryKeyOf("  ") === null && cityKeyOf(null) === null && categoryKeyOf(undefined) === null);
t("listingKeys uses the listing's own country for its region", eq(listingKeys({ country: "US", state: "Oregon", city: "Portland", category: "Pool" }), { countryKey: "us", regionKey: "or", cityKey: "portland", categoryKey: "pool" }));
{
  // Non-Latin names key by their own letters (they used to get no key, so
  // such a marketplace had no opportunities at all); ASCII keys never change.
  t("東京, Москва and Αθήνα get keys", cityKeyOf("東京") === "東京" && cityKeyOf("Москва") === "москва" && cityKeyOf("Αθήνα") === "αθήνα");
  t("different non-Latin cities never share a key", cityKeyOf("東京") !== cityKeyOf("大阪") && cityKeyOf("Москва") !== cityKeyOf("Казань"));
  t("a non-Latin name with a number keeps its letters (not a bare '2')", cityKeyOf("Москва 2") === "москва-2");
  t("Latin keys are unchanged by the fallback", cityKeyOf("Tromsø") === "troms" && cityKeyOf("São Paulo") === "sao-paulo" && cityKeyOf("Zürich") === "zurich");
  const k = listingKeys({ country: "Japan", state: "東京都", city: "東京", category: "プール" });
  t("a Japanese listing gets all four keys", k.countryKey === "jp" && k.regionKey === "東京都" && k.cityKey === "東京" && k.categoryKey === "プール");
  const hub = slugForTarget("city_hub", { country: "Japan", region: "東京都", city: "東京", category: null }, { ...k, categoryKey: null });
  const hub2 = slugForTarget("city_hub", { country: "Japan", region: "大阪府", city: "大阪", category: null }, listingKeys({ country: "Japan", state: "大阪府", city: "大阪" }));
  t("its slug is ASCII, stable and carries the place's identity", /^[a-z0-9-]+$/.test(hub) && hub.endsWith("-jp") && hub !== hub2 && hub === slugForTarget("city_hub", { country: "Japan", region: "東京都", city: "東京", category: null }, { ...k, categoryKey: null }), `${hub} ${hub2}`);
  const cat = slugForTarget("category_page", { country: null, region: null, city: null, category: "プール" }, listingKeys({ category: "プール" }));
  t("a non-Latin category slug is ASCII too", /^[a-z0-9-]+$/.test(cat) && cat.length > 1, cat);
}

console.log("\n2. Same city name, different regions and countries");
const portlandOR = listingKeys({ country: "US", state: "OR", city: "Portland" });
const portlandME = listingKeys({ country: "US", state: "Maine", city: "Portland" });
const springfieldGB = listingKeys({ country: "UK", state: null, city: "Springfield" });
const springfieldIL = listingKeys({ country: "US", state: "IL", city: "Springfield" });
const hubOR = resolveFilter(makeFilter(scopeFor("city_hub", false), portlandOR, { city: "Portland", region: "OR", country: "US" }))!;
t("Portland, OR's page takes Portland, OR listings", listingMatches(portlandOR, hubOR));
t("…and never Portland, ME's", !listingMatches(portlandME, hubOR));
const hubIL = resolveFilter(makeFilter(scopeFor("city_hub", false), springfieldIL))!;
t("Springfield, IL, US never takes Springfield in the UK", listingMatches(springfieldIL, hubIL) && !listingMatches(springfieldGB, hubIL));
t("the two Portlands are two targets", targetKey("city_hub", hubOR) !== targetKey("city_hub", resolveFilter(makeFilter(scopeFor("city_hub", false), portlandME))!));
t("slugs carry the region, so they never collide into -2", slugForTarget("city_hub", { city: "Portland", region: "OR", country: "US", category: null }, portlandOR) === "portland-or" && slugForTarget("city_hub", { city: "Portland", region: "ME", country: "US", category: null }, portlandME) === "portland-me");
t("a non-US slug carries the country", slugForTarget("city_hub", { city: "Springfield", region: null, country: "UK", category: null }, springfieldGB) === "springfield-gb");

console.log("\n3. Missing location fields are explicit");
const noRegion = listingKeys({ country: "US", state: "", city: "Portland" });
const hubNoRegion = resolveFilter(makeFilter(scopeFor("city_hub", false), noRegion))!;
t("a target with no region takes only listings with no region", listingMatches(noRegion, hubNoRegion) && !listingMatches(portlandOR, hubNoRegion));
t("…and Portland, OR's page does not take them", !listingMatches(noRegion, hubOR));
t("a missing field shows in the key as '-'", targetKey("city_hub", hubNoRegion) === "city_hub::country=us|region=-|city=portland");

console.log("\n4. Category isolation");
const poolAustin = listingKeys({ country: "US", state: "TX", city: "Austin", category: "Pool" });
const spaAustin = listingKeys({ country: "US", state: "TX", city: "Austin", category: "Hot tub" });
const catPool = resolveFilter(makeFilter(scopeFor("category_page", false), poolAustin, { category: "Pool" }))!;
t("a category page takes its category anywhere", listingMatches(poolAustin, catPool) && listingMatches(listingKeys({ country: "US", state: "OR", city: "Portland", category: "pool" }), catPool));
t("…and never another category", !listingMatches(spaAustin, catPool));
t("a listing with no category is on no category page", !listingMatches(listingKeys({ city: "Austin" }), catPool));
const hubAustinAll = resolveFilter(makeFilter(scopeFor("city_hub", false), poolAustin))!;
t("a city hub without a category takes every category in the city", listingMatches(poolAustin, hubAustinAll) && listingMatches(spaAustin, hubAustinAll));
const hubAustinPool = resolveFilter(makeFilter(scopeFor("city_hub", true), poolAustin))!;
t("a city hub narrowed to a category takes only it", listingMatches(poolAustin, hubAustinPool) && !listingMatches(spaAustin, hubAustinPool));

console.log("\n5. Coverage");
const target = { kind: "city_hub" as const, filter: hubOR };
t("the same v2 target is covered", pageCoversTarget({ kind: "city_hub", filter: hubOR }, target));
t("another region's page does not cover it", !pageCoversTarget({ kind: "city_hub", filter: resolveFilter(makeFilter(scopeFor("city_hub", false), portlandME))! }, target));
t("a category page never covers a city hub", !pageCoversTarget({ kind: "category_page", filter: catPool }, { kind: "city_hub", filter: hubAustinAll }));
t("a narrower page (city + category) does not cover the whole city", !pageCoversTarget({ kind: "city_hub", filter: hubAustinPool }, { kind: "city_hub", filter: hubAustinAll }));
const legacyNoState = resolveFilter({ city: "Portland", limit: 24, sort: "newest" })!;
t("a legacy page with no state still covers the city in any region (never duplicated)", pageCoversTarget({ kind: "city_hub", filter: legacyNoState }, target) && pageCoversTarget({ kind: "city_hub", filter: legacyNoState }, { kind: "city_hub", filter: resolveFilter(makeFilter(scopeFor("city_hub", false), portlandME))! }));
const legacyWithState = resolveFilter({ city: "Portland", state: "Oregon" })!;
t("a legacy page with a state covers only that state", pageCoversTarget({ kind: "city_hub", filter: legacyWithState }, target) && !pageCoversTarget({ kind: "city_hub", filter: legacyWithState }, { kind: "city_hub", filter: resolveFilter(makeFilter(scopeFor("city_hub", false), portlandME))! }));
t("a resource article is never inventory coverage", !pageCoversTarget({ kind: "resource_article", filter: hubOR }, { kind: "resource_article", filter: hubOR }) && targetKey("resource_article", hubOR) === null);

console.log("\n6. Stored filters");
t("a v2 filter round-trips", eq(resolveFilter(makeFilter(["city"], portlandOR, { city: "Portland" }))?.constraints, { city: "portland" }));
t("an invalid v2 filter is refused, not guessed", resolveFilter({ v: 2, scope: ["city"], cityKey: "x" }) === null && resolveFilter({ ...makeFilter(["city"], portlandOR), extra: 1 }) === null);
t("an unknown version is refused", resolveFilter({ v: 3 }) === null && resolveFilter("city=austin") === null && resolveFilter(null) === null);
t("a repeated scope field is refused", resolveFilter({ ...makeFilter(["city"], portlandOR), scope: ["city", "city"] }) === null);
t("the listing limit is bounded", resolveFilter({ city: "x", limit: 5000 })!.limit === 60 && makeFilter(["city"], portlandOR, {}, 0).limit === 1);
t("legacy v1 keeps each present field as a constraint", eq(resolveFilter({ city: "Austin", state: "Texas", category: "Pool", limit: 24, sort: "newest" })!.constraints, { city: "austin", region: "tx", category: "pool" }));

console.log("\n7. The one translation to SQL");
type Call = [string, string, string | null];
function recorder() {
  const calls: Call[] = [];
  const q: any = {
    eq(c: string, v: string) { calls.push(["eq", c, v]); return q; },
    is(c: string, v: null) { calls.push(["is", c, v]); return q; },
  };
  return { q, calls };
}
{
  const { q, calls } = recorder();
  applyFilter(q, hubNoRegion);
  t("scoped keys become eq, a missing value becomes IS NULL", eq(calls, [["eq", "country_key", "us"], ["is", "region_key", null], ["eq", "city_key", "portland"]]), JSON.stringify(calls));
}
{
  const { q, calls } = recorder();
  applyFilter(q, catPool);
  t("an unscoped field adds nothing", eq(calls, [["eq", "category_key", "pool"]]), JSON.stringify(calls));
}
{
  const { q, calls } = recorder();
  const f: ResolvedFilter = { version: 2, constraints: {}, labels: { country: null, region: null, city: null, category: null }, limit: 24 };
  applyFilter(q, f);
  t("an empty scope adds nothing (a resource article's related listings)", calls.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
