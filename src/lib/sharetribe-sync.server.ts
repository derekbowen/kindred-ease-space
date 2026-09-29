// Server-only Sharetribe sync. Uses the service-role Supabase client and (for
// Integration API mode only) the Vault-decrypted secret. Never import from
// client code.
//
// Two auth modes:
//   * "marketplace" (default) — the Sharetribe Marketplace API with a
//     public-read client_credentials grant. Needs only a Client ID, returns
//     only the PUBLISHED listings a marketplace already shows every visitor,
//     and cannot write anything. No secret is stored anywhere.
//   * "integration" (advanced) — the Integration API with Client ID + Secret.
//     The secret grants full read/write access to the marketplace, so it lives
//     in Supabase Vault, we request only published listings, and sparse
//     attributes keep everything but the public fields the mapper reads
//     (title, description, price, publicData, geolocation, state; the author's
//     display name) inside Sharetribe.
//
// A RUN (runSharetribeSyncForWorkspace) is honest about what it read:
//   claim the workspace's lease (one run at a time) → token → page 1..N
//   (perPage=100; each page: hold the lease, then upsert, every row stamped
//   synced_at = the run's start) → only after a COMPLETE snapshot, reconcile
//   (remove this workspace's rows the snapshot did not restamp, in one SQL
//   statement under the lease) → count → finish (release the lease, record
//   the outcome). A snapshot is complete only when Sharetribe's pagination
//   facts are present and consistent from the first page to the last and the
//   distinct listings read equal its totalItems. Anything less is PARTIAL:
//   what was read is kept, nothing is removed, and last_success_at does not
//   move. A confirmed-empty catalogue is removed only on a second empty
//   answer at least 20 minutes after the first.
//
// Every side effect goes through SyncDeps (fetch, clock, sleep, a small db
// interface), so tests drive the real run against a fake Sharetribe and an
// in-memory store with the lease functions' SQL semantics.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { cleanText, listingKeys } from "@/lib/coverage/target";
import { buildListingUrl, resolveRouteConfig } from "@/lib/marketplace/adapter";

export type SharetribeAuthMode = "marketplace" | "integration";

const SHARETRIBE_API = {
  marketplace: {
    authUrl: "https://flex-api.sharetribe.com/v1/auth/token",
    apiBase: "https://flex-api.sharetribe.com/v1/api",
    scope: "public-read",
  },
  integration: {
    authUrl: "https://flex-integ-api.sharetribe.com/v1/auth/token",
    apiBase: "https://flex-integ-api.sharetribe.com/v1/integration_api",
    scope: "integ",
  },
} as const;

/** Listings per page. Sharetribe's page-size parameter is `perPage` (1–100). */
export const LISTINGS_PER_PAGE = 100;

/** Image variants the mapper prefers, in order, requested via sparse attributes. */
const IMAGE_VARIANTS = ["square-small2x", "scaled-large", "default"] as const;

/** Integration API mode: the only listing attributes requested — all public. */
export const INTEGRATION_LISTING_FIELDS = [
  "title",
  "description",
  "price",
  "publicData",
  "geolocation",
  "state",
] as const;

/** Both modes: the only author attribute requested. */
export const AUTHOR_FIELDS = ["profile.displayName"] as const;

type AnyRec = Record<string, any>;
const isRecord = (v: unknown): v is AnyRec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** How far one run may go. Tests shrink these; production uses the defaults. */
export type SyncLimits = {
  perPage: number;
  /** Pages one run reads at most (100 × 100 = 10,000 listings). */
  maxPages: number;
  /** Wall-clock budget for one run's Sharetribe reads (the cron waits 120 s). */
  timeBudgetMs: number;
  /** Per-request timeout. */
  requestTimeoutMs: number;
  /** Tries per request (the first + retries). */
  attempts: number;
  /** A Retry-After longer than this is waited for only this long. */
  maxRetryAfterMs: number;
  /** Pause between pages. */
  pacingMs: number;
  /** Pause between pages once Sharetribe has answered 429 in this run. */
  rateLimitedPacingMs: number;
  leaseSeconds: number;
  /** A second confirmed-empty answer removes the old listings only this long after the first. */
  emptyConfirmAfterMs: number;
};

export const SYNC_LIMITS: SyncLimits = {
  perPage: LISTINGS_PER_PAGE,
  maxPages: 100,
  timeBudgetMs: 90_000,
  requestTimeoutMs: 20_000,
  attempts: 3,
  maxRetryAfterMs: 10_000,
  pacingMs: 250,
  rateLimitedPacingMs: 1_100,
  leaseSeconds: 300,
  emptyConfirmAfterMs: 20 * 60_000,
};

// ---------------------------------------------------------------------------
// Errors and customer sentences
// ---------------------------------------------------------------------------

/**
 * Error raised by any Sharetribe HTTP step. `kind` + `status` drive the
 * friendly message shown to customers; `message` keeps the machine-readable
 * `<step>:<status>:<snippet>` form for logs.
 */
export class SharetribeApiError extends Error {
  kind: "auth" | "network" | "api";
  status?: number;
  constructor(kind: "auth" | "network" | "api", message: string, status?: number) {
    super(message);
    this.name = "SharetribeApiError";
    this.kind = kind;
    this.status = status;
  }
}

export const SHARETRIBE_UNAVAILABLE_MESSAGE =
  "Sharetribe is not answering right now. Try again in a minute.";

/**
 * Map any error thrown by the connect/sync flow to a sentence a marketplace
 * owner can act on. Raw `auth_failed:400:Bad request` strings never reach the
 * UI or the `last_sync_error` column.
 */
export function friendlySharetribeError(err: unknown, mode: SharetribeAuthMode): string {
  if (err instanceof SharetribeApiError) {
    if (err.kind === "network" || (err.status != null && err.status >= 500)) {
      return SHARETRIBE_UNAVAILABLE_MESSAGE;
    }
    if (err.kind === "auth") {
      return mode === "marketplace"
        ? "Sharetribe didn't accept that Client ID. Copy the Client ID of a Marketplace API application from Console → Build → Applications."
        : "Sharetribe didn't accept that Client ID and Secret. Copy the Client ID and Client Secret of an Integration API application from Console → Build → Applications.";
    }
    if (err.status === 401 || err.status === 403) {
      return mode === "marketplace"
        ? "Sharetribe rejected the connection. Check that the Client ID belongs to a Marketplace API application for this marketplace."
        : "Sharetribe rejected the connection. Check that the Client ID and Secret belong to an Integration API application for this marketplace.";
    }
    return `Sharetribe returned an unexpected response${err.status ? ` (HTTP ${err.status})` : ""}. Try again, and contact support if it keeps happening.`;
  }
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (message === "integration_not_found") return "Sharetribe is not connected for this workspace.";
  if (message.startsWith("secret_decrypt_failed")) {
    return "We couldn't read the stored Integration API secret. Reconnect Sharetribe to fix this.";
  }
  if (message.startsWith("upsert_failed") || message.startsWith("integration_lookup_failed")) {
    return "We couldn't save the synced listings. Try again in a minute.";
  }
  return "The sync failed unexpectedly. Try again, and contact support if it keeps happening.";
}

const fmt = (n: number) => n.toLocaleString("en-US");
const listingsWord = (n: number) => `${fmt(n)} listing${n === 1 ? "" : "s"}`;

/** Why a run did not read a complete snapshot. */
export type IncompleteReason =
  | "missing_pagination"
  | "count_changed"
  | "count_mismatch"
  | "pagination_limit"
  | "page_cap"
  | "time_budget"
  | "upstream_error"
  | "save_failed"
  | "reconcile_failed"
  | "malformed_response"
  | "lease_lost";

export const SYNC_SENTENCES = {
  notConnected: "Sharetribe is not connected for this workspace.",
  alreadyRunning:
    "A sync is already running for this marketplace. Its progress is shown on the Sharetribe page.",
  cantRead: "We couldn't read your Sharetribe connection. Try again in a minute.",
  cantStart: "We couldn't start the sync. Try again in a minute.",
  emptyBoth:
    "Sharetribe reports no published listings on your marketplace, and none are stored here.",
  emptyFirst:
    "Sharetribe returned no published listings, so we kept your last synced listings. If none are published, a sync 20 or more minutes from now removes them.",
  leaseLost:
    "This sync stopped because another sync took over or Sharetribe was disconnected. Nothing was removed.",
} as const;

/** "Synced 2,500 listings." / "… and removed 20 that are no longer published." */
export function successSentence(upserted: number, removed: number): string {
  return `Synced ${listingsWord(upserted)}${removed ? ` and removed ${fmt(removed)} that ${removed === 1 ? "is" : "are"} no longer published.` : "."}`;
}

export function emptyConfirmedSentence(removed: number): string {
  return `Sharetribe again returned no published listings, so ${listingsWord(removed)} that ${removed === 1 ? "is" : "are"} no longer published ${removed === 1 ? "was" : "were"} removed.`;
}

/** The partial-run sentence: why, what was kept, and that nothing was removed. */
export function partialSentence(
  reason: IncompleteReason,
  saved: number,
  total: number | null,
): string {
  const kept = `We kept the ${listingsWord(saved)} we read and removed nothing`;
  const ofTotal =
    total !== null && total > 0 ? `${fmt(saved)} of ${fmt(total)} listings` : listingsWord(saved);
  switch (reason) {
    case "missing_pagination":
      return `Sharetribe didn't say how many listings there are. ${kept}; the next sync continues.`;
    case "count_changed":
    case "count_mismatch":
      return `Your listings changed while we were reading them. ${kept}; the next sync continues.`;
    case "pagination_limit":
    case "page_cap":
      return `Your marketplace has more listings than one sync can read. ${kept}; the next sync continues.`;
    case "time_budget":
      return `The sync ran out of time after ${ofTotal}. We kept them and removed nothing; the next sync continues.`;
    case "upstream_error":
      return `Sharetribe stopped answering after ${ofTotal}. We kept them and removed nothing; the next sync continues.`;
    case "save_failed":
      return `We couldn't save every listing. We kept the ${listingsWord(saved)} we saved and removed nothing; the next sync continues.`;
    case "reconcile_failed":
      return `We updated ${listingsWord(saved)} but couldn't remove the ones that are no longer published. The next sync continues.`;
    case "malformed_response":
      return `Sharetribe sent a page we couldn't read. ${kept}; the next sync continues.`;
    case "lease_lost":
      return SYNC_SENTENCES.leaseLost;
  }
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

/** Token request for either API. Marketplace mode never sends a secret. */
export function buildTokenRequest(
  mode: SharetribeAuthMode,
  clientId: string,
  clientSecret?: string,
): { url: string; body: URLSearchParams } {
  const api = SHARETRIBE_API[mode];
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "client_credentials",
    scope: api.scope,
  });
  if (mode === "integration") {
    if (!clientSecret) throw new SharetribeApiError("auth", "auth_failed:missing_secret");
    body.set("client_secret", clientSecret);
  }
  return { url: api.authUrl, body };
}

export function buildMarketplaceShowUrl(mode: SharetribeAuthMode): string {
  return `${SHARETRIBE_API[mode].apiBase}/marketplace/show`;
}

/**
 * Listings query for one page. Both APIs share the JSON:API shape, so the
 * same mapper reads both responses. The Marketplace API only ever returns
 * published (public) listings; the Integration API is told the same
 * explicitly, and sparse attributes keep private and protected data out of
 * the response (relationships are unaffected by sparse attributes).
 */
export function buildListingsQueryUrl(
  mode: SharetribeAuthMode,
  page: number,
  perPage: number = LISTINGS_PER_PAGE,
): string {
  const params = new URLSearchParams({
    perPage: String(Math.min(Math.max(1, Math.floor(perPage)), LISTINGS_PER_PAGE)),
    page: String(page),
    include: "author,images",
  });
  params.set("fields.image", IMAGE_VARIANTS.map((v) => `variants.${v}`).join(","));
  params.set("fields.user", AUTHOR_FIELDS.join(","));
  if (mode === "integration") {
    params.set("states", "published");
    params.set("fields.listing", INTEGRATION_LISTING_FIELDS.join(","));
  }
  return `${SHARETRIBE_API[mode].apiBase}/listings/query?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// HTTP: per-request timeout, bounded retries, Retry-After, a run deadline
// ---------------------------------------------------------------------------

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type HttpDeps = {
  fetch: FetchFn;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

/** Late-bound, so a test that swaps globalThis.fetch/setTimeout is honoured. */
export const defaultHttpDeps = (): HttpDeps => ({
  fetch: (input, init) => globalThis.fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
});

export type RetryPolicy = {
  attempts: number;
  timeoutMs: number;
  maxRetryAfterMs: number;
  /** http.now() after which no new attempt or wait starts. */
  deadline?: number;
  onRateLimited?: () => void;
};

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: SYNC_LIMITS.attempts,
  timeoutMs: SYNC_LIMITS.requestTimeoutMs,
  maxRetryAfterMs: SYNC_LIMITS.maxRetryAfterMs,
};

const BACKOFF_MS = [1_000, 3_000];

/** A Retry-After header (delta-seconds or an HTTP date) in ms, or null. */
export function retryAfterMs(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const s = value.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const at = Date.parse(s);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

function errorName(e: unknown): string {
  if (e instanceof Error)
    return e.name === "TimeoutError" || e.name === "AbortError" ? "timeout" : e.name;
  return "unknown";
}

/**
 * GET/POST with a per-request timeout (AbortSignal.timeout), at most
 * `attempts` tries, retrying 429/5xx and network errors. A Retry-After is
 * honoured (capped at maxRetryAfterMs); otherwise 1 s then 3 s. Nothing
 * starts after the deadline. The last 429/5xx response is returned to the
 * caller; a network failure on every try throws a "network" error.
 */
export async function fetchWithRetry(
  http: HttpDeps,
  url: string,
  init: RequestInit,
  policy: RetryPolicy = DEFAULT_RETRY,
): Promise<Response> {
  const attempts = Math.max(1, Math.floor(policy.attempts));
  const fits = (wait: number) =>
    policy.deadline === undefined || http.now() + wait < policy.deadline;
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    const remaining = policy.deadline === undefined ? Infinity : policy.deadline - http.now();
    if (remaining <= 0) break;
    const timeoutMs = Math.min(policy.timeoutMs, Math.max(remaining, 250));
    let res: Response;
    try {
      res = await http.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      lastErr = e;
      const wait = BACKOFF_MS[i] ?? 3_000;
      if (i < attempts - 1 && fits(wait)) {
        await http.sleep(wait);
        continue;
      }
      break;
    }
    const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
    if (!retryable || i === attempts - 1) return res;
    if (res.status === 429) policy.onRateLimited?.();
    const hinted = retryAfterMs(res.headers.get("retry-after"), http.now());
    const wait =
      hinted === null ? (BACKOFF_MS[i] ?? 3_000) : Math.min(hinted, policy.maxRetryAfterMs);
    if (!fits(wait)) return res;
    await res.body?.cancel().catch(() => {});
    await http.sleep(wait);
  }
  throw new SharetribeApiError(
    "network",
    `network_failure:${lastErr ? errorName(lastErr) : "deadline"}`,
  );
}

async function getAccessToken(
  http: HttpDeps,
  policy: RetryPolicy,
  mode: SharetribeAuthMode,
  clientId: string,
  clientSecret?: string,
): Promise<string> {
  const { url, body } = buildTokenRequest(mode, clientId, clientSecret);
  const res = await fetchWithRetry(
    http,
    url,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
    policy,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new SharetribeApiError(
      res.status === 400 || res.status === 401 ? "auth" : "api",
      `auth_failed:${res.status}:${text.slice(0, 200)}`,
      res.status,
    );
  }
  const json = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
  if (!json || typeof json.access_token !== "string" || !json.access_token) {
    throw new SharetribeApiError("auth", "auth_failed:no_token");
  }
  return json.access_token;
}

async function showMarketplace(
  http: HttpDeps,
  policy: RetryPolicy,
  mode: SharetribeAuthMode,
  token: string,
): Promise<{ id: string; name?: string }> {
  const res = await fetchWithRetry(
    http,
    buildMarketplaceShowUrl(mode),
    { method: "GET", headers: { Authorization: `Bearer ${token}` } },
    policy,
  );
  if (!res.ok) {
    throw new SharetribeApiError("api", `marketplace_show_failed:${res.status}`, res.status);
  }
  const json = (await res.json().catch(() => null)) as AnyRec | null;
  const id = json?.data?.id?.uuid ?? json?.data?.id;
  if (typeof id !== "string" || !id)
    throw new SharetribeApiError("api", "marketplace_show_failed:no_id");
  const name = json?.data?.attributes?.name;
  return {
    id,
    name: typeof name === "string" && name.trim() ? name.trim().slice(0, 200) : undefined,
  };
}

/**
 * Validate credentials against the right API and resolve the marketplace's
 * identity (id + name from marketplace/show). Proves the Client ID works —
 * NOT that the caller owns any domain; domain verification is separate.
 */
export async function validateSharetribeCredentials(
  opts: { mode: SharetribeAuthMode; clientId: string; clientSecret?: string },
  http: HttpDeps = defaultHttpDeps(),
): Promise<{ ok: true; marketplaceId: string; name?: string } | { ok: false; error: string }> {
  try {
    const token = await getAccessToken(
      http,
      DEFAULT_RETRY,
      opts.mode,
      opts.clientId,
      opts.clientSecret,
    );
    const mp = await showMarketplace(http, DEFAULT_RETRY, opts.mode, token);
    return { ok: true, marketplaceId: mp.id, name: mp.name };
  } catch (e) {
    console.error("[sharetribe-validate] failed", e instanceof Error ? e.message : e);
    return { ok: false, error: friendlySharetribeError(e, opts.mode) };
  }
}

// ---------------------------------------------------------------------------
// Reading a listing's public fields — stated values only, never guessed
// ---------------------------------------------------------------------------

const LISTING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Sharetribe ids are UUIDs; tenant_listings stores them in uuid columns. */
export const isListingId = (v: unknown): v is string =>
  typeof v === "string" && LISTING_ID_RE.test(v);

function jsonApiId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "uuid" in value) {
    const u = (value as { uuid?: unknown }).uuid;
    return typeof u === "string" ? u : undefined;
  }
  return undefined;
}

/** A place name as the listing states it: a short string with a letter in it. */
export function placeName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = cleanText(v);
  if (!s || s.length > 120) return null;
  if (!/\p{L}/u.test(s)) return null;
  if (/[<>{}[\]\\]|https?:|www\./i.test(s)) return null;
  return s;
}

type AddressPart = { long: unknown; short: unknown; types: string[] };

/** Google/Mapbox-style address components: [{ long_name, short_name, types }]. */
function addressComponents(v: unknown): AddressPart[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isRecord).map((c) => ({
    long: c.long_name ?? c.longText ?? c.long,
    short: c.short_name ?? c.shortText ?? c.short,
    types: Array.isArray(c.types)
      ? c.types.filter((t: unknown): t is string => typeof t === "string")
      : [],
  }));
}

export type ListingPlace = { city: string | null; state: string | null; country: string | null };

function placeFromComponents(parts: AddressPart[]): Partial<ListingPlace> {
  const find = (...types: string[]) => parts.find((p) => types.some((t) => p.types.includes(t)));
  const city = find("locality", "postal_town");
  const region = find("administrative_area_level_1");
  const country = find("country");
  return {
    city: placeName(city?.long) ?? placeName(city?.short),
    state: placeName(region?.short) ?? placeName(region?.long),
    country: placeName(country?.short) ?? placeName(country?.long),
  };
}

/** A structured address object ({ city, state, country } and common synonyms). */
function placeFromAddressObject(v: unknown): Partial<ListingPlace> {
  if (!isRecord(v)) return {};
  return {
    city: placeName(v.city) ?? placeName(v.locality) ?? placeName(v.town),
    state:
      placeName(v.state) ??
      placeName(v.region) ??
      placeName(v.province) ??
      placeName(v.administrativeArea),
    country: placeName(v.country) ?? placeName(v.countryCode),
  };
}

/**
 * The listing's city / state / country from its public data, in order:
 * publicData.{city,state,country}; publicData.location.{city,state,country};
 * a structured address object (publicData.address or publicData.location.address);
 * address components (publicData[.location].addressComponents). A free-form
 * address STRING is never parsed — that would be guessing. Unstated → null,
 * and the coverage screen reports the listing as unplaced.
 */
export function readListingPlace(pub: unknown): ListingPlace {
  const p = isRecord(pub) ? pub : {};
  const loc = isRecord(p.location) ? p.location : {};
  const sources: Array<Partial<ListingPlace>> = [
    { city: placeName(p.city), state: placeName(p.state), country: placeName(p.country) },
    { city: placeName(loc.city), state: placeName(loc.state), country: placeName(loc.country) },
    placeFromAddressObject(p.address),
    placeFromAddressObject(loc.address),
    placeFromComponents(addressComponents(p.addressComponents ?? p.address_components)),
    placeFromComponents(addressComponents(loc.addressComponents ?? loc.address_components)),
  ];
  const pick = (k: keyof ListingPlace) => {
    for (const s of sources) if (s[k]) return s[k] as string;
    return null;
  };
  return { city: pick("city"), state: pick("state"), country: pick("country") };
}

/** A category value: a short string, a one-value list, or an object with a string id. */
export function categoryName(v: unknown): string | null {
  if (typeof v === "string") {
    const s = cleanText(v);
    if (!s || s.length > 100) return null;
    if (!/[\p{L}\p{N}]/u.test(s)) return null;
    if (/[<>{}[\]\\]|https?:/i.test(s)) return null;
    return s;
  }
  if (Array.isArray(v)) {
    const values = [
      ...new Set(
        v
          .filter((x) => typeof x === "string")
          .map(categoryName)
          .filter(Boolean),
      ),
    ];
    return values.length === 1 ? (values[0] as string) : null; // several categories: not ours to pick
  }
  if (isRecord(v) && typeof v.id === "string") return categoryName(v.id);
  return null;
}

/**
 * The listing's category: publicData.category, else the top level of
 * Sharetribe's nested listing categories (publicData.categoryLevel1). Never
 * invented; unmapped → null.
 */
export function readListingCategory(pub: unknown): string | null {
  const p = isRecord(pub) ? pub : {};
  return categoryName(p.category) ?? categoryName(p.categoryLevel1);
}

/** Sharetribe's pricing unit (publicData.unitType), lowercase — or null. */
export function readPriceUnit(pub: unknown): string | null {
  const v = isRecord(pub) ? pub.unitType : undefined;
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,39}$/.test(s) ? s : null;
}

function slugify(s: string | undefined | null): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function buildJsonLd(args: {
  title: string;
  description: string | null;
  images: string[];
  marketplaceUrl: string;
  price?: number | null;
  currency?: string | null;
  city?: string | null;
  state?: string | null;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: args.title,
    description: args.description ?? undefined,
    image: args.images.length ? args.images : undefined,
    url: args.marketplaceUrl,
    offers:
      args.price != null && args.currency
        ? {
            "@type": "Offer",
            price: (args.price / 100).toFixed(2),
            priceCurrency: args.currency,
            availability: "https://schema.org/InStock",
            url: args.marketplaceUrl,
          }
        : undefined,
    areaServed:
      args.city || args.state
        ? { "@type": "Place", name: [args.city, args.state].filter(Boolean).join(", ") }
        : undefined,
  };
}

export type ListingRow = ReturnType<typeof mapListing>;

/**
 * Map one JSON:API listing (Marketplace or Integration API — same shape) to a
 * tenant_listings row. Only publicData/metadata are kept; private data never
 * reaches the database. The Marketplace API returns published listings only,
 * so that mode marks every row published. Every row carries the run's
 * synced_at (reconcile removes rows a complete snapshot did not restamp), the
 * comparison keys from src/lib/coverage/target.ts (the ONE normalization) and
 * the pricing unit.
 */
export function mapListing(
  workspaceId: string,
  marketplaceUrl: string,
  raw: AnyRec,
  included: AnyRec[],
  opts: { mode: SharetribeAuthMode; syncedAt?: string; routeConfig?: unknown } = {
    mode: "integration",
  },
) {
  const id = jsonApiId(raw?.id) as string;
  const a: AnyRec = isRecord(raw?.attributes) ? raw.attributes : {};
  const amount = a?.price?.amount;
  const price = typeof amount === "number" && Number.isSafeInteger(amount) ? amount : null;
  const rawCurrency = a?.price?.currency;
  const currency =
    typeof rawCurrency === "string" && /^[A-Za-z]{3}$/.test(rawCurrency.trim())
      ? rawCurrency.trim().toUpperCase()
      : null;
  const geo: AnyRec = isRecord(a?.geolocation) ? a.geolocation : {};
  const latitude = typeof geo.lat === "number" && Math.abs(geo.lat) <= 90 ? geo.lat : null;
  const longitude = typeof geo.lng === "number" && Math.abs(geo.lng) <= 180 ? geo.lng : null;
  const pub: AnyRec = isRecord(a?.publicData) ? a.publicData : {};
  const meta: AnyRec = isRecord(a?.metadata) ? a.metadata : {};
  const state = a?.state as string | undefined;
  const title = (typeof a.title === "string" && cleanText(a.title)) || "Untitled";

  // Images via the included relationships, preferred variant first.
  const imgRels: AnyRec[] = Array.isArray(raw?.relationships?.images?.data)
    ? raw.relationships.images.data
    : [];
  const images = imgRels
    .map((rel) => {
      const relId = jsonApiId(rel?.id);
      return included.find((x) => x?.type === "image" && jsonApiId(x.id) === relId);
    })
    .filter((img): img is AnyRec => isRecord(img))
    .map((img) => {
      const variants: AnyRec = img?.attributes?.variants ?? {};
      const best =
        variants["square-small2x"] ||
        variants["scaled-large"] ||
        variants["default"] ||
        Object.values(variants)[0];
      return best &&
        typeof (best as AnyRec).url === "string" &&
        /^https?:\/\//.test((best as AnyRec).url)
        ? {
            url: (best as AnyRec).url as string,
            width: typeof (best as AnyRec).width === "number" ? (best as AnyRec).width : null,
            height: typeof (best as AnyRec).height === "number" ? (best as AnyRec).height : null,
            alt: title,
          }
        : null;
    })
    .filter(Boolean) as Array<{
    url: string;
    width: number | null;
    height: number | null;
    alt: string;
  }>;

  // Author: the display name only.
  const authorId = jsonApiId(raw?.relationships?.author?.data?.id);
  const author = authorId
    ? included.find((x) => x?.type === "user" && jsonApiId(x.id) === authorId)
    : null;
  const displayName = author?.attributes?.profile?.displayName;
  const authorName =
    typeof displayName === "string" ? (cleanText(displayName)?.slice(0, 120) ?? null) : null;

  const slug = slugify(title) || id;
  const route = resolveRouteConfig(marketplaceUrl, opts.routeConfig);
  const listingUrl =
    buildListingUrl(route, { sharetribe_listing_id: id, slug }) ??
    `${marketplaceUrl.replace(/\/+$/, "")}/l/${slug}/${id}`;

  const place = readListingPlace(pub);
  const listingCategory = readListingCategory(pub);
  const keys = listingKeys({
    country: place.country,
    state: place.state,
    city: place.city,
    category: listingCategory,
  });

  return {
    workspace_id: workspaceId,
    sharetribe_listing_id: id,
    title,
    slug,
    description: typeof a.description === "string" ? a.description : null,
    price_amount: price,
    price_currency: currency,
    price_unit: readPriceUnit(pub),
    city: place.city,
    state: place.state,
    country: place.country,
    country_key: keys.countryKey,
    region_key: keys.regionKey,
    city_key: keys.cityKey,
    category_key: keys.categoryKey,
    lat: latitude,
    lng: longitude,
    category: listingCategory,
    custom_fields: { publicData: pub, metadata: meta },
    images,
    author_id: isListingId(authorId) ? authorId : null,
    author_name: authorName,
    marketplace_url: listingUrl,
    structured_data: buildJsonLd({
      title,
      description: typeof a.description === "string" ? a.description : null,
      images: images.map((i) => i.url),
      marketplaceUrl: listingUrl,
      price,
      currency,
      city: place.city,
      state: place.state,
    }),
    state_published: opts.mode === "marketplace" ? true : state === "published",
    synced_at: opts.syncedAt ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pagination facts
// ---------------------------------------------------------------------------

export type PageMeta = {
  totalItems: number | null;
  totalPages: number | null;
  page: number | null;
  paginationLimit: number | null;
  unsupported: boolean;
};

const nonNegInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

export function readPageMeta(meta: unknown): PageMeta {
  const m = isRecord(meta) ? meta : {};
  const limit = nonNegInt(m.paginationLimit);
  return {
    totalItems: nonNegInt(m.totalItems),
    totalPages: nonNegInt(m.totalPages),
    page: nonNegInt(m.page),
    paginationLimit: limit && limit > 0 ? limit : null,
    unsupported: m.paginationUnsupported === true,
  };
}

/** Does this page say, consistently, how many listings and pages there are? */
export function pageMetaUsable(m: PageMeta, requestedPage: number): boolean {
  if (m.unsupported || m.totalItems === null || m.totalPages === null) return false;
  if (m.page !== null && m.page !== requestedPage) return false;
  if (m.totalItems === 0) return m.totalPages <= 1;
  return m.totalPages >= 1;
}

// ---------------------------------------------------------------------------
// The store the run writes to (Supabase in production; memory in tests)
// ---------------------------------------------------------------------------

export type SyncIntegration = {
  id: string;
  workspace_id: string;
  status: string | null;
  marketplace_url: string;
  client_id: string;
  auth_mode: string | null;
  route_config?: unknown;
  sync_state?: unknown;
};

export type LeaseFunction =
  | "claim_listing_sync"
  | "touch_listing_sync"
  | "reconcile_listing_sync"
  | "finish_listing_sync";

/** Every write and read the run makes. Each method THROWS on a store error. */
export type SyncDb = {
  loadIntegration(workspaceId: string): Promise<SyncIntegration | null>;
  /** The Vault-decrypted Integration API secret, or null when none is stored. */
  readSecret(workspaceId: string): Promise<string | null>;
  /** Upsert on (workspace_id, sharetribe_listing_id). */
  upsertListings(rows: ListingRow[]): Promise<void>;
  /** One of the four lease functions (migration 20260929000100). */
  rpc(fn: LeaseFunction, args: Record<string, unknown>): Promise<unknown>;
  /** Exact number of this workspace's published listings. */
  countListings(workspaceId: string): Promise<number>;
  /** Delete every listing of this workspace. */
  deleteListings(workspaceId: string): Promise<void>;
  /** Connected/pending workspaces, for the bounded "all" mode. */
  listSyncCandidates(): Promise<Array<{ workspace_id: string; last_sync_at: string | null }>>;
};

const INTEGRATION_COLUMNS =
  "id, workspace_id, status, marketplace_url, client_id, auth_mode, route_config, sync_state";

export function supabaseSyncDb(): SyncDb {
  const sb = () => supabaseAdmin as any;
  return {
    async loadIntegration(workspaceId) {
      const { data, error } = await sb()
        .from("tenant_integrations")
        .select(INTEGRATION_COLUMNS)
        .eq("workspace_id", workspaceId)
        .eq("provider", "sharetribe")
        .maybeSingle();
      if (error) throw new Error(`integration_lookup_failed:${error.message}`);
      return (data ?? null) as SyncIntegration | null;
    },
    async readSecret(workspaceId) {
      const { data, error } = await sb().rpc("tenant_get_integration_secret", {
        _workspace_id: workspaceId,
      });
      if (error) throw new Error(`secret_decrypt_failed:${error.message}`);
      return typeof data === "string" && data ? data : null;
    },
    async upsertListings(rows) {
      const { error } = await sb()
        .from("tenant_listings")
        .upsert(rows, { onConflict: "workspace_id,sharetribe_listing_id" });
      if (error) throw new Error(`upsert_failed:${error.message}`);
    },
    async rpc(fn, args) {
      const { data, error } = await sb().rpc(fn, args);
      if (error) throw new Error(`${fn}_failed:${error.message}`);
      return data;
    },
    async countListings(workspaceId) {
      const { count, error } = await sb()
        .from("tenant_listings")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("state_published", true);
      if (error) throw new Error(`listing_count_failed:${error.message}`);
      if (typeof count !== "number") throw new Error("listing_count_failed:no_count");
      return count;
    },
    async deleteListings(workspaceId) {
      const { error } = await sb().from("tenant_listings").delete().eq("workspace_id", workspaceId);
      if (error) throw new Error(`listing_delete_failed:${error.message}`);
    },
    async listSyncCandidates() {
      const { data, error } = await sb()
        .from("tenant_integrations")
        .select("workspace_id, last_sync_at")
        .eq("provider", "sharetribe")
        .in("status", ["connected", "pending"]);
      if (error) throw new Error(`candidate_read_failed:${error.message}`);
      return (data ?? []) as Array<{ workspace_id: string; last_sync_at: string | null }>;
    },
  };
}

export type SyncDeps = HttpDeps & { db: SyncDb; newRunId: () => string; limits: SyncLimits };
export type SyncOverrides = Partial<Omit<SyncDeps, "limits">> & { limits?: Partial<SyncLimits> };

export function resolveSyncDeps(o: SyncOverrides = {}): SyncDeps {
  const http = defaultHttpDeps();
  return {
    fetch: o.fetch ?? http.fetch,
    sleep: o.sleep ?? http.sleep,
    now: o.now ?? http.now,
    db: o.db ?? supabaseSyncDb(),
    newRunId: o.newRunId ?? (() => crypto.randomUUID()),
    limits: { ...SYNC_LIMITS, ...(o.limits ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

export type SyncStatus = "success" | "partial" | "warning" | "failed";

export type SyncRunResult = {
  status: SyncStatus | "already_running" | "not_connected";
  /** A customer sentence for the outcome (also stored as last_sync_error unless success). */
  sentence: string;
  reason: IncompleteReason | null;
  upserted: number;
  removed: number;
  /** Exact published listings after the run, or null when not counted. */
  listingsCount: number | null;
  /** Sharetribe's totalItems on page 1, or null when it did not say. */
  upstreamTotal: number | null;
  pagesRead: number;
  runId: string | null;
  /** finish_listing_sync recorded the outcome (false: lease lost, or not claimed). */
  recorded: boolean;
  /** The integration row was gone at the end, so this run's listings were deleted. */
  cleanedUp: boolean;
};

type EmptyState = { empty_strikes: number; first_empty_at: string | null };

function readSyncState(v: unknown): AnyRec & EmptyState {
  const s = isRecord(v) ? v : {};
  const strikes = nonNegInt(s.empty_strikes) ?? 0;
  const first =
    typeof s.first_empty_at === "string" && Number.isFinite(Date.parse(s.first_empty_at))
      ? s.first_empty_at
      : null;
  return { ...s, empty_strikes: strikes, first_empty_at: first };
}

function isAuthFailure(e: unknown): boolean {
  if (e instanceof SharetribeApiError)
    return e.kind === "auth" || e.status === 401 || e.status === 403;
  return e instanceof Error && e.message === "secret_decrypt_failed:missing";
}

const modeOf = (authMode: string | null | undefined): SharetribeAuthMode =>
  // Rows created before auth_mode existed are Integration API connections.
  authMode === "marketplace" ? "marketplace" : "integration";

function base(runId: string | null): Omit<SyncRunResult, "status" | "sentence"> {
  return {
    reason: null,
    upserted: 0,
    removed: 0,
    listingsCount: null,
    upstreamTotal: null,
    pagesRead: 0,
    runId,
    recorded: false,
    cleanedUp: false,
  };
}

/** Run a sync for one workspace. Never throws: every outcome — including
 *  "another run holds the lease" (no writes at all) — comes back as a
 *  SyncRunResult, and every claimed run ends in finish_listing_sync. */
export async function runSharetribeSyncForWorkspace(
  workspaceId: string,
  overrides: SyncOverrides = {},
): Promise<SyncRunResult> {
  const deps = resolveSyncDeps(overrides);
  const { db, limits } = deps;
  const t0 = deps.now();

  let integration: SyncIntegration | null;
  try {
    integration = await db.loadIntegration(workspaceId);
  } catch (e) {
    console.error(
      "[sharetribe-sync] integration read failed",
      workspaceId,
      e instanceof Error ? e.message : e,
    );
    return { ...base(null), status: "failed", sentence: SYNC_SENTENCES.cantRead };
  }
  if (!integration)
    return { ...base(null), status: "not_connected", sentence: SYNC_SENTENCES.notConnected };

  const mode = modeOf(integration.auth_mode);
  const runId = deps.newRunId();
  let claimed = false;
  try {
    claimed =
      (await db.rpc("claim_listing_sync", {
        _workspace_id: workspaceId,
        _run_id: runId,
        _lease_seconds: limits.leaseSeconds,
      })) === true;
  } catch (e) {
    console.error(
      "[sharetribe-sync] claim failed",
      workspaceId,
      e instanceof Error ? e.message : e,
    );
    return { ...base(null), status: "failed", sentence: SYNC_SENTENCES.cantStart };
  }
  if (!claimed) {
    return { ...base(null), status: "already_running", sentence: SYNC_SENTENCES.alreadyRunning };
  }

  const runStartedAt = new Date(deps.now()).toISOString();
  const deadline = t0 + limits.timeBudgetMs;
  const prevState = readSyncState(integration.sync_state);
  let pacing = limits.pacingMs;
  const policy: RetryPolicy = {
    attempts: limits.attempts,
    timeoutMs: limits.requestTimeoutMs,
    maxRetryAfterMs: limits.maxRetryAfterMs,
    deadline,
    onRateLimited: () => {
      pacing = Math.max(pacing, limits.rateLimitedPacingMs);
    },
  };

  const seen = new Set<string>();
  /** Distinct listings written (a listing read twice under offset drift counts once). */
  const saved = new Set<string>();
  let totalItems: number | null = null;
  let lastTotalPages: number | null = null;
  let paginationLimit: number | null = null;
  let pagesRead = 0;
  let upserted = 0;
  let removed = 0;
  let reason: IncompleteReason | null = null;
  let leaseLost = false;
  let confirmedEmpty = false;
  let tokenOk = false;
  let status: SyncStatus = "failed";
  let sentence = "";
  let syncState: AnyRec | null = null;
  let connectionStatus: string | null = null;

  const progress = (phase: string, page: number) => ({
    phase,
    page,
    pages: lastTotalPages,
    fetched: seen.size,
    saved: upserted,
    total: totalItems,
    started_at: runStartedAt,
  });

  /** Removed-row count; -1 = lease lost (nothing removed); null = the call failed. */
  const reconcile = async (): Promise<number | null> => {
    try {
      const n = await db.rpc("reconcile_listing_sync", {
        _workspace_id: workspaceId,
        _run_id: runId,
        _run_started_at: runStartedAt,
      });
      const v = typeof n === "number" ? n : Number(n);
      return Number.isInteger(v) ? v : null;
    } catch (e) {
      console.error(
        "[sharetribe-sync] reconcile failed",
        workspaceId,
        e instanceof Error ? e.message : e,
      );
      return null;
    }
  };

  try {
    let clientSecret: string | undefined;
    if (mode === "integration") {
      // Marketplace mode never touches Vault — there is no secret to read.
      const secret = await db.readSecret(workspaceId);
      if (!secret) throw new Error("secret_decrypt_failed:missing");
      clientSecret = secret;
    }
    const token = await getAccessToken(deps, policy, mode, integration.client_id, clientSecret);
    tokenOk = true;

    for (let page = 1; ; page++) {
      if (page > limits.maxPages) {
        reason ??= "page_cap";
        break;
      }
      if (deps.now() >= deadline) {
        reason ??= "time_budget";
        break;
      }
      if (page > 1 && pacing > 0) await deps.sleep(pacing);

      let json: AnyRec | null;
      try {
        const res = await fetchWithRetry(
          deps,
          buildListingsQueryUrl(mode, page, limits.perPage),
          { method: "GET", headers: { Authorization: `Bearer ${token}` } },
          policy,
        );
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new SharetribeApiError(
            "api",
            `listings_query_failed:${res.status}:${text.slice(0, 200)}`,
            res.status,
          );
        }
        json = (await res.json().catch(() => null)) as AnyRec | null;
      } catch (e) {
        if (pagesRead === 0) throw e; // nothing read, nothing written: the run failed
        console.error(
          "[sharetribe-sync] page failed",
          workspaceId,
          page,
          e instanceof Error ? e.message : e,
        );
        reason ??=
          e instanceof SharetribeApiError && e.kind === "network" && deps.now() >= deadline
            ? "time_budget"
            : "upstream_error";
        break;
      }

      const data = Array.isArray(json?.data) ? (json!.data as AnyRec[]) : null;
      if (!data) {
        if (pagesRead === 0)
          throw new SharetribeApiError("api", "listings_query_failed:malformed", 200);
        reason ??= "malformed_response";
        break;
      }
      const included = Array.isArray(json?.included) ? (json!.included as AnyRec[]) : [];
      const meta = readPageMeta(json?.meta);
      const usable = pageMetaUsable(meta, page);
      if (page === 1) {
        if (usable) {
          totalItems = meta.totalItems;
          lastTotalPages = meta.totalPages;
          paginationLimit = meta.paginationLimit;
        } else {
          reason ??= "missing_pagination";
        }
      } else if (!usable) {
        reason ??= "missing_pagination";
      } else {
        // Offset drift: the catalogue changed between pages.
        if (meta.totalItems !== totalItems) reason ??= "count_changed";
        lastTotalPages = meta.totalPages;
        if (meta.paginationLimit !== null) paginationLimit = meta.paginationLimit;
      }

      if (page === 1 && usable && totalItems === 0) {
        if (data.length === 0) {
          confirmedEmpty = true;
          pagesRead = 1;
          break;
        }
        reason ??= "count_mismatch"; // "no listings" — with listings attached
      }

      const rows = new Map<string, ListingRow>();
      for (const raw of data) {
        const row = mapListing(workspaceId, integration.marketplace_url, raw, included, {
          mode,
          syncedAt: runStartedAt,
          routeConfig: integration.route_config,
        });
        if (isListingId(row.sharetribe_listing_id)) rows.set(row.sharetribe_listing_id, row);
      }
      for (const id of rows.keys()) seen.add(id);

      // Hold the lease BEFORE writing: a run that lost it (another run took
      // over, or the connection was removed) stops here, having written nothing.
      let held: boolean;
      try {
        held =
          (await db.rpc("touch_listing_sync", {
            _workspace_id: workspaceId,
            _run_id: runId,
            _progress: progress("reading", page),
            _lease_seconds: limits.leaseSeconds,
          })) === true;
      } catch (e) {
        if (pagesRead === 0) throw e;
        console.error(
          "[sharetribe-sync] touch failed",
          workspaceId,
          e instanceof Error ? e.message : e,
        );
        reason ??= "save_failed";
        break;
      }
      if (!held) {
        leaseLost = true;
        break;
      }
      if (rows.size) {
        try {
          await db.upsertListings([...rows.values()]);
        } catch (e) {
          if (pagesRead === 0 && upserted === 0) throw e;
          console.error(
            "[sharetribe-sync] upsert failed",
            workspaceId,
            e instanceof Error ? e.message : e,
          );
          reason ??= "save_failed";
          break;
        }
        for (const id of rows.keys()) saved.add(id);
        upserted = saved.size;
      }
      pagesRead = page;

      if (!usable) break; // without pagination facts there is no safe next page
      if (page >= (meta.totalPages ?? 0)) break;
      if (paginationLimit !== null && page >= paginationLimit) {
        reason ??= "pagination_limit";
        break;
      }
    }

    const nonEmptyRead = seen.size > 0;
    if (nonEmptyRead) syncState = { ...prevState, empty_strikes: 0, first_empty_at: null };

    if (leaseLost) {
      status = "partial";
      reason = "lease_lost";
      sentence = SYNC_SENTENCES.leaseLost;
    } else if (confirmedEmpty) {
      // A well-formed "0 published listings". Two strikes before anything is removed.
      let local: number | null = null;
      try {
        local = await db.countListings(workspaceId);
      } catch (e) {
        console.error(
          "[sharetribe-sync] count failed",
          workspaceId,
          e instanceof Error ? e.message : e,
        );
      }
      const firstAt = prevState.first_empty_at ? Date.parse(prevState.first_empty_at) : NaN;
      if (local === 0) {
        status = "success";
        sentence = SYNC_SENTENCES.emptyBoth;
        syncState = { ...prevState, empty_strikes: 0, first_empty_at: null };
      } else if (
        prevState.empty_strikes >= 1 &&
        Number.isFinite(firstAt) &&
        deps.now() - firstAt >= limits.emptyConfirmAfterMs
      ) {
        const r = await reconcile();
        if (r === -1) {
          leaseLost = true;
          status = "partial";
          reason = "lease_lost";
          sentence = SYNC_SENTENCES.leaseLost;
        } else if (r === null) {
          status = "warning";
          sentence = SYNC_SENTENCES.emptyFirst;
          syncState = { ...prevState, empty_strikes: prevState.empty_strikes + 1 };
        } else {
          removed = r;
          status = "success";
          sentence = emptyConfirmedSentence(r);
          syncState = { ...prevState, empty_strikes: 0, first_empty_at: null };
        }
      } else {
        status = "warning";
        sentence = SYNC_SENTENCES.emptyFirst;
        syncState = {
          ...prevState,
          empty_strikes: prevState.empty_strikes + 1,
          first_empty_at: prevState.first_empty_at ?? runStartedAt,
        };
      }
    } else {
      const complete =
        reason === null &&
        totalItems !== null &&
        lastTotalPages !== null &&
        pagesRead >= lastTotalPages &&
        seen.size === totalItems;
      if (!complete) {
        reason ??= "count_mismatch";
        status = "partial";
        sentence = partialSentence(reason, upserted, totalItems);
      } else {
        const r = await reconcile();
        if (r === -1) {
          leaseLost = true;
          status = "partial";
          reason = "lease_lost";
          sentence = SYNC_SENTENCES.leaseLost;
        } else if (r === null) {
          status = "partial";
          reason = "reconcile_failed";
          sentence = partialSentence("reconcile_failed", upserted, totalItems);
        } else {
          removed = r;
          status = "success";
          sentence = successSentence(seen.size, removed);
        }
      }
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    console.error("[sharetribe-sync] workspace sync failed", workspaceId, raw.slice(0, 300));
    if (pagesRead > 0) {
      status = "partial";
      reason ??= "upstream_error";
      sentence = partialSentence(reason, upserted, totalItems);
    } else {
      status = "failed";
      sentence = friendlySharetribeError(e, mode);
      if (isAuthFailure(e)) connectionStatus = "error";
    }
  }

  if (tokenOk && status !== "failed" && integration.status !== "connected")
    connectionStatus = "connected";

  let listingsCount: number | null = null;
  if (!leaseLost) {
    try {
      listingsCount = await db.countListings(workspaceId);
    } catch (e) {
      console.error(
        "[sharetribe-sync] count failed",
        workspaceId,
        e instanceof Error ? e.message : e,
      );
    }
  }

  const outcome: AnyRec = {
    success: status === "success",
    status,
    error: status === "success" ? null : sentence,
    progress: {
      phase: "done",
      status,
      reason,
      pages: lastTotalPages,
      pages_read: pagesRead,
      fetched: seen.size,
      saved: upserted,
      removed,
      total: totalItems,
      started_at: runStartedAt,
      finished_at: new Date(deps.now()).toISOString(),
    },
  };
  if (listingsCount !== null) outcome.listings_count = listingsCount;
  if (totalItems !== null) outcome.upstream_total = totalItems;
  if (syncState) outcome.sync_state = syncState;
  if (connectionStatus) outcome.connection_status = connectionStatus;

  let recorded = false;
  try {
    recorded =
      (await db.rpc("finish_listing_sync", {
        _workspace_id: workspaceId,
        _run_id: runId,
        _outcome: outcome,
      })) === true;
  } catch (e) {
    console.error(
      "[sharetribe-sync] finish failed",
      workspaceId,
      e instanceof Error ? e.message : e,
    );
  }

  // Not recorded: this run no longer owns the row. If the row is GONE the
  // workspace disconnected mid-run — remove anything this run wrote.
  let cleanedUp = false;
  if (!recorded) {
    try {
      const still = await db.loadIntegration(workspaceId);
      if (!still) {
        await db.deleteListings(workspaceId);
        cleanedUp = true;
      }
    } catch (e) {
      console.error(
        "[sharetribe-sync] post-run check failed",
        workspaceId,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return {
    status,
    sentence,
    reason,
    upserted,
    removed,
    listingsCount,
    upstreamTotal: totalItems,
    pagesRead,
    runId,
    recorded,
    cleanedUp,
  };
}

// ---------------------------------------------------------------------------
// Bounded "all" mode (the cron hook's safety net)
// ---------------------------------------------------------------------------

/** The default number of workspaces one cron-driven "all" call may sync. */
export const SYNC_ALL_BATCH_LIMIT = 3;
/** Wall-clock budget for one bounded call across all its workspaces. */
export const SYNC_ALL_TIME_BUDGET_MS = 100_000;

/**
 * Pick which workspaces a bounded "all" run should sync: never-synced rows
 * first, then the stalest `last_sync_at`, capped at `limit`. Pure so the
 * ordering can be tested without a database.
 */
export function selectWorkspacesForBoundedSync<T extends { last_sync_at: string | null }>(
  rows: T[],
  limit = SYNC_ALL_BATCH_LIMIT,
): T[] {
  const cap = Math.max(0, Math.floor(limit));
  return [...rows]
    .sort((a, b) => {
      const ta = a.last_sync_at ? Date.parse(a.last_sync_at) : Number.NEGATIVE_INFINITY;
      const tb = b.last_sync_at ? Date.parse(b.last_sync_at) : Number.NEGATIVE_INFINITY;
      return ta - tb;
    })
    .slice(0, cap);
}

export type BoundedSyncResult = {
  eligible: number;
  limit: number;
  ran: Array<{ workspace_id: string; status: SyncRunResult["status"] | "skipped"; ok: boolean }>;
  succeeded: number;
  failed: number;
  /** The list of workspaces could not be read: nothing ran. */
  readFailed: boolean;
};

/**
 * Sync at most `limit` connected workspaces, oldest sync first, inside one
 * shared time budget. Used by the cron hook when called without a
 * workspace_id. Bounded on purpose: the scheduled fan-out already enqueues
 * one call per workspace — this path is only a safety net. A run counts as
 * failed only when its status is "failed"; the statuses are reported as-is.
 */
export async function runSharetribeSyncBounded(
  limit = SYNC_ALL_BATCH_LIMIT,
  overrides: SyncOverrides = {},
): Promise<BoundedSyncResult> {
  const deps = resolveSyncDeps(overrides);
  let eligible: Array<{ workspace_id: string; last_sync_at: string | null }>;
  try {
    eligible = await deps.db.listSyncCandidates();
  } catch (e) {
    console.error(
      "[sharetribe-sync-all] candidate read failed",
      e instanceof Error ? e.message : e,
    );
    return { eligible: 0, limit, ran: [], succeeded: 0, failed: 0, readFailed: true };
  }
  const picked = selectWorkspacesForBoundedSync(eligible, limit);
  const started = deps.now();
  const ran: BoundedSyncResult["ran"] = [];
  for (const row of picked) {
    const remaining = SYNC_ALL_TIME_BUDGET_MS - (deps.now() - started);
    if (remaining < 15_000) {
      ran.push({ workspace_id: row.workspace_id, status: "skipped", ok: true });
      continue;
    }
    const r = await runSharetribeSyncForWorkspace(row.workspace_id, {
      ...overrides,
      db: deps.db,
      limits: {
        ...(overrides.limits ?? {}),
        timeBudgetMs: Math.min(deps.limits.timeBudgetMs, remaining - 10_000),
      },
    });
    ran.push({ workspace_id: row.workspace_id, status: r.status, ok: r.status !== "failed" });
  }
  return {
    eligible: eligible.length,
    limit,
    ran,
    succeeded: ran.filter((r) => r.ok && r.status !== "skipped").length,
    failed: ran.filter((r) => !r.ok).length,
    readFailed: false,
  };
}
