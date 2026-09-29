/**
 * THE TENANT SITEMAP — one generator.
 *
 * /a/sitemap.xml and /api/public/sitemap-by-host serve it, and the owner's
 * Sitemap screen (src/lib/sitemap-status.functions.ts) counts, validates,
 * rechecks and downloads the very same build. Nothing else decides which of a
 * tenant's URLs are advertised.
 *
 * HOST. A tenant sitemap is served only on the exact hostname a workspace
 * verified — case-insensitive, port removed, and `www.` NOT stripped
 * (www.example.com and example.com are two hosts, each proven separately).
 * resolveTenantHost mirrors current_workspace_id_by_host (migration
 * 20260929000200). Any other host gets a 404: an unknown host never receives
 * another customer's sitemap. Platform hosts serve the platform sitemap at
 * /sitemap.xml and nothing at /a/sitemap.xml. A customer's own /sitemap.xml
 * and robots.txt are never ours: the tenant sitemap lives at /a/sitemap.xml.
 *
 * ELIGIBILITY (collectSitemap). A tenant_pages row is listed when it is
 * published, not noindex, on an active template that has a renderer
 * (city_hub, category_page, resource_article), not thin by isThinForTemplate
 * (src/lib/thin-page.ts), not shadowed by a legacy redirect row, not a
 * reserved or unservable slug. Legacy content_pages rows that are published
 * and in_sitemap stay (read-only) unless a published tenant page or another
 * published legacy row claims the same slug — getPublicTenantPage serves the
 * tenant page first, and a doubled legacy slug serves nothing. Listing counts
 * come from ONE bounded aggregation (inventory_coverage_groups), matched in
 * memory with resolveFilter + listingMatches — never a query per page.
 *
 * READS NEVER GUESS. Every read is paged to its end (keyset on id, past
 * PostgREST's max-rows) and bounded; one that errors or stops short makes the
 * whole build incomplete, which the route answers with 503 (crawlers retry and
 * keep the last good copy) and the Sitemap screen reports as not checked —
 * never a silently shorter sitemap, never a green state.
 *
 * XML. UTF-8, escaped <loc>s, <lastmod> from the row's own timestamps (never
 * the time of the request), URLs in a stable order (first publication, then
 * id) so shard membership does not move when a page is edited. At most
 * 50,000 URLs and 50 MB (uncompressed) per file; more than one file is a
 * <sitemapindex> of /a/sitemap.xml?page=N, and a page that does not exist is
 * a 404.
 *
 * CACHING. `private, max-age=300` with `Vary: Host, X-Forwarded-Host`: a
 * change appears within five minutes, never instantly. Never a shared-cache
 * directive: the same path serves every customer's hostname, and a CDN that
 * ignores Vary (Cloudflare's does) would hand one tenant's sitemap to
 * another. The route memoizes each host's answer for a minute instead
 * (sitemapResponseMemo), keyed by the resolved host, so repeated requests do
 * not rebuild the sitemap from the database each time.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decideCapacity } from "@/lib/billing-capacity";
import { isThinForTemplate, thinPageBodyChars } from "@/lib/thin-page";
import { isPublicPageSlug } from "@/lib/public-page-slug";
import { PLATFORM_HOSTS } from "@/lib/security-headers";
import {
  TARGET_FIELDS,
  listingMatches,
  resolveFilter,
  type PageKind,
  type ResolvedFilter,
  type TargetField,
  type TargetKeys,
} from "@/lib/coverage/target";
import { TEMPLATE_CONTRACTS, isPageKind } from "@/lib/templates/contracts";

/** The slice of supabase-js the sitemap uses. Injectable: tests pass a fake. */
export type SitemapDb = {
  from: (table: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>, options?: Record<string, unknown>) => any;
};

const adminDb = (): SitemapDb => supabaseAdmin as unknown as SitemapDb;

// ---------------------------------------------------------------------------
// XML text
// ---------------------------------------------------------------------------

const XML_ESCAPES: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  "'": "&apos;",
  '"': "&quot;",
};

/** Characters XML 1.0 cannot carry at all: C0 controls other than tab/LF/CR,
 *  U+FFFE/U+FFFF and unpaired surrogates. */
const XML_FORBIDDEN_CHARS =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Text or attribute content, escaped; characters XML cannot carry are dropped. */
export function escapeXml(s: string): string {
  return s.replace(XML_FORBIDDEN_CHARS, "").replace(/[<>&'"]/g, (c) => XML_ESCAPES[c]!);
}

/** UTF-8 byte length without allocating (a lone surrogate encodes as U+FFFD: 3 bytes). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

/**
 * The host a request asked for: the LAST x-forwarded-host entry (or the Host
 * header), lower-cased, without scheme, path or port. `www.` is KEPT — it is a
 * different host, and the sitemap's URLs are built from exactly this value.
 *
 * The last entry, because a proxy that appends (rather than replaces) puts
 * the value IT saw last: a customer CDN in customer_proxy mode that appends
 * would otherwise let a visitor-supplied first entry choose the tenant. The
 * edge Worker sets a single value, so for it first and last are the same.
 */
export function requestHost(raw: string | null | undefined): string {
  return (
    String(raw ?? "")
      .split(",")
      .pop() ?? ""
  )
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "");
}

const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The resolver's key for a host — requestHost(), and only when it can be a
 * verified hostname at all (DNS letters, digits, dashes and dots; at least one
 * dot). Everything else resolves to nobody, so no LIKE wildcard, space or
 * trailing dot ever reaches a query.
 */
export function hostKey(raw: string | null | undefined): string | null {
  const h = requestHost(raw);
  return HOSTNAME_RE.test(h) ? h : null;
}

/** founders.click and www.founders.click — the hosts that serve the platform, exactly. */
export function isPlatformHost(raw: string | null | undefined): boolean {
  return PLATFORM_HOSTS.has(requestHost(raw));
}

const LOCAL_DEV_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Where /sitemap.xml answers with the platform sitemap: the platform hosts
 *  (and a local dev server). Anywhere else it is a 404. */
export function servesPlatformSitemap(raw: string | null | undefined): boolean {
  const h = requestHost(raw);
  return PLATFORM_HOSTS.has(h) || LOCAL_DEV_HOSTS.has(h);
}

/** One candidate answer to "which workspace does this host belong to?". */
export type HostMatch = {
  workspaceId: string;
  /**
   * Where the match came from. A verified `workspace_domains` row is proof of
   * ownership of THIS hostname (a DNS/file challenge passed for it).
   * `marketplace_domain` is the legacy workspace-level field, gated only by
   * the workspace-level domain_verified_at.
   */
  source: "workspace_domains" | "marketplace_domain";
  /** verified_at (custom domain) or domain_verified_at (legacy). */
  verifiedAt: string | null;
};

/**
 * THE PREFERENCE RULE, shared with current_workspace_id_by_host. The two
 * sources can name different workspaces for one hostname, so the order is
 * explicit: a verified custom domain outranks the legacy branch; within a
 * source the most recent verification wins (unknown dates last, like SQL's
 * NULLS LAST), then the lowest workspace id.
 */
export function preferredHostMatch(matches: readonly HostMatch[]): HostMatch | null {
  if (matches.length === 0) return null;
  const rank = (m: HostMatch) => (m.source === "workspace_domains" ? 0 : 1);
  const at = (m: HostMatch) => {
    const t = m.verifiedAt ? Date.parse(m.verifiedAt) : NaN;
    return Number.isFinite(t) ? t : Number.MIN_SAFE_INTEGER;
  };
  const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...matches].sort(
    (a, b) => rank(a) - rank(b) || at(b) - at(a) || byId(a.workspaceId, b.workspaceId),
  )[0]!;
}

export type HostResolution =
  | { kind: "tenant"; host: string; workspaceId: string }
  | { kind: "platform"; host: string }
  | { kind: "unknown"; host: string }
  | { kind: "error"; host: string; message: string };

/**
 * Which workspace, if any, serves its sitemap on this host. The app-side
 * mirror of current_workspace_id_by_host (20260929000200): the same two
 * sources (a verified workspace_domains row; the legacy verified
 * marketplace_domain), the same EXACT comparison — lower(stored) = the
 * request host, case-insensitive, port removed, nothing else stripped — and
 * the same preference (preferredHostMatch). `ilike` with a validated host
 * (no `%` or `_` can occur) is that case-insensitive equality; the rows are
 * compared again here, exactly.
 *
 * Both reads must succeed. A failed read is "error", never a guess from the
 * other source: with the verified-domain read missing, the legacy branch alone
 * could name a different workspace for the host.
 */
export async function resolveTenantHost(
  raw: string,
  db: SitemapDb = adminDb(),
): Promise<HostResolution> {
  const host = hostKey(raw);
  if (!host) return { kind: "unknown", host: requestHost(raw) };
  if (PLATFORM_HOSTS.has(host)) return { kind: "platform", host };

  const [domains, workspaces] = await Promise.all([
    db
      .from("workspace_domains")
      .select("workspace_id, hostname, verified_at")
      .eq("verified", true)
      .ilike("hostname", host),
    db
      .from("workspaces")
      .select("id, marketplace_domain, domain_verified_at")
      .ilike("marketplace_domain", host)
      .not("domain_verified_at", "is", null),
  ]);
  if (domains.error || workspaces.error) {
    return {
      kind: "error",
      host,
      message: String(domains.error?.message ?? workspaces.error?.message ?? "host lookup failed"),
    };
  }
  const matches: HostMatch[] = [
    ...((domains.data ?? []) as any[])
      .filter((d) => String(d.hostname ?? "").toLowerCase() === host)
      .map((d) => ({
        workspaceId: String(d.workspace_id),
        source: "workspace_domains" as const,
        verifiedAt: (d.verified_at as string | null) ?? null,
      })),
    ...((workspaces.data ?? []) as any[])
      .filter(
        (w) =>
          String(w.marketplace_domain ?? "").toLowerCase() === host && w.domain_verified_at != null,
      )
      .map((w) => ({
        workspaceId: String(w.id),
        source: "marketplace_domain" as const,
        verifiedAt: (w.domain_verified_at as string | null) ?? null,
      })),
  ];
  const best = preferredHostMatch(matches);
  return best ? { kind: "tenant", host, workspaceId: best.workspaceId } : { kind: "unknown", host };
}

/**
 * The workspace a verified host belongs to, or null (unknown host, platform
 * host, or a failed lookup — logged; never a partial guess).
 */
export async function workspaceIdForHost(hostname: string, db?: SitemapDb): Promise<string | null> {
  const r = await resolveTenantHost(hostname, db);
  if (r.kind === "error")
    console.error("[workspaceIdForHost] host lookup failed:", r.host, r.message);
  return r.kind === "tenant" ? r.workspaceId : null;
}

// ---------------------------------------------------------------------------
// Complete reads
// ---------------------------------------------------------------------------

/** Rows per request: PostgREST's default max-rows. */
export const READ_PAGE_SIZE = 1000;
/** A hard stop per table read — past any plan (Agency 5,000 pages plus add-ons). */
export const MAX_ROWS_PER_READ = 200_000;

export type ReadResult<T> = {
  rows: T[];
  /** false when the read errored, arrived out of order, or hit maxRows. */
  complete: boolean;
  error: string | null;
  calls: number;
};

/**
 * Read EVERY row of a query, keyset-paged on `id` (`id > last`, ordered by
 * id). Offsets are not used: a row deleted mid-read would shift every later
 * offset and one row would be skipped with nothing to show for it. A short
 * page is not taken as the end — a server may cap responses below
 * `pageSize` — so the read ends at an empty page. `map` turns each row into
 * what is kept as it arrives (bodies are measured and dropped here).
 */
export async function readKeyset<T = any>(
  makeQuery: () => any,
  {
    map,
    pageSize = READ_PAGE_SIZE,
    maxRows = MAX_ROWS_PER_READ,
  }: { map?: (row: any) => T; pageSize?: number; maxRows?: number } = {},
): Promise<ReadResult<T>> {
  const rows: T[] = [];
  let after: string | null = null;
  let calls = 0;
  for (;;) {
    let q = makeQuery();
    if (after !== null) q = q.gt("id", after);
    const { data, error } = await q.order("id", { ascending: true }).limit(pageSize);
    calls++;
    if (error) return { rows, complete: false, error: String(error.message ?? error), calls };
    const page = (data ?? []) as any[];
    if (page.length === 0) return { rows, complete: true, error: null, calls };
    const last = page[page.length - 1]?.id;
    if (typeof last !== "string" || (after !== null && last <= after)) {
      return { rows, complete: false, error: "rows arrived out of id order", calls };
    }
    for (const row of page) rows.push(map ? map(row) : (row as T));
    if (rows.length > maxRows) {
      return { rows, complete: false, error: `more than ${maxRows} rows`, calls };
    }
    after = last;
  }
}

// ---------------------------------------------------------------------------
// The inventory aggregation (listing counts for the thin rule)
// ---------------------------------------------------------------------------

export type CoverageGroup = {
  keys: TargetKeys;
  /** Published listings with exactly these keys. */
  listingCount: number;
  /** Of those, listings whose place/category text has no key yet (synced
   *  before the keys existed; keyed on their next sync). */
  unkeyedCount: number;
};

/** Groups past which the aggregation is refused as unbounded. */
export const MAX_COVERAGE_GROUPS = 200_000;

function toGroup(g: any): CoverageGroup {
  const key = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  return {
    keys: {
      countryKey: key(g?.country_key),
      regionKey: key(g?.region_key),
      cityKey: key(g?.city_key),
      categoryKey: key(g?.category_key),
    },
    listingCount: Math.max(0, Number(g?.listing_count) || 0),
    unkeyedCount: Math.max(0, Number(g?.unkeyed_count) || 0),
  };
}

/**
 * inventory_coverage_groups(ws): the workspace's published listings grouped by
 * their target keys — ONE call for any number of pages. The function returns
 * a set, which PostgREST caps at max-rows like any other, so the exact count
 * is asked for and a marketplace with more groups than one response holds is
 * read in ranges of the same, totally ordered, aggregation.
 */
export async function readCoverageGroups(
  db: SitemapDb,
  workspaceId: string,
): Promise<ReadResult<CoverageGroup>> {
  const rows: CoverageGroup[] = [];
  let total: number | null = null;
  let calls = 0;
  for (;;) {
    // From where the rows actually stopped, not where the range was meant to
    // end: a server that caps below READ_PAGE_SIZE is still read completely.
    const from = rows.length;
    const nulls = { ascending: true, nullsFirst: true };
    const { data, error, count } = await db
      .rpc("inventory_coverage_groups", { _workspace_id: workspaceId }, { count: "exact" })
      .order("country_key", nulls)
      .order("region_key", nulls)
      .order("city_key", nulls)
      .order("category_key", nulls)
      .range(from, from + READ_PAGE_SIZE - 1);
    calls++;
    if (error) return { rows, complete: false, error: String(error.message ?? error), calls };
    if (typeof count !== "number") {
      return { rows, complete: false, error: "the inventory total was not reported", calls };
    }
    if (total === null) total = count;
    else if (count !== total) {
      return {
        rows,
        complete: false,
        error: "the inventory changed while it was being read",
        calls,
      };
    }
    const page = (data ?? []) as any[];
    for (const g of page) rows.push(toGroup(g));
    if (rows.length >= total) {
      return {
        rows,
        complete: rows.length === total,
        error: rows.length === total ? null : `read ${rows.length} inventory groups of ${total}`,
        calls,
      };
    }
    if (page.length === 0 || rows.length > MAX_COVERAGE_GROUPS) {
      return {
        rows,
        complete: false,
        error: `read ${rows.length} inventory groups of ${total}`,
        calls,
      };
    }
  }
}

const NULL_KEY = "\u0000";
const KEY_SEP = "\u0001";
const KEY_OF_FIELD: Record<TargetField, keyof TargetKeys> = {
  country: "countryKey",
  region: "regionKey",
  city: "cityKey",
  category: "categoryKey",
};

/**
 * How many published listings a page's filter matches, answered from the
 * groups in memory. The groups are bucketed once per combination of
 * constrained fields, and every group in the page's bucket is confirmed with
 * listingMatches — the one definition of "this listing belongs to this page"
 * (src/lib/coverage/target.ts) — so the count is exactly what the renderer's
 * query (applyFilter) returns, at O(groups) per combination, not per page.
 */
export function buildGroupCounter(
  groups: readonly CoverageGroup[],
): (filter: ResolvedFilter) => number {
  const indexes = new Map<string, Map<string, CoverageGroup[]>>();
  return (filter) => {
    const fields = TARGET_FIELDS.filter((f) => f in filter.constraints);
    const signature = fields.join(",");
    let index = indexes.get(signature);
    if (!index) {
      index = new Map();
      for (const g of groups) {
        const k = fields.map((f) => g.keys[KEY_OF_FIELD[f]] ?? NULL_KEY).join(KEY_SEP);
        const bucket = index.get(k);
        if (bucket) bucket.push(g);
        else index.set(k, [g]);
      }
      indexes.set(signature, index);
    }
    const k = fields.map((f) => filter.constraints[f] ?? NULL_KEY).join(KEY_SEP);
    let n = 0;
    for (const g of index.get(k) ?? []) {
      if (listingMatches(g.keys, filter)) n += g.listingCount;
    }
    return n;
  };
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/** Why a page is not in the sitemap. Every page is counted under one reason. */
export const EXCLUSION_REASONS = [
  "draft",
  "archived",
  "suspended",
  "noindex",
  "thin",
  "template_unavailable",
  "redirected",
  "duplicate_slug",
  "reserved",
  "invalid_slug",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];
export type ExclusionCounts = Record<ExclusionReason, number>;

export function emptyExclusions(): ExclusionCounts {
  return Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, 0])) as ExclusionCounts;
}

/** Slugs a static /a/ route answers before any page could (a.founders-domain-test.tsx). */
export const RESERVED_PAGE_SLUGS: ReadonlySet<string> = new Set(["founders-domain-test"]);

/** One URL the sitemap lists. */
export type SitemapUrl = {
  id: string;
  slug: string;
  source: "page" | "legacy";
  /** The row's own content timestamp (W3C, seconds) — null when it has none. */
  lastmod: string | null;
  /** The stable order: first publication (tenant pages) or creation (legacy), ms. */
  orderAt: number;
};

export type ServingDecision = { serve: boolean; state: string; reason: string };

export type SitemapCollection = {
  workspaceId: string;
  /** false: a read failed or stopped short — nothing below may be trusted as complete. */
  complete: boolean;
  /** Why the collection is incomplete, in sentences an owner can read. */
  problems: string[];
  /** Eligible URLs in their stable order. */
  urls: SitemapUrl[];
  excluded: ExclusionCounts;
  /** true when draft / archived / suspended were counted (the Sitemap screen). */
  statusCounted: boolean;
  /** The workspace's serving decision (billing); null when there is no row to decide from. */
  serving: ServingDecision | null;
  warnings: string[];
  stats: {
    publishedPages: number;
    legacyPages: number;
    /** inventory_coverage_groups requests made (1 for up to 1,000 groups; 0 when no page needs a count). */
    aggregationCalls: number;
    unkeyedListings: number;
    invalidFilters: number;
  };
};

const PAGE_COLUMNS =
  "id, slug, status, noindex, template_id, listing_filter, published_at, created_at, updated_at";
const LEGACY_COLUMNS = "id, slug, in_sitemap, created_at, updated_at, body_markdown";
const REDIRECT_COLUMNS = "id, slug, url_path, redirect_to";

type PageRow = {
  id: string;
  slug: string;
  noindex: boolean;
  templateId: string | null;
  listingFilter: unknown;
  publishedAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};

type LegacyRow = {
  id: string;
  slug: string;
  inSitemap: boolean;
  createdAt: unknown;
  updatedAt: unknown;
  bodyChars: number;
};

function toPageRow(r: any): PageRow {
  return {
    id: String(r.id),
    slug: typeof r.slug === "string" ? r.slug : "",
    noindex: r.noindex === true,
    templateId: r.template_id == null ? null : String(r.template_id),
    listingFilter: r.listing_filter,
    publishedAt: r.published_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** A legacy row as the sitemap keeps it: the body measured, then dropped. */
function toLegacyRow(r: any): LegacyRow {
  return {
    id: String(r.id),
    slug: typeof r.slug === "string" ? r.slug : "",
    inSitemap: r.in_sitemap === true,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    bodyChars: thinPageBodyChars(r.body_markdown),
  };
}

function parseTime(v: unknown): number | null {
  if (typeof v !== "string" || v === "") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** A W3C datetime at seconds precision: 2026-09-28T12:34:56Z. */
export function w3cDatetime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The newest of the row's own timestamps — never the time of the request. */
function lastmodOf(...values: unknown[]): string | null {
  let best: number | null = null;
  for (const v of values) {
    const t = parseTime(v);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best === null ? null : w3cDatetime(best);
}

/** Unknown dates order last (then by id), deterministically. */
const ORDER_UNKNOWN = Number.MAX_SAFE_INTEGER;
function orderAtOf(...values: unknown[]): number {
  for (const v of values) {
    const t = parseTime(v);
    if (t !== null) return t;
  }
  return ORDER_UNKNOWN;
}

export function compareSitemapUrls(a: SitemapUrl, b: SitemapUrl): number {
  if (a.orderAt !== b.orderAt) return a.orderAt < b.orderAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The slugs a legacy redirect row answers for. getPublicTenantPage redirects
 * a slug when a content_pages row with status 'redirect' and a redirect_to
 * has that slug, or the url_path /a/{slug} or /p/{slug} — exactly, before it
 * looks at any page.
 */
export function redirectShadows(
  rows: ReadonlyArray<{ slug?: unknown; url_path?: unknown; redirect_to?: unknown }>,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (typeof r.redirect_to !== "string" || r.redirect_to === "") continue;
    if (typeof r.slug === "string" && r.slug !== "") out.add(r.slug);
    if (typeof r.url_path === "string") {
      const m = /^\/[ap]\/(.+)$/.exec(r.url_path);
      if (m) out.add(m[1]!);
    }
  }
  return out;
}

function grantedPagesFrom(data: unknown): number {
  // The normalization of readGrantedPages (entitlement-grants.server.ts).
  const n = typeof data === "number" ? data : Number(data ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

type TemplateInfo = { kind: PageKind | null; active: boolean };

/**
 * Everything the sitemap knows about a workspace's pages: the eligible URLs
 * in their stable order, and every other page counted under the reason it is
 * left out. `statusCounts` adds the draft / archived / suspended counts (the
 * Sitemap screen); `stopWhenPaused` skips the page reads when billing says
 * the workspace's pages do not serve (the route: an empty sitemap).
 */
export async function collectSitemap(
  workspaceId: string,
  {
    db = adminDb(),
    statusCounts = false,
    stopWhenPaused = false,
  }: { db?: SitemapDb; statusCounts?: boolean; stopWhenPaused?: boolean } = {},
): Promise<SitemapCollection> {
  const out: SitemapCollection = {
    workspaceId,
    complete: true,
    problems: [],
    urls: [],
    excluded: emptyExclusions(),
    statusCounted: false,
    serving: null,
    warnings: [],
    stats: {
      publishedPages: 0,
      legacyPages: 0,
      aggregationCalls: 0,
      unkeyedListings: 0,
      invalidFilters: 0,
    },
  };
  const fail = (problem: string, detail: string) => {
    out.complete = false;
    out.problems.push(problem);
    console.error(`[sitemap] ${workspaceId}: ${problem} (${detail})`);
  };

  // 1. Billing: the same gate as the page path (getPublicTenantPage) — pages
  // that do not serve are not advertised. A read that fails is not a verdict
  // either way, so the build is incomplete rather than guessed.
  const billing = await db
    .from("workspaces")
    .select("subscription_status, trial_ends_at, current_period_end")
    .eq("id", workspaceId)
    .maybeSingle();
  if (billing.error) {
    fail("Couldn't read the workspace's billing status.", String(billing.error.message));
    return out;
  }
  if (billing.data) {
    const granted = await db.rpc("workspace_granted_pages", { _workspace_id: workspaceId });
    if (granted.error) {
      fail("Couldn't read the workspace's page grants.", String(granted.error.message));
      return out;
    }
    const decision = decideCapacity({
      subscriptionStatus: billing.data.subscription_status,
      trialEndsAt: billing.data.trial_ends_at,
      currentPeriodEnd: billing.data.current_period_end,
      grantedPages: grantedPagesFrom(granted.data),
    });
    out.serving = { serve: decision.serve, state: decision.state, reason: decision.reason };
    if (!decision.serve && stopWhenPaused) return out;
  }

  // 2. The reads, in parallel. Pages without their bodies: a listing
  // template's page is decided by its listings, so only the pages judged on
  // their body (resource articles, legacy content) have it read.
  const countStatus = (status: string) =>
    db
      .from("tenant_pages")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", status);
  const [templatesRes, pagesRes, legacyRes, redirectsRes, statusRes] = await Promise.all([
    readKeyset<{ id: string; slug: unknown; is_active: unknown }>(() =>
      db.from("page_templates").select("id, slug, is_active"),
    ),
    readKeyset<PageRow>(
      () =>
        db
          .from("tenant_pages")
          .select(PAGE_COLUMNS)
          .eq("workspace_id", workspaceId)
          .eq("status", "published"),
      { map: toPageRow },
    ),
    readKeyset<LegacyRow>(
      () =>
        db
          .from("content_pages")
          .select(LEGACY_COLUMNS)
          .eq("workspace_id", workspaceId)
          .eq("status", "published"),
      { map: toLegacyRow },
    ),
    readKeyset(() =>
      db
        .from("content_pages")
        .select(REDIRECT_COLUMNS)
        .eq("workspace_id", workspaceId)
        .eq("status", "redirect"),
    ),
    statusCounts
      ? Promise.all([
          countStatus("draft"),
          countStatus("archived"),
          countStatus("billing_suspended"),
        ])
      : Promise.resolve(null),
  ]);

  if (!templatesRes.complete) fail("Couldn't read the page templates.", String(templatesRes.error));
  if (!pagesRes.complete)
    fail("Couldn't read all of your published pages.", String(pagesRes.error));
  if (!legacyRes.complete)
    fail("Couldn't read all of your older (imported) pages.", String(legacyRes.error));
  if (!redirectsRes.complete) fail("Couldn't read your redirects.", String(redirectsRes.error));
  if (statusRes) {
    const [draft, archived, suspended] = statusRes;
    const bad = [draft, archived, suspended].find(
      (r: any) => r.error || typeof r.count !== "number",
    );
    if (bad) {
      fail(
        "Couldn't count your draft and archived pages.",
        String(bad.error?.message ?? "no count"),
      );
    } else {
      out.excluded.draft = draft.count;
      out.excluded.archived = archived.count;
      out.excluded.suspended = suspended.count;
      out.statusCounted = true;
    }
  }
  if (!out.complete) return out;

  const templates = new Map<string, TemplateInfo>();
  for (const t of templatesRes.rows) {
    templates.set(String(t.id), {
      kind: isPageKind(t.slug) ? t.slug : null,
      active: t.is_active === true,
    });
  }
  const shadowed = redirectShadows(redirectsRes.rows as any[]);
  out.stats.publishedPages = pagesRes.rows.length;

  // 3. Tenant pages. A published tenant page owns its slug even when it is
  // left out (noindex, thin…): the page path serves it before any legacy row.
  const claimed = new Set<string>();
  const needCount: Array<{ page: PageRow; kind: PageKind }> = [];
  const needBody: PageRow[] = [];
  const bodyTemplateIds = new Set<string>();
  for (const p of pagesRes.rows) {
    if (!isPublicPageSlug(p.slug)) {
      out.excluded.invalid_slug++;
      continue;
    }
    if (RESERVED_PAGE_SLUGS.has(p.slug)) {
      out.excluded.reserved++;
      continue;
    }
    if (shadowed.has(p.slug)) {
      out.excluded.redirected++;
      continue;
    }
    claimed.add(p.slug);
    if (p.noindex) {
      out.excluded.noindex++;
      continue;
    }
    const t = p.templateId ? templates.get(p.templateId) : undefined;
    if (!t || !t.active || !t.kind) {
      out.excluded.template_unavailable++;
      continue;
    }
    if (TEMPLATE_CONTRACTS[t.kind].requiresListings) needCount.push({ page: p, kind: t.kind });
    else {
      needBody.push(p);
      bodyTemplateIds.add(p.templateId!);
    }
  }

  // 4. Listing counts (one aggregation) and the bodies of body-judged pages.
  const [groupsRes, bodiesRes] = await Promise.all([
    needCount.length > 0 ? readCoverageGroups(db, workspaceId) : Promise.resolve(null),
    needBody.length > 0
      ? readKeyset<{ id: string; bodyChars: number }>(
          () =>
            db
              .from("tenant_pages")
              .select("id, body_markdown")
              .eq("workspace_id", workspaceId)
              .eq("status", "published")
              .in("template_id", [...bodyTemplateIds].sort()),
          {
            map: (r: any) => ({ id: String(r.id), bodyChars: thinPageBodyChars(r.body_markdown) }),
          },
        )
      : Promise.resolve(null),
  ]);
  if (groupsRes) {
    out.stats.aggregationCalls = groupsRes.calls;
    if (!groupsRes.complete)
      fail("Couldn't count your published listings.", String(groupsRes.error));
  }
  if (bodiesRes && !bodiesRes.complete) {
    fail("Couldn't read the text of your resource articles.", String(bodiesRes.error));
  }
  if (!out.complete) return out;

  const eligible: SitemapUrl[] = [];
  const pageUrl = (p: PageRow): SitemapUrl => ({
    id: p.id,
    slug: p.slug,
    source: "page",
    lastmod: lastmodOf(p.updatedAt, p.publishedAt),
    orderAt: orderAtOf(p.publishedAt, p.createdAt, p.updatedAt),
  });

  if (groupsRes) {
    const countFor = buildGroupCounter(groupsRes.rows);
    out.stats.unkeyedListings = groupsRes.rows.reduce((n, g) => n + g.unkeyedCount, 0);
    for (const { page } of needCount) {
      const filter = resolveFilter(page.listingFilter ?? {});
      if (!filter) out.stats.invalidFilters++;
      const listingCount = filter ? countFor(filter) : 0;
      if (isThinForTemplate({ requiresListings: true, listingCount, bodyChars: 0 })) {
        out.excluded.thin++;
        continue;
      }
      eligible.push(pageUrl(page));
    }
  }
  if (bodiesRes) {
    const bodies = new Map(bodiesRes.rows.map((b) => [b.id, b.bodyChars]));
    for (const page of needBody) {
      const bodyChars = bodies.get(page.id);
      if (bodyChars === undefined) {
        // Published in the page read, gone from the body read: it changed
        // mid-build. Not a verdict — the next build decides.
        fail("A page changed while the sitemap was being built.", `no body for ${page.id}`);
        return out;
      }
      if (isThinForTemplate({ requiresListings: false, listingCount: 0, bodyChars })) {
        out.excluded.thin++;
        continue;
      }
      eligible.push(pageUrl(page));
    }
  }

  // 5. Legacy content_pages (read-only). Published rows count toward a
  // doubled slug whatever in_sitemap says (the page path reads them all);
  // only in_sitemap rows are candidates.
  const legacyPerSlug = new Map<string, number>();
  for (const r of legacyRes.rows) legacyPerSlug.set(r.slug, (legacyPerSlug.get(r.slug) ?? 0) + 1);
  for (const r of legacyRes.rows) {
    if (!r.inSitemap) continue;
    out.stats.legacyPages++;
    if (!isPublicPageSlug(r.slug)) out.excluded.invalid_slug++;
    else if (RESERVED_PAGE_SLUGS.has(r.slug)) out.excluded.reserved++;
    else if (shadowed.has(r.slug)) out.excluded.redirected++;
    else if (claimed.has(r.slug) || (legacyPerSlug.get(r.slug) ?? 0) > 1)
      out.excluded.duplicate_slug++;
    else if (
      isThinForTemplate({ requiresListings: false, listingCount: 0, bodyChars: r.bodyChars })
    ) {
      out.excluded.thin++;
    } else {
      eligible.push({
        id: r.id,
        slug: r.slug,
        source: "legacy",
        lastmod: lastmodOf(r.updatedAt, r.createdAt),
        orderAt: orderAtOf(r.createdAt, r.updatedAt),
      });
    }
  }

  // Tenant slugs are unique per workspace and legacy twins were settled
  // above; this is the last word on "one URL per slug".
  eligible.sort(compareSitemapUrls);
  const seen = new Set<string>();
  for (const u of eligible) {
    if (seen.has(u.slug)) {
      out.excluded.duplicate_slug++;
      continue;
    }
    seen.add(u.slug);
    out.urls.push(u);
  }

  if (out.stats.unkeyedListings > 0) {
    out.warnings.push(
      `${out.stats.unkeyedListings} published listing${out.stats.unkeyedListings === 1 ? " hasn't" : "s haven't"} been matched to a place or category yet — they count after the next sync.`,
    );
  }
  if (out.stats.invalidFilters > 0) {
    out.warnings.push(
      `${out.stats.invalidFilters} page${out.stats.invalidFilters === 1 ? " has" : "s have"} a listing filter that can't be read, so no listings match ${out.stats.invalidFilters === 1 ? "it" : "them"}.`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// XML documents: stable shards within both limits
// ---------------------------------------------------------------------------

export const SITEMAP_NS = "http://www.sitemaps.org/schemas/sitemap/0.9";
/** The sitemaps protocol's per-file limits: 50,000 URLs and 50 MB uncompressed. */
export const SITEMAP_MAX_URLS = 50_000;
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;

export type SitemapLimits = { maxUrls: number; maxBytes: number };
export const SITEMAP_LIMITS: SitemapLimits = {
  maxUrls: SITEMAP_MAX_URLS,
  maxBytes: SITEMAP_MAX_BYTES,
};

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';
export const URLSET_HEAD = `${XML_DECLARATION}<urlset xmlns="${SITEMAP_NS}">\n`;
export const URLSET_TAIL = "</urlset>\n";

export type SitemapEntry = { loc: string; lastmod: string | null };

/** A page's canonical URL on a verified host. */
export function sitemapLoc(host: string, slug: string): string {
  return `https://${host}/a/${encodeURIComponent(slug)}`;
}

/** Part k of a tenant sitemap that needs more than one file. */
export function sitemapPartUrl(host: string, k: number): string {
  return `https://${host}/a/sitemap.xml?page=${k}`;
}

export function urlEntryXml(e: SitemapEntry): string {
  const lastmod = e.lastmod ? `<lastmod>${escapeXml(e.lastmod)}</lastmod>` : "";
  return `  <url><loc>${escapeXml(e.loc)}</loc>${lastmod}</url>\n`;
}

export type Shard = { start: number; end: number; bytes: number };

/**
 * Cut the ordered entries into files: greedily, in order, each file closing
 * before it would pass maxUrls URLs or maxBytes bytes (the frame included).
 * The same entries always cut the same way, so a URL's file changes only when
 * URLs before it are added or removed — never because a page was edited.
 */
export function planShards(
  lineBytes: readonly number[],
  limits: SitemapLimits = SITEMAP_LIMITS,
): Shard[] {
  const frame = utf8Length(URLSET_HEAD) + utf8Length(URLSET_TAIL);
  const shards: Shard[] = [];
  let start = 0;
  let bytes = frame;
  for (let i = 0; i < lineBytes.length; i++) {
    const b = lineBytes[i]!;
    const count = i - start;
    if (count > 0 && (count >= limits.maxUrls || bytes + b > limits.maxBytes)) {
      shards.push({ start, end: i, bytes });
      start = i;
      bytes = frame;
    }
    bytes += b;
  }
  shards.push({ start, end: lineBytes.length, bytes });
  return shards;
}

export type SitemapPlan = {
  host: string;
  entries: SitemapEntry[];
  lines: string[];
  shards: Shard[];
  limits: SitemapLimits;
};

export function planSitemap(
  host: string,
  urls: readonly SitemapUrl[],
  limits: SitemapLimits = SITEMAP_LIMITS,
): SitemapPlan {
  const entries = urls.map((u) => ({ loc: sitemapLoc(host, u.slug), lastmod: u.lastmod }));
  return planEntries(host, entries, limits);
}

/** planSitemap for entries already turned into URLs (tests build them directly). */
export function planEntries(
  host: string,
  entries: SitemapEntry[],
  limits: SitemapLimits = SITEMAP_LIMITS,
): SitemapPlan {
  const lines = entries.map(urlEntryXml);
  return { host, entries, lines, shards: planShards(lines.map(utf8Length), limits), limits };
}

/** Part k (1-based) as a <urlset>. */
export function renderUrlset(plan: SitemapPlan, k: number): string {
  const s = plan.shards[k - 1];
  if (!s) throw new Error(`no sitemap part ${k}`);
  return URLSET_HEAD + plan.lines.slice(s.start, s.end).join("") + URLSET_TAIL;
}

/** The <sitemapindex> of every part; each part's lastmod is its newest URL's. */
export function renderIndex(plan: SitemapPlan): string {
  const parts = plan.shards.map((s, i) => {
    let newest: string | null = null;
    for (let j = s.start; j < s.end; j++) {
      const m = plan.entries[j]!.lastmod;
      if (m && (newest === null || m > newest)) newest = m;
    }
    const lastmod = newest ? `<lastmod>${escapeXml(newest)}</lastmod>` : "";
    return `  <sitemap><loc>${escapeXml(sitemapPartUrl(plan.host, i + 1))}</loc>${lastmod}</sitemap>\n`;
  });
  return `${XML_DECLARATION}<sitemapindex xmlns="${SITEMAP_NS}">\n${parts.join("")}</sitemapindex>\n`;
}

/**
 * What /a/sitemap.xml serves for `page`: without one, the index (more than
 * one part) or the single <urlset>; with k, part k. null: there is no such
 * part (404) — including any k on a host whose sitemap is one file, except 1.
 */
export function sitemapDocumentFor(plan: SitemapPlan, page: number | undefined): string | null {
  const n = plan.shards.length;
  if (page === undefined) return n > 1 ? renderIndex(plan) : renderUrlset(plan, 1);
  if (!Number.isInteger(page) || page < 1 || page > n) return null;
  return renderUrlset(plan, page);
}

/**
 * The `page` query parameter of a sitemap request: undefined when absent, a
 * part number 1–9999, or null when present but not one (the route answers 404).
 */
export function sitemapPageParam(requestUrl: string): number | undefined | null {
  const raw = new URL(requestUrl).searchParams.get("page");
  if (raw === null) return undefined;
  return /^[1-9]\d{0,3}$/.test(raw) ? Number(raw) : null;
}

// ---------------------------------------------------------------------------
// Parsing a sitemap (the in-process check and the live check read the same way)
// ---------------------------------------------------------------------------

export type ParsedSitemap = {
  /** No XML syntax error (structure problems are in `errors` too). */
  wellFormed: boolean;
  kind: "urlset" | "sitemapindex" | null;
  /** The <loc> of every <url> (urlset) or <sitemap> (index), decoded, in order. */
  locs: string[];
  lastmods: Array<string | null>;
  bytes: number;
  errors: string[];
};

const NAME_RE = /^[A-Za-z_][A-Za-z0-9._:-]*$/;
const REF_AT = /&(?:lt|gt|amp|quot|apos|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});/y;
export const W3C_DATETIME_RE =
  /^\d{4}(?:-\d{2}(?:-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?)?)?$/;
const XML_BAD_CHAR =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** XML's four whitespace characters: space, tab, CR, LF. */
function isXmlSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;
}

function allowedCodePoint(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

/**
 * A strict parser for the sitemap subset of XML: one root element, balanced
 * tags, quoted attributes, `&` only as a predefined entity or a character
 * reference, no DOCTYPE, no characters XML forbids. It also reads the
 * sitemap structure: <urlset>/<sitemapindex> in the sitemaps namespace, each
 * <url>/<sitemap> with exactly one <loc> and at most a well-formed <lastmod>.
 * Streaming (no DOM), so a 50,000-URL file is read in one pass.
 */
export function parseSitemapXml(
  xml: string,
  { maxErrors = 20 }: { maxErrors?: number } = {},
): ParsedSitemap {
  const out: ParsedSitemap = {
    wellFormed: true,
    kind: null,
    locs: [],
    lastmods: [],
    bytes: utf8Length(xml),
    errors: [],
  };
  const syntax = (msg: string) => {
    out.wellFormed = false;
    if (out.errors.length < maxErrors) out.errors.push(`not well-formed XML: ${msg}`);
  };
  const structure = (msg: string) => {
    if (out.errors.length < maxErrors) out.errors.push(msg);
  };

  const n = xml.length;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (xml.startsWith("<?xml", i) && /\s/.test(xml.charAt(i + 5))) {
    const end = xml.indexOf("?>", i);
    if (end < 0) {
      syntax("the XML declaration is never closed");
      return out;
    }
    const decl = xml.slice(i, end + 2);
    if (!/^<\?xml\s+version\s*=\s*(["'])1\.[0-9]+\1/.test(decl))
      syntax("the XML declaration has no version");
    const enc = /\sencoding\s*=\s*(["'])([^"']*)\1/.exec(decl);
    if (enc && enc[2]!.toLowerCase() !== "utf-8")
      structure(`the file declares ${enc[2]}, not UTF-8`);
    i = end + 2;
  }

  const stack: string[] = [];
  let rootSeen = false;
  let rootName: string | null = null;
  let entry: { locs: number; loc: string; lastmod: string | null } | null = null;
  let capture: "loc" | "lastmod" | "other" | null = null;
  let text = "";

  const decode = (raw: string): string | null => {
    let bad = false;
    const s = raw.replace(
      /&(lt|gt|amp|quot|apos|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});/g,
      (_m, e: string) => {
        if (e === "lt") return "<";
        if (e === "gt") return ">";
        if (e === "amp") return "&";
        if (e === "quot") return '"';
        if (e === "apos") return "'";
        const cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        if (!allowedCodePoint(cp)) {
          bad = true;
          return "";
        }
        return String.fromCodePoint(cp);
      },
    );
    return bad ? null : s;
  };
  const checkChars = (raw: string, where: string): string | null => {
    if (XML_BAD_CHAR.test(raw)) {
      syntax(`a character XML does not allow, in ${where}`);
      return null;
    }
    for (let at = raw.indexOf("&"); at >= 0; at = raw.indexOf("&", at + 1)) {
      REF_AT.lastIndex = at;
      if (!REF_AT.test(raw)) {
        syntax(`an unescaped "&" in ${where}`);
        return null;
      }
    }
    const decoded = decode(raw);
    if (decoded === null)
      syntax(`a character reference to a character XML does not allow, in ${where}`);
    return decoded;
  };

  const onText = (raw: string, cdata: boolean) => {
    if (stack.length === 0) {
      if (cdata || raw.trim() !== "") syntax("text outside the root element");
      return;
    }
    let decoded: string | null = raw;
    if (!cdata) {
      if (raw.includes("]]>")) syntax('"]]>" in text');
      decoded = checkChars(raw, `<${stack[stack.length - 1]}>`);
      if (decoded === null) return;
    } else if (XML_BAD_CHAR.test(raw)) {
      syntax("a character XML does not allow, in a CDATA section");
      return;
    }
    if (capture) text += decoded;
    // Text directly in the root or in a <url>/<sitemap> is stray; inside an
    // extension element (image:image…) it is that extension's business.
    else if (stack.length <= 2 && decoded.trim() !== "") {
      structure(`stray text inside <${stack[stack.length - 1]}>`);
    }
  };

  const onOpen = (name: string, attrs: Map<string, string>, depth: number) => {
    if (depth === 0) {
      rootName = name;
      if (name === "urlset" || name === "sitemapindex") out.kind = name;
      else structure(`the root element is <${name}>, not <urlset> or <sitemapindex>`);
      if (attrs.get("xmlns") !== SITEMAP_NS)
        structure("the root element is not in the sitemaps namespace");
      return;
    }
    if (!out.kind) return;
    const item = out.kind === "urlset" ? "url" : "sitemap";
    if (depth === 1) {
      if (name === item) entry = { locs: 0, loc: "", lastmod: null };
      else if (!name.includes(":")) structure(`unexpected <${name}> in <${rootName}>`);
      return;
    }
    if (depth === 2 && entry && stack[1] === item) {
      if (name === "loc" || name === "lastmod") {
        capture = name;
        text = "";
      } else if (out.kind === "urlset" && (name === "changefreq" || name === "priority")) {
        capture = "other";
        text = "";
      } else if (!name.includes(":")) structure(`unexpected <${name}> in <${item}>`);
    }
  };

  const onClose = (name: string, depth: number) => {
    if (depth === 2 && entry && capture) {
      if (name === "loc") {
        entry.locs++;
        entry.loc = text.trim();
      } else if (name === "lastmod") {
        const v = text.trim();
        if (!W3C_DATETIME_RE.test(v)) structure(`<lastmod>${v}</lastmod> is not a W3C datetime`);
        entry.lastmod = v;
      }
      capture = null;
      text = "";
      return;
    }
    if (depth === 1 && entry) {
      if (entry.locs !== 1 || entry.loc === "") {
        structure(`a <${name}> without exactly one non-empty <loc>`);
      } else {
        out.locs.push(entry.loc);
        out.lastmods.push(entry.lastmod);
      }
      entry = null;
    }
  };

  while (i < n && out.errors.length < maxErrors) {
    const lt = xml.indexOf("<", i);
    const end = lt < 0 ? n : lt;
    if (end > i) onText(xml.slice(i, end), false);
    if (lt < 0) break;
    if (xml.startsWith("<!--", lt)) {
      const c = xml.indexOf("-->", lt + 4);
      if (c < 0) {
        syntax("a comment is never closed");
        break;
      }
      if (xml.slice(lt + 4, c).includes("--")) syntax('"--" inside a comment');
      i = c + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const c = xml.indexOf("]]>", lt + 9);
      if (c < 0) {
        syntax("a CDATA section is never closed");
        break;
      }
      onText(xml.slice(lt + 9, c), true);
      i = c + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const c = xml.indexOf("?>", lt + 2);
      if (c < 0) {
        syntax("a processing instruction is never closed");
        break;
      }
      if (/^<\?xml(\s|\?)/i.test(xml.slice(lt, c + 2)))
        syntax("an XML declaration after the start of the file");
      i = c + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      syntax("a DOCTYPE or other declaration");
      const c = xml.indexOf(">", lt);
      i = c < 0 ? n : c + 1;
      continue;
    }
    if (xml.startsWith("</", lt)) {
      const c = xml.indexOf(">", lt);
      if (c < 0) {
        syntax("an end tag is never closed");
        break;
      }
      const name = xml.slice(lt + 2, c).trimEnd();
      const open = stack.pop();
      if (open === undefined) syntax(`</${name}> closes nothing`);
      else if (open !== name) syntax(`</${name}> where </${open}> belongs`);
      else onClose(name, stack.length);
      i = c + 1;
      continue;
    }
    // A start tag: <name attr="v" ...> or <name .../>
    let j = lt + 1;
    while (j < n && !isXmlSpace(xml.charCodeAt(j)) && xml[j] !== "/" && xml[j] !== ">") j++;
    const name = xml.slice(lt + 1, j);
    if (!NAME_RE.test(name)) {
      syntax(`"<${name.slice(0, 20)}" is not a tag`);
      break;
    }
    const attrs = new Map<string, string>();
    let selfClosing = false;
    let closed = false;
    while (j < n) {
      while (j < n && isXmlSpace(xml.charCodeAt(j))) j++;
      if (xml[j] === ">") {
        closed = true;
        j++;
        break;
      }
      if (xml[j] === "/" && xml[j + 1] === ">") {
        selfClosing = true;
        closed = true;
        j += 2;
        break;
      }
      const a = j;
      while (j < n && !isXmlSpace(xml.charCodeAt(j)) && !"=/>".includes(xml[j]!)) j++;
      const attr = xml.slice(a, j);
      while (j < n && isXmlSpace(xml.charCodeAt(j))) j++;
      if (!NAME_RE.test(attr) || xml[j] !== "=") {
        syntax(`a malformed attribute in <${name}>`);
        break;
      }
      j++;
      while (j < n && isXmlSpace(xml.charCodeAt(j))) j++;
      const quote = xml[j];
      if (quote !== '"' && quote !== "'") {
        syntax(`an unquoted attribute value in <${name}>`);
        break;
      }
      const close = xml.indexOf(quote, j + 1);
      if (close < 0) {
        syntax(`an attribute value in <${name}> is never closed`);
        break;
      }
      const rawValue = xml.slice(j + 1, close);
      if (rawValue.includes("<")) syntax(`a "<" inside an attribute of <${name}>`);
      if (attrs.has(attr)) syntax(`the attribute ${attr} twice in <${name}>`);
      const value = checkChars(rawValue, `an attribute of <${name}>`);
      attrs.set(attr, value ?? "");
      j = close + 1;
    }
    if (!closed) {
      if (out.wellFormed) syntax(`<${name}> is never closed`);
      break;
    }
    if (stack.length === 0) {
      if (rootSeen) {
        syntax("a second root element");
        break;
      }
      rootSeen = true;
    }
    onOpen(name, attrs, stack.length);
    if (selfClosing) onClose(name, stack.length);
    else stack.push(name);
    i = j;
  }
  if (out.wellFormed && out.errors.length < maxErrors) {
    if (stack.length > 0) syntax(`<${stack[stack.length - 1]}> is never closed`);
    if (!rootSeen) syntax("no root element");
  }
  return out;
}

export type SitemapValidation = {
  ok: boolean;
  errors: string[];
  /** URLs across every part. */
  urlCount: number;
  parts: number;
  largestPartBytes: number;
};

/**
 * The in-process check of a build: render every document and read it back
 * with parseSitemapXml — well-formed, escaped, every part within both limits,
 * the index naming exactly /a/sitemap.xml?page=1…N, every URL on this host
 * under /a/ exactly once, and the URL set equal to what the collection chose.
 */
export function validateSitemapPlan(
  plan: SitemapPlan,
  expectedLocs: readonly string[],
): SitemapValidation {
  const errors: string[] = [];
  const add = (e: string) => {
    if (errors.length < 20) errors.push(e);
  };
  const n = plan.shards.length;
  const all: string[] = [];
  let largest = 0;
  for (let k = 1; k <= n; k++) {
    const xml = renderUrlset(plan, k);
    const p = parseSitemapXml(xml);
    const label = n > 1 ? `part ${k}` : "the sitemap";
    for (const e of p.errors) add(`${label}: ${e}`);
    if (p.kind !== "urlset") add(`${label} is not a <urlset>`);
    if (p.locs.length > plan.limits.maxUrls)
      add(`${label} lists ${p.locs.length} URLs (limit ${plan.limits.maxUrls})`);
    if (p.bytes > plan.limits.maxBytes)
      add(`${label} is ${p.bytes} bytes (limit ${plan.limits.maxBytes})`);
    largest = Math.max(largest, p.bytes);
    for (const l of p.locs) all.push(l);
  }
  if (n > 1) {
    const idx = parseSitemapXml(renderIndex(plan));
    for (const e of idx.errors) add(`index: ${e}`);
    if (idx.kind !== "sitemapindex") add("the index is not a <sitemapindex>");
    const want = plan.shards.map((_, i) => sitemapPartUrl(plan.host, i + 1));
    if (idx.locs.join("\n") !== want.join("\n"))
      add("the index does not name exactly /a/sitemap.xml?page=1…N");
  }
  const prefix = `https://${plan.host}/a/`;
  const seen = new Set<string>();
  let offHost = 0;
  let doubled = 0;
  for (const loc of all) {
    if (!loc.startsWith(prefix) || !isPublicPageSlug(loc.slice(prefix.length))) offHost++;
    if (seen.has(loc)) doubled++;
    seen.add(loc);
  }
  if (offHost)
    add(`${offHost} URL${offHost === 1 ? " is" : "s are"} not a page URL on ${plan.host}`);
  if (doubled) add(`${doubled} URL${doubled === 1 ? " is" : "s are"} listed twice`);
  const expected = new Set(expectedLocs);
  let missing = 0;
  for (const e of expected) if (!seen.has(e)) missing++;
  let extra = 0;
  for (const s of seen) if (!expected.has(s)) extra++;
  if (missing || extra || all.length !== expected.size) {
    add(
      `the XML lists ${all.length} URLs; the build chose ${expected.size} (${missing} missing, ${extra} extra)`,
    );
  }
  return {
    ok: errors.length === 0,
    errors,
    urlCount: all.length,
    parts: n,
    largestPartBytes: largest,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** How long a sitemap response may be reused: changes appear within this window. */
export const SITEMAP_CACHE_SECONDS = 300;
export const SITEMAP_VARY = "Host, X-Forwarded-Host";

export const SITEMAP_OK_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "application/xml; charset=utf-8",
  // Private: see CACHING at the top of this file.
  "Cache-Control": `private, max-age=${SITEMAP_CACHE_SECONDS}`,
  Vary: SITEMAP_VARY,
};

const NOT_FOUND = {
  status: 404 as const,
  body: "not found",
  headers: {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    Vary: SITEMAP_VARY,
  },
};

const UNAVAILABLE = {
  status: 503 as const,
  body: "sitemap temporarily unavailable",
  headers: {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Retry-After": String(SITEMAP_CACHE_SECONDS),
    Vary: SITEMAP_VARY,
  },
};

export type SitemapHttpResult = {
  status: 200 | 404 | 503;
  body: string;
  headers: Record<string, string>;
};

/**
 * The whole answer to GET /a/sitemap.xml[?page=N] for a request host:
 * 404 for an invalid page, a host that is not a verified tenant host (the
 * platform hosts included) or a part that does not exist; 503 when the host
 * lookup or any read failed; else the document, with the cache headers. A
 * verified host whose pages do not serve (billing) gets an empty <urlset> —
 * never the platform's URLs, never another tenant's.
 */
export async function tenantSitemapResponse(
  rawHost: string,
  requestUrl: string,
  { db = adminDb(), limits = SITEMAP_LIMITS }: { db?: SitemapDb; limits?: SitemapLimits } = {},
): Promise<SitemapHttpResult> {
  const page = sitemapPageParam(requestUrl);
  if (page === null) return { ...NOT_FOUND, headers: { ...NOT_FOUND.headers } };
  const host = await resolveTenantHost(rawHost, db);
  if (host.kind === "error") {
    console.error("[sitemap] host lookup failed:", host.host, host.message);
    return { ...UNAVAILABLE, headers: { ...UNAVAILABLE.headers } };
  }
  if (host.kind !== "tenant") return { ...NOT_FOUND, headers: { ...NOT_FOUND.headers } };
  const c = await collectSitemap(host.workspaceId, { db, stopWhenPaused: true });
  if (!c.complete) return { ...UNAVAILABLE, headers: { ...UNAVAILABLE.headers } };
  const paused = c.serving !== null && !c.serving.serve;
  const plan = planSitemap(host.host, paused ? [] : c.urls, limits);
  const doc = sitemapDocumentFor(plan, page);
  if (doc === null) return { ...NOT_FOUND, headers: { ...NOT_FOUND.headers } };
  return { status: 200, body: doc, headers: { ...SITEMAP_OK_HEADERS } };
}

/**
 * A short per-isolate memo in front of tenantSitemapResponse: an
 * unauthenticated request otherwise rebuilds the whole sitemap (billing,
 * grants, every published page, the listing counts) from a database other
 * products share. Keyed by the normalised request host plus the page
 * parameter, so an answer is only ever reused for the host it was built for.
 * Only 200s and 404s are kept (a 503 is retried), for `ttlMs` (a publish
 * still appears well within SITEMAP_CACHE_SECONDS), at most `maxEntries`
 * answers and none whose body exceeds `maxBodyChars`.
 */
export function sitemapResponseMemo(
  build: (rawHost: string, requestUrl: string) => Promise<SitemapHttpResult>,
  {
    ttlMs = 60_000,
    maxEntries = 256,
    maxBodyChars = 2_000_000,
    now = () => Date.now(),
  }: { ttlMs?: number; maxEntries?: number; maxBodyChars?: number; now?: () => number } = {},
) {
  const memo = new Map<string, { at: number; result: SitemapHttpResult }>();
  return async (rawHost: string, requestUrl: string): Promise<SitemapHttpResult> => {
    let pageParam: string | null = null;
    try {
      pageParam = new URL(requestUrl).searchParams.get("page");
    } catch {
      pageParam = null;
    }
    const key = `${requestHost(rawHost)}|${pageParam ?? ""}`;
    const hit = memo.get(key);
    const t = now();
    if (hit && t - hit.at < ttlMs) {
      return { ...hit.result, headers: { ...hit.result.headers } };
    }
    if (hit) memo.delete(key);
    const result = await build(rawHost, requestUrl);
    if ((result.status === 200 || result.status === 404) && result.body.length <= maxBodyChars) {
      if (memo.size >= maxEntries) {
        const oldest = memo.keys().next();
        if (!oldest.done) memo.delete(oldest.value);
      }
      memo.set(key, { at: t, result: { ...result, headers: { ...result.headers } } });
    }
    return result;
  };
}

/** The memoized tenant sitemap the public routes serve (the production database). */
export const memoizedTenantSitemapResponse = sitemapResponseMemo((rawHost, requestUrl) =>
  tenantSitemapResponse(rawHost, requestUrl),
);
