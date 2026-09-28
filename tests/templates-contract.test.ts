/**
 * THE THREE TEMPLATE CONTRACTS. Run: bun tests/templates-contract.test.ts
 *
 * src/lib/templates/contracts.ts is what the server enforces; migration
 * 20260929000100 stores the same JSON in page_templates.config_schema. They
 * must never drift. Plus the filter rules each template enforces before any
 * AI call: a City Hub names its whole place, a Category Page names its
 * category, a Resource Article needs neither.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATE_CONTRACTS, checkFilterForTemplate, contractJson } from "../src/lib/templates/contracts";
import { listingKeys, makeFilter, scopeFor } from "../src/lib/coverage/target";

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

const sql = readFileSync(join(import.meta.dir, "..", "supabase/migrations/20260929000100_mvp_targets_sync_templates.sql"), "utf8");

console.log("\n1. The migration stores exactly the enforced contracts");
for (const kind of Object.keys(TEMPLATE_CONTRACTS) as Array<keyof typeof TEMPLATE_CONTRACTS>) {
  const re = new RegExp(`config_schema = '(\\{[^']*"kind":"${kind}"[^']*\\})'::jsonb\\s*WHERE slug = '${kind}'`);
  const m = sql.match(re);
  const stored = m ? JSON.parse(m[1]!) : null;
  t(`${kind}: config_schema equals contractJson()`, stored !== null && JSON.stringify(stored) === JSON.stringify(contractJson(kind)), JSON.stringify(stored));
  t(`${kind}: the migration makes it active`, new RegExp(`is_active = true,[\\s\\S]*?WHERE slug = '${kind}'`).test(sql));
}
t("exactly three templates are offered", Object.keys(TEMPLATE_CONTRACTS).join(",") === "city_hub,category_page,resource_article");

console.log("\n2. What each template accepts before any AI call");
const austin = listingKeys({ country: "US", state: "TX", city: "Austin", category: "Pool" });
t("a City Hub with the whole place passes", checkFilterForTemplate("city_hub", makeFilter(scopeFor("city_hub", false), austin)).length === 0);
t("a City Hub without a city is refused", checkFilterForTemplate("city_hub", makeFilter(["category"], austin)).some((p) => p.code === "missing_city"));
t("a City Hub naming only the city (no region/country) is refused", checkFilterForTemplate("city_hub", makeFilter(["city"], austin)).some((p) => p.code === "missing_region" || p.code === "missing_country"));
t("a City Hub for listings with no city is refused", checkFilterForTemplate("city_hub", makeFilter(scopeFor("city_hub", false), listingKeys({ country: "US", state: "TX" }))).some((p) => p.code === "city_unknown"));
t("a Category Page with its category passes", checkFilterForTemplate("category_page", makeFilter(["category"], austin)).length === 0);
t("a Category Page narrowed to a whole place passes", checkFilterForTemplate("category_page", makeFilter(["country", "region", "city", "category"], austin)).length === 0);
t("a Category Page narrowed to a bare city is refused (ambiguous place)", checkFilterForTemplate("category_page", makeFilter(["city", "category"], austin)).some((p) => p.code === "partial_place"));
t("a Category Page without a category is refused", checkFilterForTemplate("category_page", makeFilter(scopeFor("city_hub", false), austin)).some((p) => p.code === "missing_category"));
t("a Resource Article needs no inventory filter", checkFilterForTemplate("resource_article", makeFilter([], austin)).length === 0);
t("a broken stored filter is refused, never guessed", checkFilterForTemplate("city_hub", { v: 2, scope: ["city"] }).some((p) => p.code === "filter_invalid"));
t("a legacy (v1) City Hub filter must be re-picked before publishing", checkFilterForTemplate("city_hub", { city: "Austin", state: "TX" }).some((p) => p.code === "missing_country"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
