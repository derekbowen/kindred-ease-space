/**
 * CONNECT, FIRST SYNC, DISCONNECT, THE CRON HOOK. Run: bun tests/sharetribe-connect-flow.test.ts
 *
 * Drives the real code paths that talk to Supabase — the service-role
 * supabase-js client against a fake PostgREST (tests/_support/fake-backend.ts)
 * whose tables and lease functions live in tests/_support/sharetribe-fakes.ts
 * — with a fake Sharetribe and a fake marketplace website behind the same
 * fetch. Offline, no credentials.
 *
 *  - connect: validate + identity → row ("pending") → (Integration API) the
 *    Vault secret → "connected" → first sync → listing-link check; a failure
 *    after the row write leaves status "error"; a different marketplace
 *    clears the old listings and resets sync state; one workspace per
 *    marketplace; no domain is ever marked verified;
 *  - disconnect: listings, row, sweep, Vault — in that order;
 *  - the cron hook: UUID validation, honest status codes, no raw errors;
 *  - the Supabase SyncDb's exact queries (upsert conflict target, exact
 *    counts, lease RPC arguments).
 */
process.env.SUPABASE_URL = "http://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";

import { FakeBackend, type Hit } from "./_support/fake-backend";
import { FakeSharetribe, ListingStore, MARKETPLACE_ID, iso, uuid } from "./_support/sharetribe-fakes";

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
const origError = console.error;
console.error = () => {};

type Row = Record<string, any>;

// ---------------------------------------------------------------------------
// One fetch for everything: Sharetribe, the customer's marketplace, Supabase.
// ---------------------------------------------------------------------------
const backend = new FakeBackend();
backend.install();
const backendFetch = globalThis.fetch;
let api = new FakeSharetribe();
const siteRequests: string[] = [];
async function marketplaceSite(url: string): Promise<Response> {
  siteRequests.push(url);
  const m = /^\/l\/[^/]+\/([0-9a-f-]{36})$/.exec(new URL(url).pathname);
  const l = m ? api.catalog.find((x) => x.id === m[1]) : undefined;
  if (!l) return new Response("not found", { status: 404 });
  return new Response(`<html><head><title>${l.title} | Pools Near Me</title></head><body><h1>${l.title}</h1></body></html>`, {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(url).hostname;
  if (host.endsWith("sharetribe.com")) return api.fetch(url, init);
  if (host === "pools.example.com" || host === "www.pools.example.com") return marketplaceSite(url);
  return backendFetch(input, init);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// A PostgREST over the in-memory tables.
// ---------------------------------------------------------------------------
let store = new ListingStore(() => Date.now());
const parseIn = (v: string) => v.replace(/^\(|\)$/g, "").split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
function matches(row: Row, q: URLSearchParams): boolean {
  for (const [k, v] of q) {
    if (["select", "limit", "order", "offset", "on_conflict", "columns"].includes(k)) continue;
    const dot = v.indexOf(".");
    const op = v.slice(0, dot);
    const val = v.slice(dot + 1);
    const cell = row[k];
    if (op === "eq") {
      if (String(cell) !== val) return false;
    } else if (op === "neq") {
      if (String(cell) === val) return false;
    } else if (op === "is") {
      if (val === "null" ? cell !== null && cell !== undefined : String(cell) !== val) return false;
    } else if (op === "in") {
      if (!parseIn(val).includes(String(cell))) return false;
    } else throw new Error(`unsupported filter ${k}=${v}`);
  }
  return true;
}
function selectRows(list: Row[], q: URLSearchParams): Row[] {
  let out = list.filter((r) => matches(r, q));
  const order = q.get("order");
  if (order) {
    const keys = order.split(",").map((p) => ({ col: p.split(".")[0]!, desc: p.split(".")[1] === "desc" }));
    out = [...out].sort((a, b) => {
      for (const k of keys) {
        if (a[k.col] === b[k.col]) continue;
        const c = a[k.col] < b[k.col] ? -1 : 1;
        return k.desc ? -c : c;
      }
      return 0;
    });
  }
  const limit = q.get("limit");
  if (limit) out = out.slice(0, Number(limit));
  return JSON.parse(JSON.stringify(out));
}

const faults: { integrationUpsert?: { status: number; body: unknown }; listingDelete?: number; secretDelete?: boolean; candidates?: boolean } = {};
const listingDeletes = { n: 0 };

function installDb() {
  backend.reset();
  backend.rest["GET tenant_integrations"] = (h) =>
    faults.candidates && h.query.get("status")?.startsWith("in.")
      ? { status: 500, body: { message: "read exploded: relation internals" } }
      : selectRows(store.integrations, h.query);
  backend.rest["POST tenant_integrations"] = (h) => {
    if (faults.integrationUpsert) return faults.integrationUpsert;
    for (const r of Array.isArray(h.body) ? h.body : [h.body]) {
      const clash = store.integrations.find(
        (x) => x.provider === r.provider && x.marketplace_id === r.marketplace_id && x.workspace_id !== r.workspace_id,
      );
      if (clash) {
        return { status: 409, body: { code: "23505", message: 'duplicate key value violates unique constraint "tenant_integrations_provider_marketplace_id_key"' } };
      }
      const existing = store.integration(r.workspace_id);
      if (existing) Object.assign(existing, r);
      else store.addIntegration(r.workspace_id, r);
    }
    return [];
  };
  backend.rest["PATCH tenant_integrations"] = (h) => {
    const hit = store.integrations.filter((r) => matches(r, h.query));
    for (const r of hit) Object.assign(r, h.body);
    return hit;
  };
  backend.rest["DELETE tenant_integrations"] = (h) => {
    const gone = store.integrations.filter((r) => matches(r, h.query));
    store.integrations = store.integrations.filter((r) => !matches(r, h.query));
    return gone;
  };
  backend.rest["GET tenant_listings"] = (h) => selectRows(store.listings, h.query);
  backend.rest["HEAD tenant_listings"] = (h) => store.listings.filter((r) => matches(r, h.query));
  backend.rest["POST tenant_listings"] = (h) => {
    store.upsert(Array.isArray(h.body) ? h.body : [h.body]);
    return [];
  };
  backend.rest["DELETE tenant_listings"] = (h) => {
    listingDeletes.n++;
    if (faults.listingDelete && faults.listingDelete === listingDeletes.n) return { status: 500, body: { message: "delete exploded" } };
    const gone = store.listings.filter((r) => matches(r, h.query));
    store.listings = store.listings.filter((r) => !matches(r, h.query));
    return gone;
  };
  for (const fn of ["claim_listing_sync", "touch_listing_sync", "reconcile_listing_sync", "finish_listing_sync"]) {
    backend.rpc[fn] = (a) => store.rpc(fn, a);
  }
  backend.rpc.tenant_get_integration_secret = (a) => store.secrets.get(a._workspace_id) ?? null;
  backend.rpc.tenant_delete_integration_secret = (a) => {
    if (faults.secretDelete) return { status: 500, body: { message: "vault down" } };
    store.secrets.delete(a._workspace_id);
    return null;
  };
}

function fresh(catalogSize = 30) {
  store = new ListingStore(() => Date.now());
  api = new FakeSharetribe();
  api.catalog = Array.from({ length: catalogSize }, (_, i) => ({
    id: uuid(i + 1, 0xc0),
    title: `Backyard Pool ${i + 1}`,
    publicData: { city: "Austin", state: "TX", country: "US", category: "Pool", unitType: "Hour" },
  }));
  siteRequests.length = 0;
  for (const k of Object.keys(faults)) delete (faults as any)[k];
  listingDeletes.n = 0;
  installDb();
}

const fns = await import("../src/lib/sharetribe-sync.functions");
const { runSharetribeSyncForWorkspace } = await import("../src/lib/sharetribe-sync.server");
const { Route: hookRoute } = await import("../src/routes/api/public/hooks/sync-sharetribe");

const WS = uuid(1, 0xabc);
const OTHER = uuid(2, 0xabc);
const baseInput = (patch: Partial<Record<string, any>> = {}) =>
  ({ workspaceId: WS, marketplaceUrl: "pools.example.com/", authMode: "marketplace", clientId: "client-1234567", ...patch }) as any;
const noSecret = async (): Promise<string | null> => {
  throw new Error("storeSecret must not be called in Marketplace API mode");
};
const idx = (pred: (h: Hit) => boolean) => backend.hits.findIndex(pred);
const rest = (m: string, table: string) => (h: Hit) => h.kind === "rest" && h.method === m && h.name === table;
const rpc = (name: string) => (h: Hit) => h.kind === "rpc" && h.name === name;

try {
  // ==========================================================================
  console.log("\n=== connect (Marketplace API): row → connected → first sync → link check ===");
  // ==========================================================================
  {
    fresh(30);
    const r = await fns.connectSharetribeForWorkspace({ workspaceId: WS, input: baseInput(), storeSecret: noSecret });
    t("connected, with the marketplace's identity from marketplace/show", r.ok && r.marketplaceId === MARKETPLACE_ID && r.marketplaceName === "Pools Near Me" && r.authMode === "marketplace", JSON.stringify(r));
    t("…and the first sync already ran: 30 listings, success", r.ok && r.sync.status === "success" && r.sync.upserted === 30 && r.sync.listingsCount === 30, JSON.stringify(r.ok && r.sync));
    t("…and the listing links were checked after it", r.ok && r.linkCheck?.result === "ok" && siteRequests.length === 1, JSON.stringify(r.ok && r.linkCheck));
    const upsert = backend.hits.find(rest("POST", "tenant_integrations"))!;
    t("the row is written as 'pending' with the normalised URL and no secret id", upsert.body.status === "pending" && upsert.body.marketplace_url === "https://pools.example.com" && upsert.body.client_secret_vault_id === null && upsert.body.marketplace_id === MARKETPLACE_ID && upsert.query.get("on_conflict") === "workspace_id,provider", JSON.stringify(upsert.body));
    const order = [
      idx(rest("POST", "tenant_integrations")),
      idx((h) => rest("PATCH", "tenant_integrations")(h) && h.body.status === "connected"),
      idx(rpc("claim_listing_sync")),
      idx(rpc("finish_listing_sync")),
      idx((h) => rest("PATCH", "tenant_integrations")(h) && "certification_status" in h.body),
    ];
    t("order: upsert → mark connected → claim → finish → link-check result", order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1]!)), JSON.stringify(order));
    const row = store.integration(WS)!;
    t("the stored row: connected, last sync success, 30 listings, links CERTIFIED", row.status === "connected" && row.last_sync_status === "success" && row.listings_count === 30 && row.certification_status === "CERTIFIED" && row.last_success_at !== null);
    t("no domain is touched, let alone marked verified", !backend.hits.some((h) => h.kind === "rest" && /workspace_domains|workspaces/.test(h.name)));
    t("Marketplace API mode never touches Vault", !backend.hits.some((h) => h.kind === "rpc" && /integration_secret/.test(h.name)));
  }

  // ==========================================================================
  console.log("\n=== connect (Integration API): the secret is stored AFTER the row, BEFORE 'connected' ===");
  // ==========================================================================
  {
    fresh(12);
    let storedAt = -1;
    const r = await fns.connectSharetribeForWorkspace({
      workspaceId: WS,
      input: baseInput({ authMode: "integration", clientSecret: "shh-integration-secret" }),
      storeSecret: async (secret) => {
        storedAt = backend.hits.length;
        store.secrets.set(WS, secret);
        return "vault-id-1";
      },
    });
    const upsertAt = idx(rest("POST", "tenant_integrations"));
    const markAt = idx((h) => rest("PATCH", "tenant_integrations")(h) && h.body.status === "connected");
    t("row, then secret, then connected", r.ok && upsertAt >= 0 && storedAt > upsertAt && markAt >= storedAt, `${upsertAt} ${storedAt} ${markAt}`);
    t("'connected' carries the new vault id", backend.hits[markAt]?.body.client_secret_vault_id === "vault-id-1" && store.integration(WS)!.client_secret_vault_id === "vault-id-1");
    t("the first sync used the Integration API with the stored secret", r.ok && r.sync.status === "success" && api.requests.some((q) => q.url.hostname === "flex-integ-api.sharetribe.com" && /client_secret=shh-integration-secret/.test(q.body)));
  }
  {
    fresh(3);
    const r = await fns.connectSharetribeForWorkspace({
      workspaceId: WS,
      input: baseInput({ authMode: "integration", clientSecret: "shh-integration-secret" }),
      storeSecret: async () => null,
    });
    const row = store.integration(WS)!;
    t("the secret can't be stored → a clear failure, never 'connected'", !r.ok && r.error === fns.CONNECT_SENTENCES.secretStoreFailed && row.status === "error" && row.last_sync_error === fns.CONNECT_SENTENCES.secretStoreFailedRow);
    t("…and no sync runs against a half-saved connection", !backend.hits.some(rpc("claim_listing_sync")));
  }
  {
    fresh(3);
    store.addIntegration(WS, { auth_mode: "integration", client_secret_vault_id: "old-vault", marketplace_id: MARKETPLACE_ID });
    store.secrets.set(WS, "old-secret");
    const r = await fns.connectSharetribeForWorkspace({ workspaceId: WS, input: baseInput(), storeSecret: noSecret });
    const upsertAt = idx(rest("POST", "tenant_integrations"));
    const delAt = idx(rpc("tenant_delete_integration_secret"));
    t("switching to the Marketplace API deletes the old secret after the row write", r.ok && delAt > upsertAt && !store.secrets.has(WS) && store.integration(WS)!.client_secret_vault_id === null && store.integration(WS)!.auth_mode === "marketplace");
    fresh(3);
    store.addIntegration(WS, { auth_mode: "integration", client_secret_vault_id: "old-vault", marketplace_id: MARKETPLACE_ID });
    faults.secretDelete = true;
    const r2 = await fns.connectSharetribeForWorkspace({ workspaceId: WS, input: baseInput(), storeSecret: noSecret });
    t("…and if that delete fails, the connection says so (status error), no sync", !r2.ok && r2.error === fns.CONNECT_SENTENCES.secretCleanupFailed && store.integration(WS)!.status === "error" && !backend.hits.some(rpc("claim_listing_sync")));
  }

  // ==========================================================================
  console.log("\n=== connect to a DIFFERENT marketplace: old listings go, state resets ===");
  // ==========================================================================
  {
    fresh(4);
    const OLD_MP = uuid(9, 0x0dd);
    store.addIntegration(WS, {
      marketplace_id: OLD_MP,
      certification_status: "CERTIFIED",
      certification_detail: { listing_link: { result: "ok", checked_at: iso(Date.now() - 86_400_000) } },
      sync_state: { empty_strikes: 1, first_empty_at: iso(Date.now() - 3_600_000) },
      last_success_at: iso(Date.now() - 86_400_000),
      listings_count: 7,
      upstream_total: 7,
    });
    for (let i = 0; i < 7; i++) store.seedListing(WS, uuid(700 + i, 0x0dd), iso(Date.now() - 86_400_000));
    store.seedListing(OTHER, uuid(800, 0x0dd), iso(Date.now() - 86_400_000));
    const r = await fns.connectSharetribeForWorkspace({ workspaceId: WS, input: baseInput(), storeSecret: noSecret });
    const upsert = backend.hits.find(rest("POST", "tenant_integrations"))!;
    t("the switch is detected", r.ok && r.marketplaceChanged);
    t("the upsert resets sync state, lease and the link check", upsert.body.sync_run_id === null && upsert.body.sync_lease_until === null && JSON.stringify(upsert.body.sync_state) === "{}" && upsert.body.last_success_at === null && upsert.body.listings_count === 0 && upsert.body.certification_status === "UNCERTIFIED" && JSON.stringify(upsert.body.certification_detail) === "{}", JSON.stringify(upsert.body));
    const clearAt = idx(rest("DELETE", "tenant_listings"));
    t("the previous marketplace's listings are deleted before the first sync", clearAt > idx(rest("POST", "tenant_integrations")) && clearAt < idx(rpc("claim_listing_sync")));
    const mine = store.listingsOf(WS).map((l) => l.sharetribe_listing_id);
    t("…leaving only the new marketplace's listings; other workspaces untouched", mine.length === 4 && mine.every((id) => api.catalog.some((c) => c.id === id)) && store.listingsOf(OTHER).length === 1);
    t("…and the new marketplace's links are checked afresh", r.ok && r.linkCheck?.result === "ok");
  }
  {
    fresh(4);
    store.addIntegration(WS, { marketplace_id: uuid(9, 0x0dd) });
    store.seedListing(WS, uuid(700, 0x0dd), iso(Date.now() - 86_400_000));
    faults.listingDelete = 1;
    const r = await fns.connectSharetribeForWorkspace({ workspaceId: WS, input: baseInput(), storeSecret: noSecret });
    t("if the old listings can't be removed: status error, a clear sentence, no sync", !r.ok && r.error === fns.CONNECT_SENTENCES.switchCleanupFailed && store.integration(WS)!.status === "error" && !backend.hits.some(rpc("claim_listing_sync")));
  }
  {
    fresh(2);
    store.addIntegration(WS, { marketplace_id: MARKETPLACE_ID, marketplace_url: "https://old.pools.example.com", certification_status: "CERTIFIED" });
    await fns.connectSharetribeForWorkspace({ workspaceId: WS, input: baseInput(), storeSecret: noSecret });
    const upsert = backend.hits.find(rest("POST", "tenant_integrations"))!;
    t("same marketplace, new URL: only the link check resets (listings kept)", upsert.body.certification_status === "UNCERTIFIED" && !("sync_state" in upsert.body) && !backend.hits.some(rest("DELETE", "tenant_listings")));
  }

  // ==========================================================================
  console.log("\n=== connect refusals ===");
  // ==========================================================================
  {
    fresh();
    store.addIntegration(OTHER, { marketplace_id: MARKETPLACE_ID });
    let called = false;
    const r = await fns.connectSharetribeForWorkspace({ workspaceId: WS, input: baseInput({ authMode: "integration", clientSecret: "shh-integration-secret" }), storeSecret: async () => ((called = true), "x") });
    t("a marketplace held by another workspace → the refusal that names nobody, before any write", !r.ok && r.error === fns.MARKETPLACE_ALREADY_CONNECTED_ERROR && !called && !backend.hits.some((h) => h.kind === "rest" && h.method !== "GET"));
    const heldCheck = backend.hits.find((h) => rest("GET", "tenant_integrations")(h) && h.query.get("workspace_id")?.startsWith("neq."));
    t("…the check reads only an id for (sharetribe, marketplace_id)", heldCheck?.query.get("select") === "id" && heldCheck?.query.get("marketplace_id") === `eq.${MARKETPLACE_ID}` && heldCheck?.query.get("provider") === "eq.sharetribe");
  }
  {
    fresh();
    faults.integrationUpsert = { status: 409, body: { code: "23505", message: 'duplicate key value violates unique constraint "tenant_integrations_provider_marketplace_id_key"' } };
    const r = await fns.connectSharetribeForWorkspace({ workspaceId: WS, input: baseInput(), storeSecret: noSecret });
    t("losing the race at the upsert (23505) → the same friendly refusal", !r.ok && r.error === fns.MARKETPLACE_ALREADY_CONNECTED_ERROR);
    fresh();
    faults.integrationUpsert = { status: 500, body: { message: "insert exploded" } };
    const r2 = await fns.connectSharetribeForWorkspace({ workspaceId: WS, input: baseInput(), storeSecret: noSecret });
    t("any other upsert failure → 'couldn't save', no raw text", !r2.ok && r2.error === fns.CONNECT_SENTENCES.saveFailed);
  }
  {
    fresh();
    for (const bad of ["http://127.0.0.1:8080", "localhost", "https://user:pw@pools.example.com", "ftp://pools.example.com", "https://[::1]/"]) {
      const r = await fns.connectSharetribeForWorkspace({ workspaceId: WS, input: baseInput({ marketplaceUrl: bad }), storeSecret: noSecret });
      t(`"${bad}" is not a marketplace URL (nothing is called)`, !r.ok && r.error === fns.CONNECT_SENTENCES.badUrl && api.requests.length === 0);
    }
    t("normalisation keeps a path prefix, drops query and trailing slashes", fns.normalizeMarketplaceUrl(" https://Shop.Example.com/market/?x=1#y ") === "https://shop.example.com/market");
    api.tokenAnswer = () => new Response('{"error":"invalid_client"}', { status: 400 });
    const r = await fns.connectSharetribeForWorkspace({ workspaceId: WS, input: baseInput(), storeSecret: noSecret });
    t("a Client ID Sharetribe rejects → the Client ID sentence, nothing written", !r.ok && /didn't accept that Client ID/.test(r.error) && !backend.hits.some((h) => h.kind === "rest" && h.method !== "GET"));
  }

  // ==========================================================================
  console.log("\n=== disconnect: listings → row → sweep → Vault ===");
  // ==========================================================================
  {
    fresh();
    store.addIntegration(WS);
    for (let i = 0; i < 3; i++) store.seedListing(WS, uuid(i, 0xd15), iso(Date.now()));
    store.seedListing(OTHER, uuid(9, 0xd15), iso(Date.now()));
    const r = await fns.disconnectSharetribeForWorkspace(WS);
    const seq = backend.hits.filter((h) => h.kind === "rpc" || h.method === "DELETE").map((h) => `${h.method} ${h.name}`);
    t("ok; listings, then the row, then a second listings sweep, then the secret", r.ok && JSON.stringify(seq) === JSON.stringify(["DELETE tenant_listings", "DELETE tenant_integrations", "DELETE tenant_listings", "POST tenant_delete_integration_secret"]), JSON.stringify(seq));
    t("every delete is scoped to the workspace", backend.hits.filter((h) => h.method === "DELETE").every((h) => h.query.get("workspace_id") === `eq.${WS}`));
    t("nothing of this workspace remains; the other workspace is untouched", store.listingsOf(WS).length === 0 && !store.integration(WS) && store.listingsOf(OTHER).length === 1);
    fresh();
    store.addIntegration(WS);
    faults.listingDelete = 1;
    const r2 = await fns.disconnectSharetribeForWorkspace(WS);
    t("a failed listings delete leaves the connection in place, with a retry sentence", !r2.ok && /still in place\. Try Disconnect again\./.test(r2.error) && !!store.integration(WS));
  }

  // ==========================================================================
  console.log("\n=== the Supabase SyncDb: exact queries ===");
  // ==========================================================================
  {
    fresh(3);
    store.addIntegration(WS);
    store.seedListing(WS, uuid(99, 0x5ab), iso(Date.now() - 86_400_000));
    const r = await runSharetribeSyncForWorkspace(WS);
    t("a real run through supabase-js completes and reconciles", r.status === "success" && r.removed === 1 && store.listingsOf(WS).length === 3, JSON.stringify({ ...r, sentence: r.sentence }));
    const up = backend.hits.find(rest("POST", "tenant_listings"))!;
    t("upsert: on_conflict=workspace_id,sharetribe_listing_id, merge-duplicates", up.query.get("on_conflict") === "workspace_id,sharetribe_listing_id" && /resolution=merge-duplicates/.test(up.headers.get("prefer") ?? ""));
    const claim = backend.hits.find(rpc("claim_listing_sync"))!;
    t("claim: (_workspace_id, _run_id, _lease_seconds 300)", claim.body._workspace_id === WS && typeof claim.body._run_id === "string" && claim.body._lease_seconds === 300);
    const recon = backend.hits.find(rpc("reconcile_listing_sync"))!;
    t("reconcile: the run's id and start time", recon.body._run_id === claim.body._run_id && typeof recon.body._run_started_at === "string" && up.body.every((row: Row) => row.synced_at === recon.body._run_started_at));
    const count = backend.hits.find(rest("HEAD", "tenant_listings"))!;
    t("listings_count: an exact HEAD count of this workspace's published listings", /count=exact/.test(count.headers.get("prefer") ?? "") && count.query.get("workspace_id") === `eq.${WS}` && count.query.get("state_published") === "eq.true");
    const fin = backend.hits.find(rpc("finish_listing_sync"))!;
    t("finish: success, status, error null, the counted listings_count, upstream_total", fin.body._outcome.success === true && fin.body._outcome.status === "success" && fin.body._outcome.error === null && fin.body._outcome.listings_count === 3 && fin.body._outcome.upstream_total === 3);
    t("no capped id reads, no .in() deletes", !backend.hits.some((h) => h.kind === "rest" && h.name === "tenant_listings" && (h.method === "DELETE" || (h.method === "GET" && /sharetribe_listing_id/.test(h.query.get("select") ?? "")))));
  }
  {
    fresh();
    for (let i = 0; i < 5; i++) store.seedListing(WS, uuid(i, 0x9a9), iso(Date.now()), { city_key: i < 2 ? null : "austin", category_key: i === 4 ? null : "pool" });
    store.seedListing(WS, uuid(9, 0x9a9), iso(Date.now()), { state_published: false, city_key: null });
    const g = await fns.countListingDataGaps(WS);
    t("listing gaps: exact counts of published listings without a city / a category", g.published === 5 && g.missingCity === 2 && g.missingCategory === 1, JSON.stringify(g));
    t("…as HEAD count queries (never a capped read)", backend.hits.filter(rest("HEAD", "tenant_listings")).length === 3 && !backend.hits.some(rest("GET", "tenant_listings")));
  }

  // ==========================================================================
  console.log("\n=== the cron hook ===");
  // ==========================================================================
  {
    const CRON = "cron-secret-for-connect-flow-tests";
    process.env.CRON_SECRET = CRON;
    const POST = (hookRoute as any).options.server.handlers.POST as (c: { request: Request }) => Promise<Response>;
    const call = (body: string) =>
      POST({ request: new Request("https://www.founders.click/api/public/hooks/sync-sharetribe", { method: "POST", headers: { authorization: `Bearer ${CRON}`, "content-type": "application/json" }, body }) });

    fresh();
    for (const [label, body] of [["a non-UUID workspace_id", '{"workspace_id":"ws-1; drop"}'], ["a numeric workspace_id", '{"workspace_id":42}'], ["null", '{"workspace_id":null}']] as const) {
      const res = await call(body);
      const j = await res.json();
      t(`${label} → 400 invalid_workspace_id, nothing read`, res.status === 400 && j.error === "invalid_workspace_id" && backend.hits.length === 0, `${res.status} ${JSON.stringify(j)}`);
    }
    const notJson = await call("{nope");
    const arr = await call("[1,2]");
    t("a body that isn't a JSON object → 400 invalid_body", notJson.status === 400 && arr.status === 400 && (await notJson.json()).error === "invalid_body");

    fresh(5);
    store.addIntegration(WS);
    const ok = await call(JSON.stringify({ workspace_id: WS }));
    const okJ = await ok.json();
    t("one workspace: 200 with its status and counts", ok.status === 200 && okJ.ok === true && okJ.status === "success" && okJ.upserted === 5 && okJ.listings_count === 5 && okJ.upstream_total === 5, JSON.stringify(okJ));

    const nc = await call(JSON.stringify({ workspace_id: uuid(77, 0xabc) }));
    const ncJ = await nc.json();
    t("a workspace with no connection → 404 not_connected", nc.status === 404 && ncJ.status === "not_connected" && ncJ.ok === false);

    fresh(5);
    store.addIntegration(WS);
    api.tokenAnswer = () => new Response("auth_failed: invalid_client secret-ish detail", { status: 401 });
    const bad = await call(JSON.stringify({ workspace_id: WS }));
    const badText = await bad.text();
    t("a failed run → 500, status failed, and no raw error text in the reply", bad.status === 500 && JSON.parse(badText).status === "failed" && !/auth_failed|invalid_client|secret-ish|Client ID/.test(badText), badText);

    fresh(5);
    store.addIntegration(WS);
    store.addIntegration(OTHER, { marketplace_id: uuid(3, 0x3a3a) });
    api.tokenAnswer = () => new Response("", { status: 401 });
    const all = await call("{}");
    const allJ = await all.json();
    t("bounded mode where every run fails → 500, success false (not 'success: true')", all.status === 500 && allJ.success === false && allJ.failed === 2 && allJ.succeeded === 0, JSON.stringify(allJ));

    fresh(5);
    faults.candidates = true;
    const unreadable = await call("");
    const unreadableText = await unreadable.text();
    t("bounded mode with an unreadable candidate list → 500 read_failed, no database text", unreadable.status === 500 && JSON.parse(unreadableText).read_failed === true && !/exploded|relation/.test(unreadableText), unreadableText);

    fresh(5);
    const none = await call("");
    const noneJ = await none.json();
    t("bounded mode with nothing to do → 200 success", none.status === 200 && noneJ.success === true && noneJ.eligible === 0);
    delete process.env.CRON_SECRET;
  }
} finally {
  console.error = origError;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failed:\n  " + failed.join("\n  "));
  process.exit(1);
}
