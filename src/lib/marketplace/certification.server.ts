/**
 * LISTING LINK CHECK (connection certification).
 *
 * Valid credentials prove a Client ID works — not that the links a page puts
 * on its listing cards open the right listing on the customer's marketplace.
 * This opens ONE real synced listing at the URL the adapter builds (exactly
 * the URL a public page links to), follows redirects (bounded, with a
 * timeout), and accepts it only when the final answer is 200 AND the page
 * still identifies that listing (its id outside a URL, or its title leading
 * the page's title / og:title or as its h1 — see identifiesListing). A
 * redirect to the homepage, or a "not found" page served with 200 (a
 * soft-404), is not a working link.
 *
 *   ok             200 and the page is that listing             → CERTIFIED
 *   auth_required  401/403 (e.g. a password-protected test
 *                  marketplace)                                 → DEGRADED
 *   error          timeout, network error, 5xx, other answers   → DEGRADED (unverified)
 *   not_found      404/410, or 200 without the listing          → FAILED
 *   redirected     ended on a page that is not the listing      → FAILED
 *
 * The fine-grained result lives in certification_detail.listing_link; the
 * certification_status column keeps its existing CHECK values. Unverified
 * links are a warning on the Sharetribe page — never a publish blocker.
 * Runs after the first successful sync and from "Check listing links".
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildListingUrl, resolveRouteConfig } from "./adapter";

export const ADAPTER_VERSION = 1;

export type LinkCheckResult = "ok" | "auth_required" | "not_found" | "redirected" | "error";

export type LinkProbe = {
  result: LinkCheckResult;
  finalUrl: string;
  httpStatus: number | null;
  hops: number;
  /** For logs only (never shown to a customer). */
  detail: string;
};

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type LinkProbeOptions = {
  fetch: FetchFn;
  now: () => number;
  /** Per-request timeout. */
  timeoutMs: number;
  /** The whole check, all hops included. */
  budgetMs: number;
  maxHops: number;
  /** HTML read at most (a listing page's head and h1 come early). */
  maxBodyBytes: number;
};

export const LINK_PROBE_DEFAULTS: LinkProbeOptions = {
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => Date.now(),
  timeoutMs: 10_000,
  budgetMs: 20_000,
  maxHops: 5,
  maxBodyBytes: 1_000_000,
};

const USER_AGENT = "founders.click-link-check/1.0 (+https://www.founders.click)";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

/** Decode common HTML entities, fold case and whitespace. */
export function normalizePageText(s: string): string {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-z][\w:-]*)\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    out[m[1]!.toLowerCase()] = m[3] ?? m[4] ?? "";
  }
  return out;
}

/** The id in the page outside a URL path: listing data, not an echo of the address we asked for. */
function mentionsIdOutsideUrl(html: string, id: string): boolean {
  const hay = html.toLowerCase();
  const needle = id.toLowerCase();
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const before = hay.slice(Math.max(0, at - 3), at);
    if (!before.endsWith("/") && before !== "%2f") return true;
  }
  return false;
}

/** `text` starts with `title`, and the title ends at a word boundary. */
const leadsWith = (text: string, title: string) =>
  text.startsWith(title) && !/[\p{L}\p{N}]/u.test(text.charAt(title.length));

/**
 * Does this HTML identify the listing?
 *  - its id, anywhere OUTSIDE a URL path (a "not found" page commonly echoes
 *    the requested address — which contains the id — in canonical/og:url);
 *  - or its title: leading the <title> / og:title / twitter:title, or equal
 *    to an <h1>; a title of 12+ characters may appear anywhere in those.
 * The URL alone never counts: a soft-404 answers 200 at the very URL we asked.
 */
export function identifiesListing(html: string, listing: { id: string; title: string | null }): boolean {
  if (!html) return false;
  if (listing.id && mentionsIdOutsideUrl(html, listing.id)) return true;
  const title = normalizePageText(listing.title ?? "");
  if (title.length < 3) return false;
  const heads: string[] = [];
  for (const m of html.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)) heads.push(m[1]!);
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attributes(m[0]);
    const key = (a.property ?? a.name ?? "").toLowerCase();
    if ((key === "og:title" || key === "twitter:title") && a.content) heads.push(a.content);
  }
  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => normalizePageText(m[1]!.replace(/<[^>]*>/g, " ")));
  const normHeads = heads.map(normalizePageText);
  if (h1s.some((h) => h === title) || normHeads.some((h) => leadsWith(h, title))) return true;
  return title.length >= 12 && [...normHeads, ...h1s].some((h) => h.includes(title));
}

async function readBodyText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    // A body cut short is still worth reading.
  }
  const buf = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, buf.byteLength - off);
    buf.set(c.subarray(0, take), off);
    off += take;
    if (off >= buf.byteLength) break;
  }
  return new TextDecoder().decode(buf);
}

/** A public DNS name: has a dot, is not localhost, is not an IP literal. */
const publicHostname = (host: string) => {
  const h = host.toLowerCase();
  return h.includes(".") && !h.endsWith(".localhost") && !h.startsWith("[") && !/^\d{1,3}(\.\d{1,3}){3}$/.test(h);
};

const pathOf = (u: string) => {
  try {
    return new URL(u).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return u;
  }
};

/** Open one listing URL the way a visitor would, and classify the answer. */
export async function probeListingLink(
  url: string,
  listing: { id: string; title: string | null },
  options: Partial<LinkProbeOptions> = {},
): Promise<LinkProbe> {
  const o: LinkProbeOptions = { ...LINK_PROBE_DEFAULTS, ...options };
  const start = o.now();
  let current = url;
  let hops = 0;
  for (;;) {
    const remaining = o.budgetMs - (o.now() - start);
    if (remaining <= 0) return { result: "error", finalUrl: current, httpStatus: null, hops, detail: "time budget spent" };
    let res: Response;
    try {
      res = await o.fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(1, Math.min(o.timeoutMs, remaining))),
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "error";
      return {
        result: "error",
        finalUrl: current,
        httpStatus: null,
        hops,
        detail: name === "TimeoutError" || name === "AbortError" ? "timed out" : `unreachable (${name})`,
      };
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!location) return { result: "error", finalUrl: current, httpStatus: res.status, hops, detail: "redirect without a location" };
      if (hops >= o.maxHops) return { result: "redirected", finalUrl: current, httpStatus: res.status, hops, detail: "too many redirects" };
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return { result: "error", finalUrl: current, httpStatus: res.status, hops, detail: "unreadable redirect" };
      }
      if (next.protocol !== "https:" && next.protocol !== "http:") {
        return { result: "redirected", finalUrl: next.toString(), httpStatus: res.status, hops, detail: "redirect off the web" };
      }
      if (!publicHostname(next.hostname)) {
        // A customer's site must not steer this server-side request inward.
        return { result: "redirected", finalUrl: next.toString(), httpStatus: res.status, hops, detail: "redirect to a non-public host" };
      }
      current = next.toString();
      hops++;
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      return { result: "auth_required", finalUrl: current, httpStatus: res.status, hops, detail: `answered ${res.status}` };
    }
    if (res.status === 404 || res.status === 410) {
      await res.body?.cancel().catch(() => {});
      return { result: "not_found", finalUrl: current, httpStatus: res.status, hops, detail: `answered ${res.status}` };
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return { result: "error", finalUrl: current, httpStatus: res.status, hops, detail: `answered ${res.status}` };
    }
    const html = await readBodyText(res, o.maxBodyBytes);
    if (identifiesListing(html, listing)) {
      return { result: "ok", finalUrl: current, httpStatus: 200, hops, detail: "the listing page" };
    }
    if (hops > 0 && pathOf(current) !== pathOf(url)) {
      return { result: "redirected", finalUrl: current, httpStatus: 200, hops, detail: "ended on another page" };
    }
    return { result: "not_found", finalUrl: current, httpStatus: 200, hops, detail: "200 without the listing (soft-404)" };
  }
}

// ---------------------------------------------------------------------------
// Check one synced listing and record the result
// ---------------------------------------------------------------------------

export type ListingLinkCheck = {
  result: LinkCheckResult | "no_listings" | "not_connected";
  sentence: string;
  url: string | null;
  finalUrl: string | null;
  httpStatus: number | null;
  checkedAt: string;
  /** The result was written to tenant_integrations. */
  saved: boolean;
};

export const LINK_CHECK_SENTENCES: Record<ListingLinkCheck["result"], string> = {
  ok: "Listing links work. We opened one of your synced listings on your marketplace.",
  auth_required:
    "Your marketplace asked for a password, so we couldn't open a listing. Links work for visitors once the marketplace is public.",
  not_found:
    "A synced listing didn't open at the address we link to. Contact support so we can match your marketplace's link format.",
  redirected:
    "Opening a synced listing took us to a different page, so listing links may not work. Contact support so we can match your link format.",
  error: "We couldn't reach your marketplace to check listing links. Try again in a minute.",
  no_listings: "There are no synced listings to check yet. Run a sync first.",
  not_connected: "Sharetribe is not connected for this workspace.",
};

const CERTIFICATION_STATUS: Record<LinkCheckResult, "CERTIFIED" | "DEGRADED" | "FAILED"> = {
  ok: "CERTIFIED",
  auth_required: "DEGRADED",
  error: "DEGRADED",
  not_found: "FAILED",
  redirected: "FAILED",
};

export type LinkCheckIntegration = {
  id: string;
  marketplace_url: string;
  route_config: unknown;
  certification_detail?: unknown;
};

export type LinkCheckDb = {
  loadIntegration(workspaceId: string): Promise<LinkCheckIntegration | null>;
  /** The most recently synced published listing, or null. */
  sampleListing(
    workspaceId: string,
  ): Promise<{ sharetribe_listing_id: string; slug: string | null; title: string | null } | null>;
  saveResult(integrationId: string, patch: Record<string, unknown>): Promise<void>;
};

export function supabaseLinkCheckDb(): LinkCheckDb {
  const sb = () => supabaseAdmin as any;
  return {
    async loadIntegration(workspaceId) {
      const { data, error } = await sb()
        .from("tenant_integrations")
        .select("id, marketplace_url, route_config, certification_detail")
        .eq("workspace_id", workspaceId)
        .eq("provider", "sharetribe")
        .maybeSingle();
      if (error) throw new Error(`integration_lookup_failed:${error.message}`);
      return (data ?? null) as LinkCheckIntegration | null;
    },
    async sampleListing(workspaceId) {
      const { data, error } = await sb()
        .from("tenant_listings")
        .select("sharetribe_listing_id, slug, title")
        .eq("workspace_id", workspaceId)
        .eq("state_published", true)
        .order("synced_at", { ascending: false })
        .order("id", { ascending: true })
        .limit(1);
      if (error) throw new Error(`listing_sample_failed:${error.message}`);
      return ((data ?? [])[0] ?? null) as { sharetribe_listing_id: string; slug: string | null; title: string | null } | null;
    },
    async saveResult(integrationId, patch) {
      const { error } = await sb().from("tenant_integrations").update(patch).eq("id", integrationId);
      if (error) throw new Error(`certification_save_failed:${error.message}`);
    },
  };
}

/** Check one real synced listing's link and record the result. Never throws. */
export async function checkListingLinks(
  workspaceId: string,
  overrides: { db?: LinkCheckDb; probe?: Partial<LinkProbeOptions> } = {},
): Promise<ListingLinkCheck> {
  const db = overrides.db ?? supabaseLinkCheckDb();
  const now = overrides.probe?.now ?? LINK_PROBE_DEFAULTS.now;
  const empty = (result: ListingLinkCheck["result"]): ListingLinkCheck => ({
    result,
    sentence: LINK_CHECK_SENTENCES[result],
    url: null,
    finalUrl: null,
    httpStatus: null,
    checkedAt: new Date(now()).toISOString(),
    saved: false,
  });

  let integration: LinkCheckIntegration | null;
  let sample: Awaited<ReturnType<LinkCheckDb["sampleListing"]>>;
  try {
    integration = await db.loadIntegration(workspaceId);
    if (!integration?.marketplace_url) return empty("not_connected");
    sample = await db.sampleListing(workspaceId);
  } catch (e) {
    console.error("[link-check] read failed", workspaceId, e instanceof Error ? e.message : e);
    return empty("error");
  }
  if (!sample?.sharetribe_listing_id) return empty("no_listings");

  const cfg = resolveRouteConfig(integration.marketplace_url, integration.route_config);
  const url = buildListingUrl(cfg, { sharetribe_listing_id: sample.sharetribe_listing_id, slug: sample.slug });
  if (!url) return empty("not_connected");

  const probe = await probeListingLink(url, { id: sample.sharetribe_listing_id, title: sample.title }, overrides.probe);
  const checkedAt = new Date(now()).toISOString();
  const sentence = LINK_CHECK_SENTENCES[probe.result];
  if (probe.result !== "ok") {
    console.error("[link-check] listing link not verified", workspaceId, probe.result, probe.httpStatus, probe.detail);
  }

  let saved = false;
  try {
    await db.saveResult(integration.id, {
      certification_status: CERTIFICATION_STATUS[probe.result],
      certified_at: probe.result === "ok" ? checkedAt : null,
      certification_error: probe.result === "ok" ? null : sentence,
      adapter_version: ADAPTER_VERSION,
      certification_detail: {
        adapter_version: ADAPTER_VERSION,
        listing_link: {
          result: probe.result,
          url,
          final_url: probe.finalUrl,
          http_status: probe.httpStatus,
          hops: probe.hops,
          listing_id: sample.sharetribe_listing_id,
          checked_at: checkedAt,
        },
      },
    });
    saved = true;
  } catch (e) {
    console.error("[link-check] save failed", workspaceId, e instanceof Error ? e.message : e);
  }
  return { result: probe.result, sentence, url, finalUrl: probe.finalUrl, httpStatus: probe.httpStatus, checkedAt, saved };
}

/** The listing-link result recorded for this integration, if any. */
export function recordedLinkCheck(detail: unknown): { result: string; checked_at: string | null } | null {
  const link = detail && typeof detail === "object" ? (detail as Record<string, any>).listing_link : null;
  if (!link || typeof link !== "object" || typeof link.result !== "string") return null;
  return { result: link.result, checked_at: typeof link.checked_at === "string" ? link.checked_at : null };
}

/**
 * After a successful sync: check listing links if they were never checked for
 * this connection (a new connection, or a changed marketplace resets it).
 * Returns null when a result is already on record.
 */
export async function checkListingLinksIfNeverChecked(
  workspaceId: string,
  overrides: { db?: LinkCheckDb; probe?: Partial<LinkProbeOptions> } = {},
): Promise<ListingLinkCheck | null> {
  const db = overrides.db ?? supabaseLinkCheckDb();
  try {
    const integration = await db.loadIntegration(workspaceId);
    if (!integration || recordedLinkCheck(integration.certification_detail)) return null;
  } catch (e) {
    console.error("[link-check] read failed", workspaceId, e instanceof Error ? e.message : e);
    return null;
  }
  return checkListingLinks(workspaceId, { ...overrides, db });
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
