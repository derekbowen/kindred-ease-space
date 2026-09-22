// Offline checks for the least-privilege Sharetribe connection and the
// bounded scheduled sync. No network: fetch is stubbed where a request would
// be made, and nothing here touches Supabase.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  friendlySharetribeError,
  buildTokenRequest,
  buildMarketplaceShowUrl,
  buildListingsQueryUrl,
  mapListing,
  selectWorkspacesForBoundedSync,
  validateSharetribeCredentials,
  SharetribeApiError,
  SHARETRIBE_UNAVAILABLE_MESSAGE,
  SYNC_ALL_BATCH_LIMIT,
} from "../src/lib/sharetribe-sync.server";

let p = 0, f = 0;
const t = (n: string, c: boolean, x = "") => { if (c) { p++; console.log("  PASS  " + n); } else { f++; console.log("  FAIL  " + n + "  " + x); } };

console.log("\n=== Friendly error mapping (raw codes never reach the customer) ===");
const auth400 = new SharetribeApiError("auth", "auth_failed:400:Bad request", 400);
const mpMsg = friendlySharetribeError(auth400, "marketplace");
t("marketplace 400 → Client ID guidance", mpMsg.includes("Client ID") && mpMsg.includes("Marketplace API"), mpMsg);
t("marketplace 400 does not mention a Secret", !mpMsg.includes("Secret"), mpMsg);
const intMsg = friendlySharetribeError(new SharetribeApiError("auth", "auth_failed:401:x", 401), "integration");
t("integration 401 → Client ID + Secret guidance", intMsg.includes("Client ID") && intMsg.includes("Secret") && intMsg.includes("Integration API"), intMsg);
t("network failure → not answering", friendlySharetribeError(new SharetribeApiError("network", "network_failure:ECONNRESET"), "marketplace") === SHARETRIBE_UNAVAILABLE_MESSAGE);
t("503 from token endpoint → not answering", friendlySharetribeError(new SharetribeApiError("api", "auth_failed:503:", 503), "marketplace") === SHARETRIBE_UNAVAILABLE_MESSAGE);
t("502 from listings query → not answering", friendlySharetribeError(new SharetribeApiError("api", "listings_query_failed:502:", 502), "integration") === SHARETRIBE_UNAVAILABLE_MESSAGE);
const all = [
  friendlySharetribeError(auth400, "marketplace"),
  friendlySharetribeError(new SharetribeApiError("api", "marketplace_show_failed:403", 403), "marketplace"),
  friendlySharetribeError(new SharetribeApiError("api", "listings_query_failed:418:teapot", 418), "integration"),
  friendlySharetribeError(new Error("secret_decrypt_failed:missing"), "integration"),
  friendlySharetribeError(new Error("upsert_failed:duplicate key"), "marketplace"),
  friendlySharetribeError(new Error("integration_not_found"), "marketplace"),
  friendlySharetribeError("weird", "marketplace"),
  friendlySharetribeError(undefined, "integration"),
];
t("no message contains a raw auth_failed/upsert_failed/… code", all.every((m) => !/auth_failed|listings_query_failed|marketplace_show_failed|secret_decrypt_failed|upsert_failed|Bad request/.test(m)), all.join(" | "));
t("every message is a full sentence", all.every((m) => m.length > 20 && /[.!]$/.test(m)), all.join(" | "));

console.log("\n=== Request builders: right API, right scope, no secret in marketplace mode ===");
const mpTok = buildTokenRequest("marketplace", "client-abc");
t("marketplace token endpoint", mpTok.url === "https://flex-api.sharetribe.com/v1/auth/token", mpTok.url);
t("marketplace scope public-read", mpTok.body.get("scope") === "public-read" && mpTok.body.get("grant_type") === "client_credentials" && mpTok.body.get("client_id") === "client-abc");
t("marketplace never sends client_secret", !mpTok.body.has("client_secret"));
const mpTokIgnoresSecret = buildTokenRequest("marketplace", "client-abc", "should-be-ignored");
t("a stray secret is dropped in marketplace mode", !mpTokIgnoresSecret.body.toString().includes("should-be-ignored"));
const intTok = buildTokenRequest("integration", "client-abc", "s3cr3t");
t("integration token endpoint", intTok.url === "https://flex-integ-api.sharetribe.com/v1/auth/token", intTok.url);
t("integration scope integ + secret", intTok.body.get("scope") === "integ" && intTok.body.get("client_secret") === "s3cr3t");
t("integration without secret refuses to build", (() => { try { buildTokenRequest("integration", "client-abc"); return false; } catch (e) { return e instanceof SharetribeApiError && e.kind === "auth"; } })());
t("marketplace show URL", buildMarketplaceShowUrl("marketplace") === "https://flex-api.sharetribe.com/v1/api/marketplace/show");
t("integration show URL", buildMarketplaceShowUrl("integration") === "https://flex-integ-api.sharetribe.com/v1/integration_api/marketplace/show");
const mpQ = new URL(buildListingsQueryUrl("marketplace", 2));
t("marketplace listings query base", mpQ.origin + mpQ.pathname === "https://flex-api.sharetribe.com/v1/api/listings/query", mpQ.href);
t("marketplace listings query params", mpQ.searchParams.get("per_page") === "100" && mpQ.searchParams.get("page") === "2" && mpQ.searchParams.get("include") === "author,images", mpQ.href);
t("marketplace listings request the preferred image variants", (mpQ.searchParams.get("fields.image") ?? "") === "variants.square-small2x,variants.scaled-large,variants.default", mpQ.href);
t("marketplace listings query has no states filter (API is published-only)", !mpQ.searchParams.has("states"));
const intQ = new URL(buildListingsQueryUrl("integration", 1));
t("integration listings query base", intQ.origin + intQ.pathname === "https://flex-integ-api.sharetribe.com/v1/integration_api/listings/query", intQ.href);
t("integration listings query only asks for published listings", intQ.searchParams.get("states") === "published", intQ.href);
t("integration listings query keeps includes", intQ.searchParams.get("include") === "author,images" && intQ.searchParams.get("per_page") === "100");

console.log("\n=== mapListing on a Marketplace-API-shaped listing ===");
const listingId = "7a0d2d6e-4c3c-4b7a-9f0e-3c1c0e5a1b22";
const authorId = "0d7a3f4e-1111-4a2b-8c3d-9e0f1a2b3c4d";
const raw = {
  id: { uuid: listingId },
  type: "listing",
  attributes: {
    title: "Heated Backyard Pool — Austin",
    description: "Lovely pool",
    price: { amount: 4500, currency: "USD" },
    geolocation: { lat: 30.27, lng: -97.74 },
    publicData: { city: "Austin", state: "TX", country: "US", category: "pool" },
    metadata: { featured: true },
    // Marketplace API responses carry no `state`; privateData must never be stored.
    privateData: { ownerPhone: "555-0100", SECRET_MARKER: "do-not-store" },
  },
  relationships: {
    author: { data: { id: { uuid: authorId }, type: "user" } },
    images: { data: [{ id: { uuid: "img-1" }, type: "image" }, { id: { uuid: "img-2" }, type: "image" }] },
  },
};
const included = [
  { id: { uuid: authorId }, type: "user", attributes: { profile: { displayName: "Dana P" } } },
  { id: { uuid: "img-1" }, type: "image", attributes: { variants: { "scaled-large": { url: "https://cdn/x-large.jpg", width: 1024, height: 768 }, "square-small2x": { url: "https://cdn/x-sq2x.jpg", width: 480, height: 480 } } } },
  { id: { uuid: "img-2" }, type: "image", attributes: { variants: { default: { url: "https://cdn/y-default.jpg", width: 800, height: 600 } } } },
];
const row = mapListing("ws-1", "https://pools.example.com/", raw, included, { mode: "marketplace" });
t("published by default in marketplace mode (no state attribute)", row.state_published === true);
t("listing id + workspace", row.sharetribe_listing_id === listingId && row.workspace_id === "ws-1");
t("square-small2x preferred over scaled-large", row.images[0]?.url === "https://cdn/x-sq2x.jpg", JSON.stringify(row.images));
t("falls back to default variant", row.images[1]?.url === "https://cdn/y-default.jpg", JSON.stringify(row.images));
t("author resolved from included", row.author_id === authorId && row.author_name === "Dana P");
t("price, geo and location mapped", row.price_amount === 4500 && row.price_currency === "USD" && row.lat === 30.27 && row.city === "Austin" && row.state === "TX");
t("listing URL built from marketplace base", row.marketplace_url === `https://pools.example.com/l/heated-backyard-pool-austin/${listingId}`, row.marketplace_url);
const serialized = JSON.stringify(row);
t("privateData is not stored anywhere on the row", !serialized.includes("SECRET_MARKER") && !serialized.includes("555-0100") && !serialized.includes("privateData"));
t("publicData + metadata kept in custom_fields", row.custom_fields.publicData.category === "pool" && row.custom_fields.metadata.featured === true);
const closedRow = mapListing("ws-1", "https://pools.example.com", { ...raw, attributes: { ...raw.attributes, state: "closed" } }, included, { mode: "integration" });
t("integration mode still maps state → state_published", closedRow.state_published === false);
const pubRow = mapListing("ws-1", "https://pools.example.com", { ...raw, attributes: { ...raw.attributes, state: "published" } }, included);
t("default (legacy) call behaves like integration mode", pubRow.state_published === true);

console.log("\n=== Bounded 'all' selection: max 3, never-synced first, then oldest ===");
t("default batch limit is 3", SYNC_ALL_BATCH_LIMIT === 3);
const fleet = [
  { workspace_id: "w-recent", last_sync_at: "2026-09-22T10:00:00Z" },
  { workspace_id: "w-old", last_sync_at: "2026-09-20T10:00:00Z" },
  { workspace_id: "w-never", last_sync_at: null },
  { workspace_id: "w-older", last_sync_at: "2026-09-19T10:00:00Z" },
  { workspace_id: "w-mid", last_sync_at: "2026-09-21T10:00:00Z" },
  { workspace_id: "w-never-2", last_sync_at: null },
];
const picked = selectWorkspacesForBoundedSync(fleet).map((r) => r.workspace_id);
t("picks exactly 3 of 6", picked.length === 3, picked.join(","));
t("never-synced workspaces go first", picked.slice(0, 2).sort().join(",") === "w-never,w-never-2", picked.join(","));
t("then the stalest last_sync_at", picked[2] === "w-older", picked.join(","));
t("most recent workspace is not in the batch", !picked.includes("w-recent"));
t("input array is not mutated", fleet[0].workspace_id === "w-recent" && fleet[2].workspace_id === "w-never");
t("custom limit respected", selectWorkspacesForBoundedSync(fleet, 1).length === 1);
t("limit 0 runs nothing", selectWorkspacesForBoundedSync(fleet, 0).length === 0);
t("smaller fleet than limit returns all", selectWorkspacesForBoundedSync(fleet.slice(0, 2)).length === 2);

console.log("\n=== validateSharetribeCredentials with stubbed fetch (no network) ===");
type Call = { url: string; body: string; headers: Record<string, string> };
const calls: Call[] = [];
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  calls.length = 0;
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const h = init.headers as Record<string, string> | undefined;
    calls.push({ url, body: init.body ? String(init.body) : "", headers: h ?? {} });
    return handler(url, init);
  }) as typeof fetch;
}
// Retries back off with real sleeps; collapse them so the 5xx case stays fast.
(globalThis as any).setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as typeof setTimeout;

stubFetch((url) => {
  if (url.endsWith("/auth/token")) return new Response('{"error":"invalid_client"}', { status: 400 });
  return new Response("unexpected", { status: 500 });
});
const bad = await validateSharetribeCredentials({ mode: "marketplace", clientId: "not-a-real-client" });
t("400 at token endpoint → friendly Client ID message", !bad.ok && bad.error.includes("Client ID") && !bad.error.includes("auth_failed"), JSON.stringify(bad));
t("marketplace mode POSTs the Marketplace API token URL", calls[0]?.url === "https://flex-api.sharetribe.com/v1/auth/token", calls[0]?.url);
t("marketplace mode request body has no client_secret", !calls[0]?.body.includes("client_secret") && calls[0]?.body.includes("scope=public-read"), calls[0]?.body);
t("stops after the auth failure (no show call)", calls.length === 1, String(calls.length));

const mpId = "5f2c1a9e-8b7d-4c6e-9a1f-2b3c4d5e6f70";
stubFetch((url, init) => {
  if (url.endsWith("/auth/token")) return Response.json({ access_token: "tok-123", token_type: "bearer" });
  if (url.endsWith("/marketplace/show")) {
    const auth = (init.headers as Record<string, string>)?.Authorization;
    if (auth !== "Bearer tok-123") return new Response("nope", { status: 401 });
    return Response.json({ data: { id: { uuid: mpId }, type: "marketplace", attributes: { name: "Pools Near Me" } } });
  }
  return new Response("unexpected", { status: 500 });
});
const good = await validateSharetribeCredentials({ mode: "marketplace", clientId: "client-1234567" });
t("valid Client ID → marketplace id + name from marketplace/show", good.ok && good.marketplaceId === mpId && good.name === "Pools Near Me", JSON.stringify(good));
t("show is called on the Marketplace API with the bearer token", calls[1]?.url === "https://flex-api.sharetribe.com/v1/api/marketplace/show" && calls[1]?.headers.Authorization === "Bearer tok-123", JSON.stringify(calls[1]));

stubFetch((url) => {
  if (url.endsWith("/auth/token")) return Response.json({ access_token: "tok-int" });
  if (url.endsWith("/marketplace/show")) return Response.json({ data: { id: { uuid: mpId }, attributes: { name: "Pools" } } });
  return new Response("unexpected", { status: 500 });
});
const goodInt = await validateSharetribeCredentials({ mode: "integration", clientId: "client-1234567", clientSecret: "shh-secret" });
t("integration mode hits the Integration API", goodInt.ok && calls[0]?.url === "https://flex-integ-api.sharetribe.com/v1/auth/token" && calls[1]?.url.startsWith("https://flex-integ-api.sharetribe.com/v1/integration_api/"), JSON.stringify(calls.map((c) => c.url)));
t("integration mode sends the secret with scope integ", calls[0]?.body.includes("client_secret=shh-secret") && calls[0]?.body.includes("scope=integ"), calls[0]?.body);

stubFetch(() => new Response("upstream down", { status: 503 }));
const down = await validateSharetribeCredentials({ mode: "marketplace", clientId: "client-1234567" });
t("503 (after retries) → 'not answering' message", !down.ok && down.error === SHARETRIBE_UNAVAILABLE_MESSAGE, JSON.stringify(down));
t("5xx is retried a bounded number of times", calls.length === 3, String(calls.length));

stubFetch(() => { throw new TypeError("fetch failed"); });
const netErr = await validateSharetribeCredentials({ mode: "integration", clientId: "client-1234567", clientSecret: "shh-secret" });
t("network exception → 'not answering' message", !netErr.ok && netErr.error === SHARETRIBE_UNAVAILABLE_MESSAGE, JSON.stringify(netErr));

globalThis.fetch = realFetch;
globalThis.setTimeout = realSetTimeout;

console.log("\n=== Migration files contain the expected statements ===");
const migDir = join(import.meta.dir, "..", "supabase", "migrations");
const m1 = readFileSync(join(migDir, "20260923000100_marketplace_api_connection.sql"), "utf8");
t("auth_mode column added with a default", /ADD COLUMN IF NOT EXISTS auth_mode text NOT NULL DEFAULT 'integration'/.test(m1));
t("auth_mode CHECK restricts to marketplace|integration", /CHECK \(auth_mode IN \('marketplace', 'integration'\)\)/.test(m1));
t("client_secret_vault_id made nullable", /ALTER COLUMN client_secret_vault_id DROP NOT NULL/.test(m1));
t("marketplace_id is NOT dropped/nullable", !/marketplace_id DROP NOT NULL/.test(m1) && /marketplace_id still required/.test(m1));
t("comment explains why no secret in marketplace mode", /COMMENT ON COLUMN public\.tenant_integrations\.client_secret_vault_id[\s\S]*NULL for auth_mode = marketplace/.test(m1));
t("migration 1 ends with a verification block", /AS check,[\s\S]*AS ok[\s\S]*UNION ALL/.test(m1));

const m2 = readFileSync(join(migDir, "20260923000200_sync_fanout_cron.sql"), "utf8");
t("both old jobs unscheduled", m2.includes("cron.unschedule('sharetribe-sync-30min')") && m2.includes("cron.unschedule('sync-sharetribe-30min')"));
const scheduleCount = (m2.match(/cron\.schedule\(/g) ?? []).length;
t("exactly one cron.schedule in the fan-out migration", scheduleCount === 1, String(scheduleCount));
t("the one job is sharetribe-sync-30min every 30 minutes", /cron\.schedule\(\s*'sharetribe-sync-30min',\s*'\*\/30 \* \* \* \*'/.test(m2));
t("job calls enqueue_sharetribe_syncs()", /\$CRON\$\s*SELECT public\.enqueue_sharetribe_syncs\(\);\s*\$CRON\$/.test(m2));
t("enqueue function is SECURITY DEFINER and locked down", /CREATE OR REPLACE FUNCTION public\.enqueue_sharetribe_syncs\(\)[\s\S]*SECURITY DEFINER/.test(m2) && /REVOKE ALL ON FUNCTION public\.enqueue_sharetribe_syncs\(\) FROM public, anon, authenticated/.test(m2));
t("fan-out posts one workspace_id per request", /jsonb_build_object\('workspace_id', v_row\.workspace_id\)/.test(m2) && m2.includes("https://www.founders.click/api/public/hooks/sync-sharetribe"));
t("fan-out filters connected/pending sharetribe rows", /status IN \('connected', 'pending'\)/.test(m2) && /provider = 'sharetribe'/.test(m2));
t("fan-out skips with a NOTICE when the secret is missing", /IF v_secret IS NULL THEN[\s\S]*RAISE NOTICE[\s\S]*RETURN 0;/.test(m2));
t("Bearer header uses the Vault secret", /'Authorization', 'Bearer ' \|\| v_secret/.test(m2));
t("verification checks exactly one sharetribe cron job", /count\(\*\) = 1 FROM cron\.job WHERE jobname ILIKE '%sharetribe%'/.test(m2));

console.log(`\n${p} passed, ${f} failed\n`); process.exit(f ? 1 : 0);
