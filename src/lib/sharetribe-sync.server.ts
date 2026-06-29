// Server-only Sharetribe sync helper. Uses service-role Supabase client
// and Vault-decrypted credentials. Never import from client code.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const SHARETRIBE_AUTH_URL = "https://flex-integ-api.sharetribe.com/v1/auth/token";
const SHARETRIBE_API_BASE = "https://flex-integ-api.sharetribe.com/v1/integration_api";

type AnyRec = Record<string, any>;

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
  throw lastErr ?? new Error("network failure");
}

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "integ",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetchWithRetry(SHARETRIBE_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`auth_failed:${res.status}:${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("auth_failed:no_token");
  return json.access_token;
}

async function showMarketplace(token: string): Promise<{ id: string; name?: string } | null> {
  const res = await fetchWithRetry(`${SHARETRIBE_API_BASE}/marketplace/show`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as AnyRec;
  const id = json?.data?.id?.uuid ?? json?.data?.id;
  return id ? { id, name: json?.data?.attributes?.name } : null;
}

/** Validate creds — used during connect flow. */
export async function validateSharetribeCredentials(opts: {
  clientId: string;
  clientSecret: string;
}): Promise<{ ok: true; marketplaceId: string; name?: string } | { ok: false; error: string }> {
  try {
    const token = await getAccessToken(opts.clientId, opts.clientSecret);
    const mp = await showMarketplace(token);
    if (!mp) return { ok: false, error: "Could not load marketplace details" };
    return { ok: true, marketplaceId: mp.id, name: mp.name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "validation_failed" };
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

function mapListing(workspaceId: string, marketplaceUrl: string, raw: AnyRec, included: AnyRec[]) {
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
    author_id: authorRel?.id?.uuid ?? null,
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
    state_published: state === "published",
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
    .select("id, marketplace_url, client_id")
    .eq("workspace_id", workspaceId)
    .eq("provider", "sharetribe")
    .maybeSingle();

  if (intErr) throw new Error(`integration_lookup_failed:${intErr.message}`);
  if (!integration) throw new Error("integration_not_found");

  const { data: secretRow, error: secretErr } = await sb.rpc("tenant_get_integration_secret", {
    _workspace_id: workspaceId,
  });
  if (secretErr || !secretRow)
    throw new Error(`secret_decrypt_failed:${secretErr?.message ?? "missing"}`);

  const setStatus = async (patch: AnyRec) =>
    sb.from("tenant_integrations").update(patch).eq("id", integration.id);

  try {
    const token = await getAccessToken(integration.client_id, secretRow as string);

    const seenIds = new Set<string>();
    let page = 1;
    let totalPages = 1;
    let upserted = 0;

    do {
      const url = `${SHARETRIBE_API_BASE}/listings/query?per_page=100&page=${page}&include=author,images`;
      const res = await fetchWithRetry(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`listings_query_failed:${res.status}:${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as AnyRec;
      const data: AnyRec[] = json?.data ?? [];
      const included: AnyRec[] = json?.included ?? [];
      totalPages = json?.meta?.totalPages ?? 1;

      const rows = data.map((d) =>
        mapListing(workspaceId, integration.marketplace_url, d, included),
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
      // No listings upstream — wipe local
      const { count } = await sb
        .from("tenant_listings")
        .delete({ count: "exact" })
        .eq("workspace_id", workspaceId);
      removed = count ?? 0;
    }

    await setStatus({
      status: "connected",
      last_sync_at: new Date().toISOString(),
      last_sync_status: "success",
      last_sync_error: null,
      listings_count: upserted,
    });

    return { upserted, removed };
  } catch (e) {
    const message = e instanceof Error ? e.message : "sync_failed";
    await setStatus({
      last_sync_at: new Date().toISOString(),
      last_sync_status: "failed",
      last_sync_error: message.slice(0, 500),
      status: message.startsWith("auth_failed") ? "error" : undefined,
    });
    throw e;
  }
}

/** Sync every connected workspace. Used by the cron hook. */
export async function runSharetribeSyncAll(): Promise<{
  total: number;
  ok: number;
  failed: number;
}> {
  const sb = supabaseAdmin as any;
  const { data: rows } = await sb
    .from("tenant_integrations")
    .select("workspace_id")
    .eq("provider", "sharetribe")
    .in("status", ["connected", "pending"]);
  let ok = 0;
  let failed = 0;
  for (const row of rows ?? []) {
    try {
      await runSharetribeSyncForWorkspace(row.workspace_id);
      ok += 1;
    } catch (e) {
      console.error("[sharetribe-sync-all] workspace failed", row.workspace_id, e);
      failed += 1;
    }
  }
  return { total: (rows ?? []).length, ok, failed };
}
