import {
  resolveRouteConfig, buildListingUrl, buildSearchUrl, buildProviderUrl,
  inventoryHealth, SHARETRIBE_DEFAULT_ROUTES,
} from "../src/lib/marketplace/adapter";
let p=0,f=0; const t=(n:string,c:boolean,x="")=>{ if (c) { p++; console.log("  PASS  "+n); } else { f++; console.log("  FAIL  "+n+"  "+x); } };

console.log("\n=== Default profile reproduces today's behaviour ===");
const def = resolveRouteConfig("https://www.example.com/", {});
t("listing URL matches the previous hard-coded shape",
  buildListingUrl(def,{sharetribe_listing_id:"abc123",slug:"nice-pool"}) === "https://www.example.com/l/nice-pool/abc123",
  String(buildListingUrl(def,{sharetribe_listing_id:"abc123",slug:"nice-pool"})));
t("trailing slash on base is normalized", def.baseUrl === "https://www.example.com");
t("missing slug falls back", buildListingUrl(def,{sharetribe_listing_id:"x1"})?.includes("/l/listing/x1") === true);

console.log("\n=== Customised marketplace (the P0-2 case) ===");
const custom = resolveRouteConfig("https://hunt.example.com", {
  listingRouteTemplate: "/hunts/{id}", searchPath: "/browse",
  searchParams: { location: "where", category: "type" },
  supportedFilters: ["location","category"], providerRouteTemplate: undefined,
});
t("custom listing route honoured",
  buildListingUrl(custom,{sharetribe_listing_id:"h9",slug:"ignored"}) === "https://hunt.example.com/hunts/h9",
  String(buildListingUrl(custom,{sharetribe_listing_id:"h9"})));
t("custom search route + param names",
  buildSearchUrl(custom,{location:"Texas",category:"whitetail"}) === "https://hunt.example.com/browse?where=Texas&type=whitetail",
  String(buildSearchUrl(custom,{location:"Texas",category:"whitetail"})));

console.log("\n=== Unsupported filters are OMITTED, never fabricated ===");
const noCat = resolveRouteConfig("https://x.com", { supportedFilters:["location"], searchParams:{location:"address"} });
const u = buildSearchUrl(noCat,{location:"Riverside",category:"pool-rental",keywords:"heated"});
t("category dropped when unsupported", !!u && !u.includes("pool-rental"), String(u));
t("keywords dropped when unsupported", !!u && !u.includes("heated"), String(u));
t("supported filter still present", !!u && u.includes("address=Riverside"), String(u));

console.log("\n=== Provider URLs ===");
t("default provider route", buildProviderUrl(def,"u42") === "https://www.example.com/u/u42");
t("omitted when marketplace has none", buildProviderUrl(custom,"u42") === null);

console.log("\n=== Inventory degradation (Sharetribe outage must not 500) ===");
const now = Date.parse("2026-08-30T12:00:00Z");
t("fresh sync = OK", inventoryHealth("2026-08-30T11:00:00Z","success",now).health === "OK");
t("30h = WARNING, stats still shown", (()=>{const r=inventoryHealth("2026-08-29T06:00:00Z","success",now); return r.health==="WARNING"&&r.showStats;})());
t("4 days = DEGRADED, stats hidden", (()=>{const r=inventoryHealth("2026-08-26T12:00:00Z","success",now); return r.health==="DEGRADED"&&!r.showStats;})());
t("failed sync = DEGRADED even if recent", inventoryHealth("2026-08-30T11:00:00Z","error",now).health === "DEGRADED");
t("never synced = UNKNOWN", inventoryHealth(null,null,now).health === "UNKNOWN");

console.log("\n=== The statuses the sync records: success | partial | warning | failed ===");
t("failed (what the sync writes) = DEGRADED even if recent", inventoryHealth("2026-08-30T11:00:00Z","failed",now,"2026-08-30T10:00:00Z").health === "DEGRADED");
t("partial = WARNING: nothing was removed, closed listings may still count", inventoryHealth("2026-08-30T11:00:00Z","partial",now,"2026-08-30T10:00:00Z").health === "WARNING");
t("warning (an empty-catalogue strike) = WARNING", inventoryHealth("2026-08-30T11:00:00Z","warning",now,"2026-08-30T10:00:00Z").health === "WARNING");
t("age runs from last_success_at: a fresh partial on a 4-day-old snapshot = DEGRADED", (()=>{const r=inventoryHealth("2026-08-30T11:00:00Z","partial",now,"2026-08-26T12:00:00Z"); return r.health==="DEGRADED"&&!r.showStats&&Math.round(r.ageHours!)===96;})());
t("no complete snapshot on record (last_success_at null) = DEGRADED", inventoryHealth("2026-08-30T11:00:00Z","partial",now,null).health === "DEGRADED");
t("a recent complete snapshot = OK", inventoryHealth("2026-08-30T11:00:00Z","success",now,"2026-08-30T11:00:00Z").health === "OK");
t("callers that don't read last_success_at: a 'success' last_sync_at stands in", inventoryHealth("2026-08-30T11:00:00Z","success",now).health === "OK");
t("…but a 'partial' last_sync_at is not taken as a complete snapshot", inventoryHealth("2026-08-30T11:00:00Z","partial",now).health === "DEGRADED");

console.log(`\n${p} passed, ${f} failed\n`); process.exit(f?1:0);
