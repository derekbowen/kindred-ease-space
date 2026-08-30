/**
 * CONNECTION CERTIFICATION.
 *
 * Valid credentials are not enough. Before a workspace may publish dynamic
 * marketplace pages we prove the *routes* work, using the customer's real
 * public URLs:
 *
 *   credentials → sample sync → build listing URL → probe it
 *                             → build search URL  → probe it
 *                             → probe customer origin
 *                             → CERTIFIED
 *
 * Certification records the adapter_version it passed under, because adapter
 * logic can change; a later version invalidates the certificate.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  buildListingUrl,
  buildSearchUrl,
  resolveRouteConfig,
  type MarketplaceRouteConfig,
} from "./adapter";

const sb = () => supabaseAdmin as any;

export const ADAPTER_VERSION = 1;
const PROBE_TIMEOUT_MS = 12_000;

export type ProbeResult = {
  check: string;
  ok: boolean;
  url?: string;
  status?: number;
  detail: string;
};

async function probe(url: string, check: string): Promise<ProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    // Follow redirects: a marketplace legitimately 301s apex → www, and a
    // redirect to a working page is a pass, not a failure.
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "founders.click route-certification" },
    });
    const ok = res.status >= 200 && res.status < 400;
    return {
      check,
      ok,
      url,
      status: res.status,
      detail: ok ? `HTTP ${res.status}` : `HTTP ${res.status} — route may be wrong for this marketplace`,
    };
  } catch (e) {
    return {
      check,
      ok: false,
      url,
      detail: `unreachable: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export type CertificationOutcome = {
  status: "CERTIFIED" | "DEGRADED" | "FAILED";
  checks: ProbeResult[];
  error?: string;
};

export async function certifyMarketplaceConnection(
  workspaceId: string,
): Promise<CertificationOutcome> {
  const { data: integration } = await sb()
    .from("tenant_integrations")
    .select("id, marketplace_url, route_config, last_sync_at")
    .eq("workspace_id", workspaceId)
    .eq("provider", "sharetribe")
    .maybeSingle();

  if (!integration?.marketplace_url) {
    return { status: "FAILED", checks: [], error: "No Sharetribe integration connected" };
  }

  await sb()
    .from("tenant_integrations")
    .update({ certification_status: "CERTIFYING", certification_error: null })
    .eq("id", integration.id);

  const cfg: MarketplaceRouteConfig = resolveRouteConfig(
    integration.marketplace_url,
    integration.route_config,
  );

  const checks: ProbeResult[] = [];

  // 1. The customer's marketplace itself must be reachable.
  checks.push(await probe(cfg.baseUrl, "customer_origin"));

  // 2. A real synced listing must resolve at the configured route. This is the
  //    check that catches a wrong listing_route_template — the P0 that made
  //    every card link broken for a customised marketplace.
  const { data: sample } = await sb()
    .from("tenant_listings")
    .select("sharetribe_listing_id, slug, city, category")
    .eq("workspace_id", workspaceId)
    .eq("state_published", true)
    .order("synced_at", { ascending: false })
    .limit(3);

  const listings = (sample ?? []) as Array<Record<string, any>>;
  if (listings.length === 0) {
    checks.push({
      check: "listing_route",
      ok: false,
      detail: "No synced listings to verify a listing URL against — run a sync first",
    });
  } else {
    for (const l of listings.slice(0, 2)) {
      const url = buildListingUrl(cfg, {
        sharetribe_listing_id: l.sharetribe_listing_id,
        slug: l.slug,
      });
      if (!url) {
        checks.push({ check: "listing_route", ok: false, detail: "Could not build a listing URL" });
        continue;
      }
      checks.push(await probe(url, "listing_route"));
    }
  }

  // 3. The search handoff must land somewhere real.
  const searchUrl = buildSearchUrl(cfg, {
    location: listings[0]?.city ?? null,
    category: listings[0]?.category ?? null,
  });
  if (searchUrl) checks.push(await probe(searchUrl, "search_route"));
  else checks.push({ check: "search_route", ok: false, detail: "Could not build a search URL" });

  const originOk = checks.find((c) => c.check === "customer_origin")?.ok ?? false;
  const listingOk = checks.filter((c) => c.check === "listing_route").some((c) => c.ok);
  const searchOk = checks.find((c) => c.check === "search_route")?.ok ?? false;

  // Listing links are the load-bearing route: without them every card is
  // broken, which is worse than shipping no page at all.
  const status: CertificationOutcome["status"] =
    originOk && listingOk && searchOk ? "CERTIFIED" : originOk && listingOk ? "DEGRADED" : "FAILED";

  const failed = checks.filter((c) => !c.ok);
  await sb()
    .from("tenant_integrations")
    .update({
      certification_status: status,
      certified_at: status === "CERTIFIED" ? new Date().toISOString() : null,
      adapter_version: ADAPTER_VERSION,
      certification_error: failed.length ? failed.map((c) => `${c.check}: ${c.detail}`).join("; ") : null,
      certification_detail: { checks, adapter_version: ADAPTER_VERSION },
    })
    .eq("id", integration.id);

  if (status !== "CERTIFIED") {
    console.error("[certification] marketplace not certified", workspaceId, status, failed);
  }
  return { status, checks };
}

/**
 * Validate the Cloudflare PROVISIONING token without ever returning it.
 *
 * Uses the read-only token-verify endpoint plus a read-only zone read. It
 * deliberately does NOT attempt a Worker script write: the provisioning token
 * is intentionally scoped without Workers Scripts, and probing for a
 * permission we don't want it to have would be the wrong test.
 */
export async function verifyCloudflareProvisioningToken(): Promise<{
  authenticates: boolean;
  zoneAccess: boolean;
  detail: string;
}> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  if (!token) return { authenticates: false, zoneAccess: false, detail: "CLOUDFLARE_API_TOKEN not configured" };

  const call = async (path: string) => {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return { ok: res.ok, json: await res.json().catch(() => ({})) };
  };

  try {
    const verify = await call("/user/tokens/verify");
    const authenticates = verify.ok && (verify.json as any)?.success === true;
    if (!authenticates) {
      return { authenticates: false, zoneAccess: false, detail: "Token failed Cloudflare verification" };
    }
    if (!zoneId) {
      return { authenticates: true, zoneAccess: false, detail: "CLOUDFLARE_ZONE_ID not configured" };
    }
    const zone = await call(`/zones/${zoneId}`);
    const zoneAccess = zone.ok && (zone.json as any)?.success === true;
    return {
      authenticates: true,
      zoneAccess,
      detail: zoneAccess ? "Token authenticates and can read the zone" : "Token cannot read the configured zone",
    };
  } catch (e) {
    return {
      authenticates: false,
      zoneAccess: false,
      detail: `Cloudflare unreachable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
