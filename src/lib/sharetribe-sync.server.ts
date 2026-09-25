// Server-only Sharetribe sync helper. Uses service-role Supabase client
// and (for Integration API mode only) Vault-decrypted credentials.
// Never import from client code.
//
// Two auth modes:
//   * "marketplace" (default) — the Sharetribe Marketplace API with a
//     public-read client_credentials grant. Needs only a Client ID, returns
//     only the PUBLISHED listings a marketplace already shows every visitor,
//     and cannot write anything. No secret is stored anywhere.
//   * "integration" (advanced) — the Integration API with Client ID + Secret.
//     The secret grants full read/write access to the marketplace, so it lives
//     in Supabase Vault and we request only published listings.
//
// The pure pieces (request builders, error mapping, listing mapper, bounded
// workspace selection) are exported so tests can exercise them offline.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

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

/** Image variants the mapper prefers, in order. Requested explicitly from the
 *  Marketplace API via sparse fieldsets so responses stay small. */
const IMAGE_VARIANTS = ["square-small2x", "scaled-large", "default"] as const;

type AnyRec = Record<string, any>;

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
 * same mapper reads both responses. Marketplace API only ever returns
 * published listings; the Integration API is told the same explicitly so
 * drafts, pending and closed listings are never even fetched.
 */
export function buildListingsQueryUrl(mode: SharetribeAuthMode, page: number): string {
  const params = new URLSearchParams({
    per_page: "100",
    page: String(page),
    include: "author,images",
  });
  if (mode === "integration") {
    params.set("states", "published");
  } else {
    params.set("fields.image", IMAGE_VARIANTS.map((v) => `variants.${v}`).join(","));
  }
  return `${SHARETRIBE_API[mode].apiBase}/listings/query?${params.toString()}`;
}

function jsonApiId(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "uuid" in value) {
    return (value as { uuid?: string }).uuid;
  }
  return undefined;
}

async function fetchWithRetry(input: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(input, init);
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (i < attempts - 1) {
          await new Promise((r) => setTimeout(r, [1000, 3000, 9000][i] ?? 9000));
          continue;
        }
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, [1000, 3000, 9000][i] ?? 9000));
        continue;
      }
    }
  }
  throw new SharetribeApiError(
    "network",
    `network_failure:${lastErr instanceof Error ? lastErr.message : "unknown"}`,
  );
}

async function getAccessToken(
  mode: SharetribeAuthMode,
  clientId: string,
  clientSecret?: string,
): Promise<string> {
  const { url, body } = buildTokenRequest(mode, clientId, clientSecret);
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new SharetribeApiError(
      res.status === 400 || res.status === 401 ? "auth" : "api",
      `auth_failed:${res.status}:${text.slice(0, 200)}`,
      res.status,
    );
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new SharetribeApiError("auth", "auth_failed:no_token");
  return json.access_token;
}

async function showMarketplace(
  mode: SharetribeAuthMode,
  token: string,
): Promise<{ id: string; name?: string }> {
  const res = await fetchWithRetry(buildMarketplaceShowUrl(mode), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new SharetribeApiError("api", `marketplace_show_failed:${res.status}`, res.status);
  }
  const json = (await res.json()) as AnyRec;
  const id = json?.data?.id?.uuid ?? json?.data?.id;
  if (!id) throw new SharetribeApiError("api", "marketplace_show_failed:no_id");
  return { id, name: json?.data?.attributes?.name };
}

/** Validate creds against the right API — used during connect flow. */
export async function validateSharetribeCredentials(opts: {
  mode: SharetribeAuthMode;
  clientId: string;
  clientSecret?: string;
}): Promise<{ ok: true; marketplaceId: string; name?: string } | { ok: false; error: string }> {
  try {
    const token = await getAccessToken(opts.mode, opts.clientId, opts.clientSecret);
    const mp = await showMarketplace(opts.mode, token);
    return { ok: true, marketplaceId: mp.id, name: mp.name };
  } catch (e) {
    console.error("[sharetribe-validate] failed", e instanceof Error ? e.message : e);
    return { ok: false, error: friendlySharetribeError(e, opts.mode) };
  }
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

/**
 * Map one JSON:API listing (Marketplace or Integration API — same shape) to a
 * tenant_listings row. Only publicData/metadata are kept; privateData never
 * reaches the database. The Marketplace API returns published listings only
 * and no `state` attribute, so that mode marks every row published and the
 * stale-delete pass removes anything that has since closed.
 */
export function mapListing(
  workspaceId: string,
  marketplaceUrl: string,
  raw: AnyRec,
  included: AnyRec[],
  opts: { mode: SharetribeAuthMode } = { mode: "integration" },
) {
  const id: string = raw?.id?.uuid ?? raw?.id;
  const a = raw?.attributes ?? {};
  const price = a?.price?.amount ?? null;
  const currency = a?.price?.currency ?? null;
  const geo = a?.geolocation ?? {};
  const pub = a?.publicData ?? {};
  const meta = a?.metadata ?? {};
  const state = a?.state as string | undefined;

  // Resolve images via included relationships
  const imgRels: AnyRec[] = raw?.relationships?.images?.data ?? [];
  const images = (
    imgRels
      .map((rel) => {
        const relId = jsonApiId(rel?.id);
        return included.find((x) => x.type === "image" && jsonApiId(x.id) === relId);
      })
      .filter(Boolean) as AnyRec[]
  )
    .map((img) => {
      const variants = img?.attributes?.variants ?? {};
      const best =
        variants["square-small2x"] ||
        variants["scaled-large"] ||
        variants["default"] ||
        Object.values(variants)[0];
      return best
        ? {
            url: (best as AnyRec).url as string,
            width: (best as AnyRec).width ?? null,
            height: (best as AnyRec).height ?? null,
            alt: a?.title ?? "",
          }
        : null;
    })
    .filter(Boolean) as AnyRec[];

  // Author
  const authorRel = raw?.relationships?.author?.data;
  const authorId = jsonApiId(authorRel?.id);
  const author = authorId
    ? included.find((x) => x.type === "user" && jsonApiId(x.id) === authorId)
    : null;

  const baseUrl = marketplaceUrl.replace(/\/+$/, "");
  const listingUrl = `${baseUrl}/l/${slugify(a?.title) || "listing"}/${id}`;

  const city = pub?.city ?? pub?.location?.city ?? null;
  const stateLoc = pub?.state ?? pub?.location?.state ?? null;

  const imageUrls = images.map((i: AnyRec) => i.url);

  return {
    workspace_id: workspaceId,
    sharetribe_listing_id: id,
    title: a?.title ?? "Untitled",
    slug: slugify(a?.title) || id,
    description: a?.description ?? null,
    price_amount: typeof price === "number" ? price : null,
    price_currency: currency,
    city,
    state: stateLoc,
    country: pub?.country ?? null,
    lat: typeof geo?.lat === "number" ? geo.lat : null,
    lng: typeof geo?.lng === "number" ? geo.lng : null,
    category: pub?.category ?? pub?.categoryLevel1 ?? null,
    custom_fields: { publicData: pub, metadata: meta },
    images,
    author_id: authorId ?? null,
    author_name: author?.attributes?.profile?.displayName ?? null,
    marketplace_url: listingUrl,
    structured_data: buildJsonLd({
      title: a?.title ?? "Untitled",
      description: a?.description ?? null,
      images: imageUrls,
      marketplaceUrl: listingUrl,
      price,
      currency,
      city,
      state: stateLoc,
    }),
    state_published: opts.mode === "marketplace" ? true : state === "published",
    synced_at: new Date().toISOString(),
  };
}

/** Run a sync for one workspace. Returns counts; throws on fatal error. */
export async function runSharetribeSyncForWorkspace(workspaceId: string): Promise<{
  upserted: number;
  removed: number;
}> {
  const sb = supabaseAdmin as any;

  const { data: integration, error: intErr } = await sb
    .from("tenant_integrations")
    .select("id, marketplace_url, client_id, auth_mode")
    .eq("workspace_id", workspaceId)
    .eq("provider", "sharetribe")
    .maybeSingle();

  if (intErr) throw new Error(`integration_lookup_failed:${intErr.message}`);
  if (!integration) throw new Error("integration_not_found");

  // Rows created before auth_mode existed are Integration API connections.
  const mode: SharetribeAuthMode =
    integration.auth_mode === "marketplace" ? "marketplace" : "integration";

  const setStatus = async (patch: AnyRec) =>
    sb.from("tenant_integrations").update(patch).eq("id", integration.id);

  try {
    // Marketplace mode never touches Vault — there is no secret to read.
    let clientSecret: string | undefined;
    if (mode === "integration") {
      const { data: secretRow, error: secretErr } = await sb.rpc("tenant_get_integration_secret", {
        _workspace_id: workspaceId,
      });
      if (secretErr || !secretRow)
        throw new Error(`secret_decrypt_failed:${secretErr?.message ?? "missing"}`);
      clientSecret = secretRow as string;
    }

    const token = await getAccessToken(mode, integration.client_id, clientSecret);

    const seenIds = new Set<string>();
    let page = 1;
    let totalPages = 1;
    let upserted = 0;

    do {
      const res = await fetchWithRetry(buildListingsQueryUrl(mode, page), {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new SharetribeApiError(
          "api",
          `listings_query_failed:${res.status}:${text.slice(0, 200)}`,
          res.status,
        );
      }
      const json = (await res.json()) as AnyRec;
      const data: AnyRec[] = json?.data ?? [];
      const included: AnyRec[] = json?.included ?? [];
      totalPages = json?.meta?.totalPages ?? 1;

      const rows = data.map((d) =>
        mapListing(workspaceId, integration.marketplace_url, d, included, { mode }),
      );
      rows.forEach((r) => seenIds.add(r.sharetribe_listing_id));

      if (rows.length) {
        const { error: upErr } = await sb
          .from("tenant_listings")
          .upsert(rows, { onConflict: "workspace_id,sharetribe_listing_id" });
        if (upErr) throw new Error(`upsert_failed:${upErr.message}`);
        upserted += rows.length;
      }
      page += 1;
    } while (page <= totalPages);

    // Delete listings that no longer exist upstream
    let removed = 0;
    if (seenIds.size > 0) {
      const { data: existing } = await sb
        .from("tenant_listings")
        .select("sharetribe_listing_id")
        .eq("workspace_id", workspaceId);
      const stale = (existing ?? [])
        .map((r: AnyRec) => r.sharetribe_listing_id as string)
        .filter((id: string) => !seenIds.has(id));
      if (stale.length) {
        const { error: delErr } = await sb
          .from("tenant_listings")
          .delete()
          .eq("workspace_id", workspaceId)
          .in("sharetribe_listing_id", stale);
        if (delErr) {
          console.error("[sharetribe-sync] stale listing delete failed", delErr.message);
        } else {
          removed = stale.length;
        }
      }
    } else {
      // Upstream returned ZERO listings this run. That is far more often a
      // transient hiccup (auth blip, filtered/empty page, upstream error) than a
      // genuine "the customer deleted everything" — and wiping the local catalog
      // would silently break every pSEO page built on those listings. Never
      // auto-wipe a non-empty catalog down to zero; keep the last-known-good data
      // and surface a warning for the operator to investigate.
      const { count: existingCount } = await sb
        .from("tenant_listings")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId);
      if ((existingCount ?? 0) > 0) {
        await setStatus({
          status: "connected",
          last_sync_at: new Date().toISOString(),
          last_sync_status: "warning",
          last_sync_error:
            "Sharetribe returned no published listings, so we kept your last synced catalog instead of deleting it. Run a sync again once your listings are back, or disconnect to clear them.",
          listings_count: existingCount ?? 0,
        });
        return { upserted, removed: 0 };
      }
      // Empty on both sides — nothing to remove.
      removed = 0;
    }

    await setStatus({
      status: "connected",
      last_sync_at: new Date().toISOString(),
      last_sync_status: "success",
      last_sync_error: null,
      listings_count: upserted,
    });

    // Chain the affiliate referral sync for entitled workspaces — it had no
    // automatic trigger at all, so referrals/payouts only updated when an owner
    // clicked "Run sync now". Best-effort: never fail the listings sync over it.
    // It reads transactions through the Integration API, which a public-read
    // Marketplace API connection cannot do, so it is skipped in that mode.
    if (mode === "integration") {
      try {
        const { data: affSettings } = await sb
          .from("workspace_affiliate_settings")
          .select("addon_status")
          .eq("workspace_id", workspaceId)
          .maybeSingle();
        const { affiliateAddonUsable } = await import("@/lib/entitlement-grants.server");
        if (await affiliateAddonUsable(workspaceId, affSettings?.addon_status)) {
          const { runAffiliateReferralSync } = await import("@/lib/affiliate-sync.server");
          await runAffiliateReferralSync(workspaceId);
        }
      } catch (e) {
        console.error("[sharetribe-sync] chained affiliate sync failed", e);
      }
    }

    return { upserted, removed };
  } catch (e) {
    const raw = e instanceof Error ? e.message : "sync_failed";
    console.error("[sharetribe-sync] workspace sync failed", workspaceId, raw);
    const isAuth = e instanceof SharetribeApiError && e.kind === "auth";
    await setStatus({
      last_sync_at: new Date().toISOString(),
      last_sync_status: "failed",
      last_sync_error: friendlySharetribeError(e, mode).slice(0, 500),
      status: isAuth ? "error" : undefined,
    });
    throw e;
  }
}

/** The default number of workspaces one cron-driven "all" call may sync. */
export const SYNC_ALL_BATCH_LIMIT = 3;

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
  ran: Array<{ workspace_id: string; ok: boolean; error?: string }>;
  ok: number;
  failed: number;
};

/**
 * Sync at most `limit` connected workspaces, oldest sync first. Used by the
 * cron hook when it is called without a workspace_id. Bounded on purpose: one
 * Worker request has a subrequest budget, and the scheduled fan-out already
 * enqueues one call per workspace — this path is only a safety net.
 */
export async function runSharetribeSyncBounded(
  limit = SYNC_ALL_BATCH_LIMIT,
): Promise<BoundedSyncResult> {
  const sb = supabaseAdmin as any;
  const { data: rows } = await sb
    .from("tenant_integrations")
    .select("workspace_id, last_sync_at")
    .eq("provider", "sharetribe")
    .in("status", ["connected", "pending"]);
  const eligible = (rows ?? []) as Array<{ workspace_id: string; last_sync_at: string | null }>;
  const picked = selectWorkspacesForBoundedSync(eligible, limit);

  const ran: BoundedSyncResult["ran"] = [];
  for (const row of picked) {
    try {
      await runSharetribeSyncForWorkspace(row.workspace_id);
      ran.push({ workspace_id: row.workspace_id, ok: true });
    } catch (e) {
      console.error("[sharetribe-sync-all] workspace failed", row.workspace_id, e);
      ran.push({
        workspace_id: row.workspace_id,
        ok: false,
        error: e instanceof Error ? e.message : "sync_failed",
      });
    }
  }
  return {
    eligible: eligible.length,
    limit,
    ran,
    ok: ran.filter((r) => r.ok).length,
    failed: ran.filter((r) => !r.ok).length,
  };
}
