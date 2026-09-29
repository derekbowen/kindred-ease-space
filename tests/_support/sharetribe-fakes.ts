/**
 * Fakes for driving the REAL Sharetribe sync offline.
 *
 *  - Clock: a controllable clock whose sleep() advances time (and records it).
 *  - ListingStore: tenant_integrations + tenant_listings in memory, with the
 *    four lease functions of 20260929000100 implemented with the SAME
 *    semantics as the SQL (claim only when the lease is free or expired;
 *    touch/reconcile only by the holder of an unexpired lease; reconcile
 *    deletes this workspace's rows stamped before the run started, no cap;
 *    finish by run id, COALESCE-style updates). tests/mvp-migrations.pg.ts
 *    proves the SQL itself on PostgreSQL 16.
 *  - FakeSharetribe: the token, marketplace/show and listings/query
 *    endpoints of both APIs, with pagination meta, injectable failures,
 *    hangs (until the request's AbortSignal fires) and mid-run catalogue
 *    changes.
 */
import type { ListingRow, SyncDb, SyncIntegration } from "../../src/lib/sharetribe-sync.server";

type AnyRec = Record<string, any>;

/** A valid UUID from a number (and an optional hex group). */
export const uuid = (n: number, group = 0) =>
  `${group.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export const iso = (ms: number) => new Date(ms).toISOString();

export class Clock {
  t: number;
  sleeps: number[] = [];
  constructor(start = Date.parse("2026-09-28T12:00:00.000Z")) {
    this.t = start;
  }
  now = () => this.t;
  advance = (ms: number) => {
    this.t += ms;
  };
  sleep = async (ms: number) => {
    this.sleeps.push(ms);
    this.t += ms;
  };
}

export type IntegrationState = SyncIntegration & {
  provider: string;
  marketplace_id: string;
  marketplace_name: string | null;
  client_secret_vault_id: string | null;
  sync_run_id: string | null;
  sync_started_at: string | null;
  sync_lease_until: string | null;
  sync_progress: unknown;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  last_success_at: string | null;
  listings_count: number;
  upstream_total: number | null;
  sync_state: unknown;
  certification_status: string;
  certified_at: string | null;
  certification_error: string | null;
  certification_detail: unknown;
  updated_at: string | null;
};

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export class ListingStore {
  integrations: IntegrationState[] = [];
  listings: AnyRec[] = [];
  secrets = new Map<string, string>();
  /** Every store call, in order: load, secret, upsert:<n>, count, deleteAll, candidates, and the rpc names. */
  log: string[] = [];
  /** Runs before every call — lets a test change the world mid-run. */
  onCall?: (name: string, args: AnyRec) => void;
  /** Make the n-th call of a kind throw (e.g. { upsert: 2 }). */
  failOn: Record<string, number> = {};
  private counts: Record<string, number> = {};

  constructor(public now: () => number) {}

  integration(workspaceId: string): IntegrationState | null {
    return this.integrations.find((r) => r.workspace_id === workspaceId && r.provider === "sharetribe") ?? null;
  }

  addIntegration(workspaceId: string, patch: Partial<IntegrationState> = {}): IntegrationState {
    const row: IntegrationState = {
      id: uuid(this.integrations.length + 1, 0xfeed),
      workspace_id: workspaceId,
      provider: "sharetribe",
      status: "connected",
      marketplace_url: "https://pools.example.com",
      marketplace_id: uuid(1, 0x3a3a),
      marketplace_name: "Pools Near Me",
      client_id: "client-1234567",
      client_secret_vault_id: null,
      auth_mode: "marketplace",
      route_config: {},
      sync_run_id: null,
      sync_started_at: null,
      sync_lease_until: null,
      sync_progress: null,
      last_sync_at: null,
      last_sync_status: null,
      last_sync_error: null,
      last_success_at: null,
      listings_count: 0,
      upstream_total: null,
      sync_state: {},
      certification_status: "UNCERTIFIED",
      certified_at: null,
      certification_error: null,
      certification_detail: {},
      updated_at: null,
      ...patch,
    };
    this.integrations.push(row);
    return row;
  }

  removeIntegration(workspaceId: string) {
    this.integrations = this.integrations.filter((r) => r.workspace_id !== workspaceId);
  }

  listingsOf(workspaceId: string): AnyRec[] {
    return this.listings.filter((l) => l.workspace_id === workspaceId);
  }

  /** Seed a listing row as a previous run would have left it. */
  seedListing(workspaceId: string, id: string, syncedAt: string, patch: AnyRec = {}) {
    this.listings.push({
      workspace_id: workspaceId,
      sharetribe_listing_id: id,
      title: `Old ${id.slice(-4)}`,
      state_published: true,
      synced_at: syncedAt,
      ...patch,
    });
  }

  private tick(name: string, args: AnyRec) {
    this.log.push(name);
    this.onCall?.(name, args);
    const kind = name.split(":")[0]!;
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
    if (this.failOn[kind] && this.failOn[kind] === this.counts[kind]) throw new Error(`${kind}_failed:injected`);
  }

  // ---- The lease functions, as the SQL defines them -----------------------

  private leaseMs(seconds: unknown) {
    const s = typeof seconds === "number" ? seconds : 300;
    return Math.max(30, Math.min(s, 900)) * 1000;
  }
  private leaseFree(row: IntegrationState) {
    return row.sync_lease_until === null || Date.parse(row.sync_lease_until) < this.now();
  }
  private holds(row: IntegrationState | null, runId: string): row is IntegrationState {
    return (
      !!row &&
      row.sync_run_id === runId &&
      row.sync_lease_until !== null &&
      Date.parse(row.sync_lease_until) >= this.now()
    );
  }

  claim(ws: string, runId: string, seconds: unknown): boolean {
    if (!ws || !runId) throw new Error("claim_listing_sync: missing argument");
    const row = this.integration(ws);
    if (!row || !this.leaseFree(row)) return false;
    row.sync_run_id = runId;
    row.sync_started_at = iso(this.now());
    row.sync_lease_until = iso(this.now() + this.leaseMs(seconds));
    row.sync_progress = { phase: "starting", pages: 0, fetched: 0 };
    row.updated_at = iso(this.now());
    return true;
  }

  touch(ws: string, runId: string, progress: unknown, seconds: unknown): boolean {
    const row = this.integration(ws);
    if (!this.holds(row, runId)) return false;
    row.sync_progress = progress ?? row.sync_progress;
    row.sync_lease_until = iso(this.now() + this.leaseMs(seconds));
    row.updated_at = iso(this.now());
    return true;
  }

  reconcile(ws: string, runId: string, runStartedAt: string): number {
    const row = this.integration(ws);
    if (!this.holds(row, runId)) return -1;
    const cutoff = Date.parse(runStartedAt);
    const before = this.listings.length;
    this.listings = this.listings.filter((l) => !(l.workspace_id === ws && Date.parse(l.synced_at) < cutoff));
    return before - this.listings.length;
  }

  finish(ws: string, runId: string, outcome: AnyRec): boolean {
    const row = this.integration(ws);
    if (!row || row.sync_run_id !== runId) return false;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(outcome, k);
    const text = (k: string) => (outcome[k] === null || outcome[k] === undefined ? null : String(outcome[k]));
    row.sync_lease_until = null;
    if (has("progress") && outcome.progress !== null) row.sync_progress = outcome.progress;
    row.last_sync_at = iso(this.now());
    row.last_sync_status = text("status") ?? row.last_sync_status;
    if (has("error")) row.last_sync_error = text("error");
    if (outcome.success === true) row.last_success_at = iso(this.now());
    if (text("listings_count") !== null) row.listings_count = Number(outcome.listings_count);
    if (text("upstream_total") !== null) row.upstream_total = Number(outcome.upstream_total);
    if (has("sync_state") && outcome.sync_state !== null) row.sync_state = outcome.sync_state;
    row.status = text("connection_status") ?? row.status;
    row.updated_at = iso(this.now());
    return true;
  }

  rpc(name: string, rawArgs: AnyRec): unknown {
    const a = clone(rawArgs);
    this.tick(name, a);
    switch (name) {
      case "claim_listing_sync":
        return this.claim(a._workspace_id, a._run_id, a._lease_seconds);
      case "touch_listing_sync":
        return this.touch(a._workspace_id, a._run_id, a._progress, a._lease_seconds);
      case "reconcile_listing_sync":
        return this.reconcile(a._workspace_id, a._run_id, a._run_started_at);
      case "finish_listing_sync":
        return this.finish(a._workspace_id, a._run_id, a._outcome ?? {});
      default:
        throw new Error(`unexpected rpc ${name}`);
    }
  }

  upsert(rows: AnyRec[]) {
    for (const r of clone(rows)) {
      const at = this.listings.findIndex(
        (l) => l.workspace_id === r.workspace_id && l.sharetribe_listing_id === r.sharetribe_listing_id,
      );
      if (at >= 0) this.listings[at] = { ...this.listings[at], ...r };
      else this.listings.push(r);
    }
  }

  asSyncDb(): SyncDb {
    return {
      loadIntegration: async (ws) => {
        this.tick("load", { ws });
        const row = this.integration(ws);
        return row ? clone(row) : null;
      },
      readSecret: async (ws) => {
        this.tick("secret", { ws });
        return this.secrets.get(ws) ?? null;
      },
      upsertListings: async (rows: ListingRow[]) => {
        this.tick(`upsert:${rows.length}`, { rows });
        this.upsert(rows);
      },
      rpc: async (fn, args) => this.rpc(fn, args),
      countListings: async (ws) => {
        this.tick("count", { ws });
        return this.listings.filter((l) => l.workspace_id === ws && l.state_published === true).length;
      },
      deleteListings: async (ws) => {
        this.tick("deleteAll", { ws });
        this.listings = this.listings.filter((l) => l.workspace_id !== ws);
      },
      listSyncCandidates: async () => {
        this.tick("candidates", {});
        return this.integrations
          .filter((r) => r.provider === "sharetribe" && (r.status === "connected" || r.status === "pending"))
          .map((r) => ({ workspace_id: r.workspace_id, last_sync_at: r.last_sync_at }));
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Fake Sharetribe
// ---------------------------------------------------------------------------

export const MARKETPLACE_ID = uuid(1, 0x3a3a);

export type FakeListing = {
  id: string;
  title?: string;
  description?: string;
  price?: { amount: number; currency: string } | null;
  publicData?: AnyRec;
  metadata?: AnyRec;
  privateData?: AnyRec;
  protectedData?: AnyRec;
  state?: string;
  geolocation?: { lat: number; lng: number } | null;
  authorId?: string;
  images?: Array<{ id: string; url: string }>;
};

export type SharetribeRequest = { url: URL; method: string; body: string; headers: Headers };

function hang(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_, reject) => {
    if (!signal) return; // never settles
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")), {
      once: true,
    });
  });
}

function toResource(l: FakeListing): AnyRec {
  return {
    id: { uuid: l.id },
    type: "listing",
    attributes: {
      title: l.title ?? `Listing ${l.id.slice(-4)}`,
      description: l.description ?? "A lovely place.",
      price: l.price === undefined ? { amount: 5000, currency: "USD" } : l.price,
      geolocation: l.geolocation === undefined ? { lat: 30.27, lng: -97.74 } : l.geolocation,
      state: l.state ?? "published",
      publicData: l.publicData ?? {},
      metadata: l.metadata ?? {},
      ...(l.privateData ? { privateData: l.privateData } : {}),
      ...(l.protectedData ? { protectedData: l.protectedData } : {}),
    },
    relationships: {
      author: { data: l.authorId ? { id: { uuid: l.authorId }, type: "user" } : null },
      images: { data: (l.images ?? []).map((i) => ({ id: { uuid: i.id }, type: "image" })) },
    },
  };
}

function includedFor(slice: FakeListing[]): AnyRec[] {
  const out: AnyRec[] = [];
  const authors = new Set<string>();
  for (const l of slice) {
    if (l.authorId && !authors.has(l.authorId)) {
      authors.add(l.authorId);
      out.push({
        id: { uuid: l.authorId },
        type: "user",
        attributes: {
          email: `owner-${l.authorId.slice(-4)}@example.com`,
          profile: {
            displayName: `Host ${l.authorId.slice(-4)}`,
            privateData: { phone: "AUTHOR-PRIVATE-555" },
          },
        },
      });
    }
    for (const img of l.images ?? []) {
      out.push({
        id: { uuid: img.id },
        type: "image",
        attributes: { variants: { "square-small2x": { url: img.url, width: 480, height: 480 } } },
      });
    }
  }
  return out;
}

export class FakeSharetribe {
  catalog: FakeListing[] = [];
  requests: SharetribeRequest[] = [];
  token = "tok-fake-123";
  /** Replace the token endpoint's answer. */
  tokenAnswer?: () => Response;
  paginationLimit: number | null = 100;
  /** Simulated latency of every request (advances the clock). */
  latencyMs = 0;
  /** Rewrite a page's meta; return the meta to send. */
  meta?: (page: number, meta: AnyRec) => AnyRec | undefined;
  /** Replace page N attempt K: a Response, "hang", or undefined for the normal page. */
  answer?: (page: number, attempt: number) => Response | "hang" | undefined;
  /** Runs before page N is served (change the catalogue: drift). */
  beforePage?: (page: number) => void;
  attempts = new Map<number, number>();

  constructor(private clock?: Clock) {}

  listingRequests(): SharetribeRequest[] {
    return this.requests.filter((r) => r.url.pathname.endsWith("/listings/query"));
  }

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    this.requests.push({
      url,
      method: (init.method ?? "GET").toUpperCase(),
      body: init.body ? String(init.body) : "",
      headers: new Headers(init.headers),
    });
    if (this.clock && this.latencyMs) this.clock.advance(this.latencyMs);
    if (url.pathname.endsWith("/auth/token")) {
      return this.tokenAnswer
        ? this.tokenAnswer()
        : Response.json({ access_token: this.token, token_type: "bearer", expires_in: 3600 });
    }
    if (url.pathname.endsWith("/marketplace/show")) {
      return Response.json({
        data: { id: { uuid: MARKETPLACE_ID }, type: "marketplace", attributes: { name: "Pools Near Me" } },
      });
    }
    if (url.pathname.endsWith("/listings/query")) {
      const page = Number(url.searchParams.get("page") ?? "1");
      const attempt = (this.attempts.get(page) ?? 0) + 1;
      this.attempts.set(page, attempt);
      const injected = this.answer?.(page, attempt);
      if (injected === "hang") return hang(init.signal);
      if (injected) return injected;
      this.beforePage?.(page);
      const perPage = Number(url.searchParams.get("perPage") ?? "100");
      const total = this.catalog.length;
      const slice = this.catalog.slice((page - 1) * perPage, page * perPage);
      let meta: AnyRec = {
        totalItems: total,
        totalPages: Math.ceil(total / perPage),
        page,
        perPage,
        ...(this.paginationLimit === null ? {} : { paginationLimit: this.paginationLimit }),
      };
      if (this.meta) meta = this.meta(page, meta) ?? meta;
      return Response.json({ data: slice.map(toResource), included: includedFor(slice), meta });
    }
    return new Response("not found", { status: 404 });
  };
}
