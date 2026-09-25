import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decideCapacity } from "@/lib/billing-capacity";
import { readGrantedPagesOrNull } from "@/lib/entitlement-grants.server";
import {
  buildListingCounter,
  isThinPageMeasured,
  thinPageBodyChars,
  type ListingFilter,
  type ListingLocation,
} from "@/lib/thin-page";
import { isPublicPageSlug } from "@/lib/public-page-slug";

const sb = () => supabaseAdmin as any;

export function escapeXml(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );
}

/**
 * The host exactly as the visitor (and Googlebot) requested it, minus scheme,
 * path and port. `www.` is PRESERVED.
 *
 * This is the host sitemap <loc> values must be built from. It is deliberately
 * separate from normalizeHost(), which strips `www.` so apex and www resolve to
 * the same workspace row — a lookup convenience that must never leak into
 * emitted URLs.
 */
export function requestHost(raw: string): string {
  return (raw || "")
    .split(",")[0]!
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
}

/** Lookup key only. Strips `www.` so a workspace matches on apex or www. */
export function normalizeHost(raw: string): string {
  return requestHost(raw).replace(/^www\./, "");
}

// Platform hosts always serve the marketing sitemap, never a tenant's.
const PLATFORM_HOSTS = new Set(["founders.click"]);

export function isPlatformHost(hostname: string): boolean {
  return PLATFORM_HOSTS.has(normalizeHost(hostname));
}

/** One candidate answer to "which workspace does this host belong to?". */
export type HostMatch = {
  workspaceId: string;
  /**
   * Where the match came from. A verified `workspace_domains` row is proof of
   * ownership of THIS hostname (a DNS/file challenge passed for it).
   * `marketplace_domain` is the legacy workspace-level field: seeded the moment
   * a hostname is claimed, gated only by the workspace-level domain_verified_at.
   */
  source: "workspace_domains" | "marketplace_domain";
  /** verified_at (custom domain) or domain_verified_at (legacy). */
  verifiedAt: string | null;
};

/**
 * THE PREFERENCE RULE, shared with current_workspace_id_by_host (migration
 * 20260923000500). The two sources can name different workspaces for one
 * hostname — an unverified claim expires after seven days and the hostname
 * can then be claimed and verified elsewhere, while the first workspace still
 * carries it in marketplace_domain — and "first match wins" used to mean
 * whichever the query returned first.
 *
 * Order: a verified custom domain outranks the legacy branch; within a
 * source the most recent verification wins, then the lowest workspace id.
 * Deterministic, so the sitemap and the page path agree with the database.
 */
export function preferredHostMatch(matches: readonly HostMatch[]): HostMatch | null {
  if (matches.length === 0) return null;
  const rank = (m: HostMatch) => (m.source === "workspace_domains" ? 0 : 1);
  // Unknown or unparseable dates sort LAST within a source (SQL: NULLS LAST).
  const at = (m: HostMatch) => {
    const t = m.verifiedAt ? Date.parse(m.verifiedAt) : NaN;
    return Number.isFinite(t) ? t : Number.MIN_SAFE_INTEGER;
  };
  const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...matches].sort(
    (a, b) => rank(a) - rank(b) || at(b) - at(a) || byId(a.workspaceId, b.workspaceId),
  )[0]!;
}

/**
 * Resolve a public host to a workspace id via a verified custom domain OR a
 * verified marketplace_domain. Mirrors current_workspace_id_by_host: the same
 * trust boundary (verified only, so unverified/spoofed hosts never expose a
 * sitemap) and the same preference between the two sources.
 */
export async function workspaceIdForHost(hostname: string): Promise<string | null> {
  const h = normalizeHost(hostname);
  if (!h || !h.includes(".") || isPlatformHost(h)) return null;

  const [domains, workspaces] = await Promise.all([
    sb()
      .from("workspace_domains")
      .select("workspace_id, verified_at")
      .eq("hostname", h)
      .eq("verified", true),
    sb()
      .from("workspaces")
      .select("id, domain_verified_at")
      .eq("marketplace_domain", h)
      .not("domain_verified_at", "is", null),
  ]);
  if (domains.error) {
    console.error("[workspaceIdForHost] workspace_domains read failed:", domains.error.message);
  }
  if (workspaces.error) {
    console.error("[workspaceIdForHost] workspaces read failed:", workspaces.error.message);
  }

  const matches: HostMatch[] = [
    ...((domains.data ?? []) as any[]).map((d) => ({
      workspaceId: String(d.workspace_id),
      source: "workspace_domains" as const,
      verifiedAt: (d.verified_at as string | null) ?? null,
    })),
    ...((workspaces.data ?? []) as any[]).map((w) => ({
      workspaceId: String(w.id),
      source: "marketplace_domain" as const,
      verifiedAt: (w.domain_verified_at as string | null) ?? null,
    })),
  ];
  return preferredHostMatch(matches)?.workspaceId ?? null;
}

/**
 * PostgREST caps every response at the project's max-rows — the Supabase
 * default of 1000 — silently, whatever `.limit()` asked for. One read of a
 * catalogue larger than that came back short on every fetch, so the listings
 * never looked complete and the thin-page filter below was skipped for
 * exactly the workspaces with the most pages. The read is paged instead:
 * `fetchChunk` is asked for [from, to] (a `.range()`), the `count` it returns
 * says when everything has been collected, and LISTING_MAX_CHUNKS bounds the
 * work. A chunk error ends the read and is reported the way the single read's
 * error was, with the rows collected so far, so the caller's fail-open rule
 * is unchanged: an error, or fewer rows than the count, means incomplete.
 */
export const LISTING_CHUNK_SIZE = 1000;
export const LISTING_MAX_CHUNKS = 50;

export type ChunkRead<T> = {
  data: T[] | null;
  error: { message: string } | null;
  count: number | null;
};

/**
 * `map`, when given, turns each row into what the caller keeps as its chunk
 * arrives (one row in, one row out — offsets stay exact), so the chunk's raw
 * rows can be dropped before the next one is read.
 */
export async function readInChunks<T, U = T>(
  fetchChunk: (from: number, to: number) => Promise<ChunkRead<T>>,
  {
    chunkSize = LISTING_CHUNK_SIZE,
    maxChunks = LISTING_MAX_CHUNKS,
    map,
  }: { chunkSize?: number; maxChunks?: number; map?: (row: T) => U } = {},
): Promise<ChunkRead<U>> {
  const rows: U[] = [];
  let count: number | null = null;
  for (let chunk = 0; chunk < maxChunks; chunk++) {
    // From where the rows actually stopped, not where the chunk was meant to
    // end, so a server capped below chunkSize is still paged completely.
    const from = rows.length;
    const res = await fetchChunk(from, from + chunkSize - 1);
    if (res.count != null) count = res.count;
    if (res.error) return { data: rows, error: res.error, count };
    const got = res.data ?? [];
    for (const row of got) rows.push(map ? map(row) : (row as unknown as U));
    if (got.length === 0) break;
    // Done when the count says so; without one, a short chunk is the end.
    if (count != null ? rows.length >= count : got.length < chunkSize) break;
  }
  return { data: rows, error: null, count };
}

/**
 * The sitemaps protocol allows 50,000 URLs (and 50 MB) per file. Above that,
 * the tenant sitemap is a <sitemapindex> of /a/sitemap.xml?page=1…N, each a
 * <urlset> of at most this many URLs. Under /a/ because on a root-domain
 * connection the Founders edge forwards only /a/* (query string included).
 */
export const SITEMAP_MAX_URLS = 50_000;

/**
 * Page reads come in LISTING_CHUNK_SIZE-row chunks too. 200 chunks cover
 * 200,000 pages — well past any plan's capacity (Agency 5,000 plus ten
 * 1,000-page add-ons) — while bounding one request's work.
 */
export const PAGE_MAX_CHUNKS = 200;

export type SitemapEntry = { loc: string; lastmod: string };

const SITEMAP_NS = "http://www.sitemaps.org/schemas/sitemap/0.9";

function urlsetXml(entries: readonly SitemapEntry[]): string {
  const urls = entries
    .map((e) => `  <url><loc>${e.loc}</loc><lastmod>${e.lastmod}</lastmod></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="${SITEMAP_NS}">\n${urls}\n</urlset>`;
}

/**
 * The document for a tenant's URL entries (already escaped, in order): one
 * <urlset> up to `maxUrls`; above that, with no `page`, a <sitemapindex>
 * naming https://<host>/a/sitemap.xml?page=1…N (each child's lastmod is the
 * newest in its slice); with `page` = k, the k-th slice as a <urlset> — empty
 * when k is past the end, so a stale child URL is still a valid sitemap.
 */
export function sitemapDocument(
  entries: readonly SitemapEntry[],
  { host, page, maxUrls = SITEMAP_MAX_URLS }: { host: string; page?: number; maxUrls?: number },
): string {
  if (page !== undefined) return urlsetXml(entries.slice((page - 1) * maxUrls, page * maxUrls));
  if (entries.length <= maxUrls) return urlsetXml(entries);
  const children: string[] = [];
  for (let i = 0; i * maxUrls < entries.length; i++) {
    const slice = entries.slice(i * maxUrls, (i + 1) * maxUrls);
    const lastmod = slice.reduce((max, e) => (e.lastmod > max ? e.lastmod : max), slice[0]!.lastmod);
    children.push(
      `  <sitemap><loc>https://${host}/a/sitemap.xml?page=${i + 1}</loc><lastmod>${lastmod}</lastmod></sitemap>`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="${SITEMAP_NS}">\n${children.join("\n")}\n</sitemapindex>`;
}

/**
 * The `page` query parameter of a sitemap request: undefined when absent, a
 * page number 1–9999, or null when present but not one (the route answers 404).
 */
export function sitemapPageParam(requestUrl: string): number | undefined | null {
  const raw = new URL(requestUrl).searchParams.get("page");
  if (raw === null) return undefined;
  return /^[1-9]\d{0,3}$/.test(raw) ? Number(raw) : null;
}

/** One page as the sitemap keeps it: the body measured for the thin-page rule, then dropped. */
type SitemapPage = {
  slug: string | null;
  updated_at: string | null;
  listing_filter: ListingFilter | null;
  body_chars: number;
  legacy: boolean;
};

function toSitemapPage(row: any, legacy: boolean): SitemapPage {
  return {
    slug: row.slug ?? null,
    updated_at: row.updated_at ?? null,
    listing_filter: legacy ? null : (row.listing_filter ?? null),
    body_chars: thinPageBodyChars(row.body_markdown),
    legacy,
  };
}

/** Newest first (then by slug), the order the sitemap listed pages in before its reads were chunked. */
function newestFirst(a: SitemapPage, b: SitemapPage): number {
  // Missing or unparseable dates sort last, so the comparator stays consistent.
  const at = (p: SitemapPage) => {
    const t = p.updated_at ? Date.parse(p.updated_at) : NaN;
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  };
  const ta = at(a);
  const tb = at(b);
  if (ta !== tb) return tb > ta ? 1 : -1;
  const sa = String(a.slug ?? "");
  const sb = String(b.slug ?? "");
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * Tenant page sitemap XML for a host. Returns null when the host is not a
 * verified tenant host (caller should fall back to the platform sitemap), or,
 * when it is, a (possibly empty) <urlset> — or, above SITEMAP_MAX_URLS, a
 * <sitemapindex> of /a/sitemap.xml?page=N, whose `page` then selects one
 * <urlset> (see sitemapDocument).
 */
export async function tenantSitemapXml(
  hostname: string,
  opts: { page?: number } = {},
): Promise<string | null> {
  const workspaceId = await workspaceIdForHost(hostname);
  if (!workspaceId) return null;

  // A workspace whose pages no longer serve must not keep advertising them.
  // Leaving them in the sitemap after cancellation points Google at URLs that
  // now 404, which is the slowest possible way to get them deindexed and
  // makes the customer's site look broken rather than simply unsubscribed.
  // Fails open, for the same reason the page path does: a read error must not
  // blank a paying customer's sitemap.
  const { data: billing, error: billingError } = await sb()
    .from("workspaces")
    .select("subscription_status, trial_ends_at, current_period_end")
    .eq("id", workspaceId)
    .maybeSingle();
  if (billingError) {
    console.error("[tenantSitemapXml] billing read failed, emitting anyway:", billingError.message);
  } else if (billing) {
    // Same reasoning as the page-serving gate: a beta account is entitled by
    // its grant, not by Stripe. `null` means the grant read failed, which is
    // not evidence of no grant — emit the sitemap rather than blank it.
    const granted = await readGrantedPagesOrNull(workspaceId);
    const decision = decideCapacity({
      subscriptionStatus: billing.subscription_status,
      trialEndsAt: billing.trial_ends_at,
      currentPeriodEnd: billing.current_period_end,
      grantedPages: granted ?? 0,
    });
    if (granted !== null && !decision.serve) {
      // An empty urlset, not null: the host IS a verified tenant host, so
      // falling back to the platform sitemap would advertise founders.click
      // URLs on the customer's domain.
      return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;
    }
  }
  // Emit URLs on the host that was actually requested, NOT the www-stripped
  // lookup key. a.$slug.tsx canonicalizes to the request host, so using the
  // stripped key here made the sitemap advertise https://customer.com/a/x
  // while the page itself declared https://www.customer.com/a/x canonical —
  // Google sees a sitemap of URLs that canonicalize somewhere else. Worse, a
  // customer who connected only `www` has no apex route at all, so every
  // sitemap URL would fail to resolve.
  const h = requestHost(hostname);

  // Every read comes in as many 1,000-row chunks as it needs (readInChunks),
  // over a fixed order (id), so chunks neither overlap nor skip. The page
  // reads used to be one read each asking for up to 50,000 rows, which
  // PostgREST's max-rows (~1,000 by default) capped silently: a workspace past
  // 1,000 pages had the rest left out of its sitemap (round-4 release review
  // M4).
  //
  // body_markdown and listing_filter ride along with each page, and the
  // workspace's published listings come in too: together they let the
  // sitemap apply the page's own thin-page rule (below) without a count query
  // per page. Bodies are the largest part of the payload, so each one is
  // measured as its chunk arrives and dropped (toSitemapPage): memory holds
  // one chunk of bodies, not the whole catalogue. This response is cached for
  // an hour.
  const [tenantRead, legacyRead, listingsRead] = await Promise.all([
    readInChunks<unknown, SitemapPage>(
      (from, to) =>
        sb()
          .from("tenant_pages")
          .select("id, slug, updated_at, body_markdown, listing_filter", { count: "exact" })
          .eq("workspace_id", workspaceId)
          .eq("status", "published")
          .order("id", { ascending: true })
          .range(from, to),
      { maxChunks: PAGE_MAX_CHUNKS, map: (row) => toSitemapPage(row, false) },
    ),
    readInChunks<unknown, SitemapPage>(
      (from, to) =>
        sb()
          .from("content_pages")
          .select("id, slug, updated_at, body_markdown", { count: "exact" })
          .eq("workspace_id", workspaceId)
          .eq("status", "published")
          .eq("in_sitemap", true)
          .order("id", { ascending: true })
          .range(from, to),
      { maxChunks: PAGE_MAX_CHUNKS, map: (row) => toSitemapPage(row, true) },
    ),
    readInChunks<ListingLocation>((from, to) =>
      sb()
        .from("tenant_listings")
        .select("city, state, category", { count: "exact" })
        .eq("workspace_id", workspaceId)
        .eq("state_published", true)
        // Paging is only stable over a fixed order.
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);

  // THE THIN-PAGE RULE, applied here too. a.$slug.tsx renders a page with no
  // listings and under 300 body characters as `noindex, follow`; listing such
  // a URL here tells Google to crawl a page that then asks not to be indexed,
  // which Search Console reports as an error against the whole sitemap.
  //
  // Fails OPEN, like everything else on this path: if the listings read
  // errored, or stopped short of its count (a chunk failed, or the catalogue
  // outgrew LISTING_MAX_CHUNKS reads) so some pages' listings were never seen,
  // every page would look empty and a paying customer's sitemap would shrink
  // over a transient. Then the filter is skipped, not guessed.
  const listingRows = (listingsRead.data ?? []) as ListingLocation[];
  const listingsComplete =
    !listingsRead.error &&
    (listingsRead.count == null || listingsRead.count <= listingRows.length);
  if (!listingsComplete) {
    console.error(
      "[tenantSitemapXml] listings read incomplete, skipping the thin-page filter:",
      listingsRead.error?.message ?? `${listingRows.length} of ${listingsRead.count} rows`,
    );
  }
  const countListings = listingsComplete ? buildListingCounter(listingRows) : null;

  // A page read that errored or stopped short of its count lists what it
  // read, as a single capped read used to; it is logged, never silent.
  for (const [table, read] of [
    ["tenant_pages", tenantRead],
    ["content_pages", legacyRead],
  ] as const) {
    const got = read.data?.length ?? 0;
    if (read.error || (read.count != null && read.count > got)) {
      console.error(
        `[tenantSitemapXml] ${table} read incomplete, listing the rows read:`,
        read.error?.message ?? `${got} of ${read.count} rows`,
      );
    }
  }

  const seen = new Set<string>();
  const rows = [
    // Newest first within each source, as before the reads were chunked.
    ...[...(tenantRead.data ?? [])].sort(newestFirst),
    // Legacy content_pages render with no listings at all (see
    // getPublicTenantPage), so only their body decides.
    ...[...(legacyRead.data ?? [])].sort(newestFirst),
  ].filter((p) => {
    const slug = String(p.slug || "").replace(/^\/+/, "");
    // A slug the page route refuses (isPublicPageSlug) would only ever 404;
    // never advertise it.
    if (!slug || !isPublicPageSlug(slug) || seen.has(slug)) return false;
    // Claimed before the thin test: the page path serves the first match for
    // a slug, so a thin tenant page must not let a legacy twin take its place.
    seen.add(slug);
    if (countListings) {
      const listingCount = p.legacy ? 0 : countListings(p.listing_filter ?? {});
      if (isThinPageMeasured({ listingCount, bodyChars: p.body_chars })) return false;
    }
    return true;
  });

  const now = new Date().toISOString();
  const entries: SitemapEntry[] = rows.map((p) => {
    const slug = String(p.slug || "").replace(/^\/+/, "");
    const updated = p.updated_at ? Date.parse(p.updated_at) : NaN;
    return {
      loc: `https://${h}/a/${escapeXml(slug)}`,
      lastmod: Number.isFinite(updated) ? new Date(updated).toISOString() : now,
    };
  });

  return sitemapDocument(entries, { host: h, page: opts.page });
}
