/**
 * Server-only helpers for scraping city hero images from poolrentalnearme.com
 * and persisting them to cities.hero_image_url.
 *
 * Strategy:
 *   1. Harvest the public site directory `/p/all-locations` once per run to
 *      build an authoritative map of { citySlug -> sourceUrl }. This avoids
 *      slug-guessing for ~350 cities.
 *   2. Apply manual OVERRIDES for ~30 large markets where a richer rental
 *      landing page exists (e.g. /p/losangeles), which always wins.
 *   3. For each target city, scrape the resolved URL via Firecrawl, extract
 *      the first sharetribe-assets imgix hero URL, and persist.
 *   4. Log every attempt (ok / miss / skipped / error) to
 *      cities_hero_backfill_log so the user can audit failures from the
 *      admin page.
 */
import Firecrawl from "@mendable/firecrawl-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { generateAndUploadHero } from "./cities-hero-fallback.server";

export type BackfillResult = {
  slug: string;
  name: string;
  source_url: string | null;
  status: "ok" | "miss" | "error" | "skipped" | "generated";
  hero_url?: string;
  error?: string;
};

/**
 * Manual overrides — large markets that have a dedicated rental landing page
 * (`/p/{cityslug}` template) with a richer city-specific hero. These win over
 * any URL discovered in the directory.
 */
const URL_OVERRIDES: Record<string, string> = {
  "los-angeles": "https://www.poolrentalnearme.com/p/losangeles",
  "san-diego": "https://www.poolrentalnearme.com/p/sandiego",
  "miami": "https://www.poolrentalnearme.com/p/miami",
  "austin": "https://www.poolrentalnearme.com/p/austin",
  "kansas-city-mo": "https://www.poolrentalnearme.com/p/kansascity",
};

/**
 * Harvest the all-locations directory once. Returns a map keyed by a
 * normalized city + state-code key (e.g. "birmingham-al") AND by city-only
 * key (e.g. "birmingham") so we can match against DB slugs that may or may
 * not include the state suffix.
 */
export async function harvestSourceUrls(): Promise<Map<string, string>> {
  const html = await fetchWithBackoff(
    "https://www.poolrentalnearme.com/p/all-locations",
    { headers: { "User-Agent": "Mozilla/5.0 LovableHeroBackfill/1.0" } },
    { maxAttempts: 5 },
  );

  const map = new Map<string, string>();
  // Match both URL templates listed in the directory:
  //   /p/become-a-swimming-pool-host-{city-slug}-{state-code}
  //   /p/become-a-pool-host-{city-slug}-{state-name}
  const re =
    /\/p\/(become-a-(?:swimming-)?pool-host-([a-z0-9-]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const path = m[1]; // become-a-swimming-pool-host-birmingham-al
    const tail = m[2]; // birmingham-al  OR  phoenix-arizona
    const url = `https://www.poolrentalnearme.com/p/${path}`;

    // The last hyphen-segment is the state (code or name). Strip it for the
    // city-only key.
    const segments = tail.split("-");
    if (segments.length < 2) continue;
    const stateSeg = segments[segments.length - 1];
    const cityOnly = segments.slice(0, -1).join("-");

    // Two-letter state codes are unambiguous. Multi-letter state names get a
    // synthesized state code where possible.
    const stateCode = STATE_NAME_TO_CODE[stateSeg] ?? stateSeg;

    // Index by both keys; first occurrence wins so the directory's preferred
    // URL is kept stable.
    if (!map.has(cityOnly)) map.set(cityOnly, url);
    const fullKey = `${cityOnly}-${stateCode}`;
    if (!map.has(fullKey)) map.set(fullKey, url);
  }

  return map;
}

const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca",
  colorado: "co", connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga",
  hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia",
  kansas: "ks", kentucky: "ky", louisiana: "la", maine: "me", maryland: "md",
  massachusetts: "ma", michigan: "mi", minnesota: "mn", mississippi: "ms",
  missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv",
  "new-hampshire": "nh", "new-jersey": "nj", "new-mexico": "nm",
  "new-york": "ny", "north-carolina": "nc", "north-dakota": "nd", ohio: "oh",
  oklahoma: "ok", oregon: "or", pennsylvania: "pa", "rhode-island": "ri",
  "south-carolina": "sc", "south-dakota": "sd", tennessee: "tn", texas: "tx",
  utah: "ut", vermont: "vt", virginia: "va", washington: "wa",
  "west-virginia": "wv", wisconsin: "wi", wyoming: "wy",
};

/**
 * Bulk-load the canonical /p/* URL path for each city from `content_pages`.
 *
 * For each city slug we look up the published content page that actually
 * renders that city, in priority order:
 *   1. A page whose slug equals the city slug exactly (e.g. `los-angeles-ca`)
 *   2. `become-a-swimming-pool-host-{citySlug}`
 *   3. `become-a-pool-host-{citySlug}`
 *
 * If none of those exist, the city has no canonical landing page and the
 * backfill should skip it instead of guessing a 404 URL like `/p/{citySlug}`.
 */
export async function loadCanonicalUrlPaths(
  citySlugs: string[],
): Promise<Map<string, string>> {
  if (citySlugs.length === 0) return new Map();

  const candidates = new Set<string>();
  for (const s of citySlugs) {
    candidates.add(s);
    candidates.add(`become-a-swimming-pool-host-${s}`);
    candidates.add(`become-a-pool-host-${s}`);
  }

  const { data } = await supabaseAdmin
    .from("content_pages")
    .select("slug,url_path,status")
    .in("slug", Array.from(candidates))
    .eq("status", "published");

  const bySlug = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ slug: string; url_path: string | null }>) {
    if (row.url_path) bySlug.set(row.slug, row.url_path);
  }

  const out = new Map<string, string>();
  for (const s of citySlugs) {
    const path =
      bySlug.get(s) ??
      bySlug.get(`become-a-swimming-pool-host-${s}`) ??
      bySlug.get(`become-a-pool-host-${s}`);
    if (path) out.set(s, path);
  }
  return out;
}

/**
 * Resolve the source URL for a given city, in priority order:
 *   1. URL_OVERRIDES (curated large markets)
 *   2. content_pages.url_path lookup (authoritative — page actually exists)
 *   3. /p/all-locations directory harvest (may be stale)
 *   4. null  (no real page → skip; do NOT guess /p/{slug})
 */
export function resolveSourceUrl(
  citySlug: string,
  cityStateCode: string | null | undefined,
  directory: Map<string, string>,
  canonical?: Map<string, string>,
): string | null {
  if (URL_OVERRIDES[citySlug]) return URL_OVERRIDES[citySlug];

  const fromDb = canonical?.get(citySlug);
  if (fromDb) return `https://www.poolrentalnearme.com${fromDb}`;

  // Direct slug match in scraped directory.
  const direct = directory.get(citySlug);
  if (direct) return direct;

  if (cityStateCode) {
    const withState = directory.get(`${citySlug}-${cityStateCode.toLowerCase()}`);
    if (withState) return withState;
  }

  const segs = citySlug.split("-");
  if (segs.length > 1) {
    const last = segs[segs.length - 1];
    if (last.length === 2) {
      const cityOnly = segs.slice(0, -1).join("-");
      const m1 = directory.get(cityOnly);
      if (m1) return m1;
      const m2 = directory.get(`${cityOnly}-${last}`);
      if (m2) return m2;
    }
  }
  return null;
}

/**
 * Extract the first plausible hero image URL from rendered HTML.
 *
 * Supports multiple sources, in priority order:
 *   1. og:image / twitter:image meta tags (cleanest signal of "the hero")
 *   2. <link rel="preload" as="image"> (Next/TanStack hero hint)
 *   3. sharetribe-assets imgix URLs (legacy listing photos)
 *   4. Supabase Storage public URLs (city-heroes bucket / lovable uploads)
 *   5. Generic large image URLs from common CDNs (imgix, cloudinary,
 *      cloudfront, unsplash, lovable-uploads, supabase.co/storage)
 */
export function extractHeroUrl(html: string): string | null {
  if (!html) return null;
  const decode = (s: string) =>
    s.replace(/&amp;/g, "&").replace(/\\u0026/g, "&").replace(/&#x2F;/g, "/");

  // 1. og:image / twitter:image
  const metaRe =
    /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*content=["']([^"']+)["']/gi;
  const metaRe2 =
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["']/gi;
  for (const re of [metaRe, metaRe2]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const u = decode(m[1]).trim();
      if (/^https?:\/\//i.test(u) && !/favicon|logo|sprite|icon/i.test(u)) {
        return u;
      }
    }
  }

  // 2. <link rel="preload" as="image" href="...">
  const preloadRe =
    /<link[^>]+rel=["']preload["'][^>]+as=["']image["'][^>]+href=["']([^"']+)["']/gi;
  let pm: RegExpExecArray | null;
  while ((pm = preloadRe.exec(html)) !== null) {
    const u = decode(pm[1]).trim();
    if (/^https?:\/\//i.test(u)) return u;
  }

  // Helper for sized URLs (imgix-style w=/h= query params).
  const isLargeEnough = (u: string) => {
    const wMatch = u.match(/[?&]w=(\d+)/);
    const hMatch = u.match(/[?&]h=(\d+)/);
    const w = wMatch ? Number(wMatch[1]) : 0;
    const h = hMatch ? Number(hMatch[1]) : 0;
    return w >= 800 || h >= 500;
  };

  // 3. Sharetribe imgix
  const stRe =
    /https:\/\/sharetribe-assets\.imgix\.net\/[A-Za-z0-9._/-]+\?[^"'\s)]+/g;
  const stCandidates: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = stRe.exec(html)) !== null) stCandidates.push(decode(m[0]));
  if (stCandidates.length) {
    return stCandidates.find(isLargeEnough) || stCandidates[0];
  }

  // 4 + 5. Generic CDN / hero-ish URLs found anywhere in HTML.
  const cdnRe =
    /https:\/\/[A-Za-z0-9.-]+(?:imgix\.net|cloudinary\.com|cloudfront\.net|images\.unsplash\.com|supabase\.co\/storage\/v1\/object\/public|lovable-uploads|gstatic\.com\/images|googleusercontent\.com)\/[^"'\s)<>]+\.(?:jpe?g|png|webp|avif)(?:\?[^"'\s)<>]*)?/gi;
  const cdn: string[] = [];
  while ((m = cdnRe.exec(html)) !== null) {
    const u = decode(m[0]);
    if (!/favicon|logo|sprite|icon|avatar|profile/i.test(u)) cdn.push(u);
  }
  if (cdn.length) return cdn.find(isLargeEnough) || cdn[0];

  // 6. Last resort: first large-looking <img src> on the page.
  const imgRe =
    /<img[^>]+src=["'](https?:\/\/[^"']+\.(?:jpe?g|png|webp|avif)(?:\?[^"']*)?)["'][^>]*>/gi;
  while ((m = imgRe.exec(html)) !== null) {
    const u = decode(m[1]);
    if (!/favicon|logo|sprite|icon|avatar|profile/i.test(u)) return u;
  }
  return null;
}

/**
 * Build the list of source URLs to try for a city.
 *
 * Only uses the resolved canonical URL (from URL_OVERRIDES, content_pages,
 * or the /p/all-locations directory). Does NOT guess `/p/{citySlug}` or
 * `/p/host-acquisition/{citySlug}` — those routes don't exist for most
 * cities and just cause 404s + generic AI fallback heroes.
 */
export function buildSourceUrlCandidates(
  _citySlug: string,
  primary: string | null,
): string[] {
  if (!primary) return [];
  return [primary];
}

export function normalizeHeroUrl(url: string): string {
  // Only rewrite query params for imgix-backed URLs. Other CDNs (Supabase
  // Storage, Cloudinary, lovable-uploads, og:image PNGs, etc.) don't honour
  // these params and adding them can break the URL or cache.
  if (!/imgix\.net/i.test(url)) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("auto", "format");
    u.searchParams.set("fit", "crop");
    u.searchParams.set("w", "1600");
    u.searchParams.set("h", "900");
    return u.toString();
  } catch {
    return url;
  }
}

/* ─────────────────────────── retry / backoff helpers ────────────────────── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type BackoffOpts = { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number };

function jitteredDelay(attempt: number, base = 800, max = 30_000) {
  const exp = Math.min(max, base * 2 ** (attempt - 1));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

function parseRetryAfter(h: string | null | undefined): number | null {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = Date.parse(h);
  if (Number.isFinite(t)) return Math.max(0, t - Date.now());
  return null;
}

/** Fetch a URL with exponential backoff on 429/5xx/network errors. Returns body text on success. */
export async function fetchWithBackoff(
  url: string,
  init: RequestInit = {},
  opts: BackoffOpts = {},
): Promise<string> {
  const max = opts.maxAttempts ?? 5;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return await res.text();
      if (res.status === 429 || res.status >= 500) {
        const ra = parseRetryAfter(res.headers.get("retry-after"));
        const wait = ra ?? jitteredDelay(attempt, opts.baseDelayMs, opts.maxDelayMs);
        if (attempt < max) { await sleep(wait); continue; }
        throw new Error(`HTTP ${res.status} after ${attempt} attempts`);
      }
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    } catch (e) {
      lastErr = e;
      if (attempt >= max) break;
      await sleep(jitteredDelay(attempt, opts.baseDelayMs, opts.maxDelayMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Detect rate-limit / transient errors from the Firecrawl SDK. */
function isRetryableScrapeError(e: unknown): { retry: boolean; waitMs?: number } {
  const msg = (e instanceof Error ? e.message : String(e)) || "";
  const status =
    (e as { status?: number; statusCode?: number; response?: { status?: number } })?.status ??
    (e as { statusCode?: number })?.statusCode ??
    (e as { response?: { status?: number } })?.response?.status ??
    null;
  const m = msg.match(/\b(429|5\d\d)\b/);
  const code = status ?? (m ? Number(m[1]) : null);
  if (code === 429 || (typeof code === "number" && code >= 500)) {
    const raMatch = msg.match(/retry[-\s]?after[:\s]+(\d+)/i);
    const waitMs = raMatch ? Number(raMatch[1]) * 1000 : undefined;
    return { retry: true, waitMs };
  }
  // Network-y / timeout errors are also retryable.
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|network/i.test(msg)) {
    return { retry: true };
  }
  return { retry: false };
}

async function scrapeOne(
  client: Firecrawl,
  citySlug: string,
  cityName: string,
  sourceUrl: string,
): Promise<BackfillResult> {
  // Try the primary source first, then fall back to our own rendered city
  // pages. Each candidate gets the full retry/backoff treatment.
  const candidates = buildSourceUrlCandidates(citySlug, sourceUrl);
  let lastError: string | null = null;
  let lastUrl: string = sourceUrl;
  const maxAttempts = 3;

  for (const url of candidates) {
    lastUrl = url;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await client.scrape(url, {
          formats: ["rawHtml"],
          onlyMainContent: false,
          waitFor: 3000,
        });
        const html =
          (res as { rawHtml?: string }).rawHtml ??
          (res as { data?: { rawHtml?: string } }).data?.rawHtml ??
          "";
        const heroRaw = extractHeroUrl(html);
        if (!heroRaw) break; // try next candidate URL
        const hero = normalizeHeroUrl(heroRaw);
        const { error } = await supabaseAdmin
          .from("cities")
          .update({ hero_image_url: hero })
          .eq("slug", citySlug);
        if (error) {
          return {
            slug: citySlug, name: cityName, source_url: url,
            status: "error", error: error.message,
          };
        }
        return {
          slug: citySlug, name: cityName, source_url: url,
          status: "ok", hero_url: hero,
        };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        const { retry, waitMs } = isRetryableScrapeError(e);
        if (!retry || attempt >= maxAttempts) break;
        await sleep(waitMs ?? jitteredDelay(attempt, 1000, 30_000));
      }
    }
  }

  if (lastError) {
    return {
      slug: citySlug, name: cityName, source_url: lastUrl,
      status: "error", error: lastError,
    };
  }
  return { slug: citySlug, name: cityName, source_url: lastUrl, status: "miss" };
}

export async function backfillCityHeroes(opts: {
  force?: boolean;
  limit?: number;
  onlySlugs?: string[];
  batchSize?: number;
  concurrency?: number;
  excludeSlugs?: string[];
  maxDurationMs?: number;
  generateFallback?: boolean;
  maxFallbacksPerBatch?: number;
}): Promise<{
  results: BackfillResult[];
  summary: Record<string, number>;
  remaining: number;
  processedSlugs: string[];
  stoppedReason: "completed" | "batch_full" | "time_budget";
}> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not configured");

  const client = new Firecrawl({ apiKey });

  const directory = await harvestSourceUrls();

  const batchSize = Math.min(Math.max(opts.batchSize ?? 25, 1), 100);
  const concurrency = Math.min(Math.max(opts.concurrency ?? 2, 1), 8);
  const maxDurationMs = Math.min(Math.max(opts.maxDurationMs ?? 45_000, 5_000), 120_000);
  const startedAt = Date.now();

  const effectiveLimit = Math.min(opts.limit ?? batchSize, batchSize);
  let dataQuery = supabaseAdmin
    .from("cities")
    .select("slug,name,state_code")
    .eq("is_published", true)
    .order("name", { ascending: true });
  if (!opts.force) dataQuery = dataQuery.is("hero_image_url", null);
  if (opts.onlySlugs?.length) dataQuery = dataQuery.in("slug", opts.onlySlugs);
  if (opts.excludeSlugs?.length) {
    const list = `(${opts.excludeSlugs.map((s) => `"${s.replace(/"/g, '""')}"`).join(",")})`;
    dataQuery = dataQuery.not("slug", "in", list);
  }
  const { data: cities, error } = await dataQuery.limit(effectiveLimit);
  if (error) throw new Error(`Failed to load cities: ${error.message}`);

  // Bulk-load canonical content_pages.url_path for this batch so resolveSourceUrl
  // can prefer real pages over scraped/guessed URLs.
  const canonical = await loadCanonicalUrlPaths(
    (cities ?? []).map((c: { slug: string }) => c.slug),
  );

  async function logAttempt(r: BackfillResult) {
    await supabaseAdmin.from("cities_hero_backfill_log").insert({
      city_slug: r.slug,
      source_url: r.source_url,
      status: r.status,
      image_url: r.hero_url ?? null,
      error: r.error ?? null,
    });
  }

  const results: BackfillResult[] = [];
  let stoppedReason: "completed" | "batch_full" | "time_budget" = "completed";
  const fallbackBudget = Math.max(0, opts.maxFallbacksPerBatch ?? 10);
  let fallbacksUsed = 0;

  async function maybeFallback(r: BackfillResult, cityState: string | null): Promise<BackfillResult> {
    if (!opts.generateFallback) return r;
    // Only generate AI heroes when a real page existed and the scrape didn't
    // find a usable image. NEVER generate for cities with no canonical page —
    // those should remain "skipped" so the admin can see the gap and decide
    // whether to create the missing content_page.
    if (r.status !== "miss") return r;
    if (fallbacksUsed >= fallbackBudget) return r;
    fallbacksUsed++;
    const gen = await generateAndUploadHero(r.slug, r.name, cityState);
    if (!gen.ok) {
      return { ...r, error: `${r.error ?? r.status}; fallback failed: ${gen.error}` };
    }
    const { error } = await supabaseAdmin
      .from("cities").update({ hero_image_url: gen.hero_url }).eq("slug", r.slug);
    if (error) {
      return { ...r, error: `${r.error ?? r.status}; fallback save failed: ${error.message}` };
    }
    return {
      slug: r.slug, name: r.name, source_url: r.source_url,
      status: "generated", hero_url: gen.hero_url,
    };
  }

  if (cities?.length) {
    let cursor = 0;
    let cooldownUntil = 0;
    let timeUp = false;
    async function worker() {
      while (cursor < cities!.length) {
        if (Date.now() - startedAt > maxDurationMs) { timeUp = true; return; }
        const i = cursor++;
        const c = cities![i];
        const now = Date.now();
        if (cooldownUntil > now) await sleep(cooldownUntil - now);
        const url = resolveSourceUrl(c.slug, c.state_code, directory, canonical);

        // No real /p/* page exists for this city — skip cleanly. Don't scrape
        // a guessed URL and don't generate an AI hero for a page that doesn't
        // exist on the site.
        if (!url) {
          const r: BackfillResult = {
            slug: c.slug, name: c.name, source_url: null,
            status: "skipped", error: "no canonical content_pages url_path",
          };
          results.push(r);
          try { await logAttempt(r); } catch { /* swallow */ }
          continue;
        }

        let r = await scrapeOne(client, c.slug, c.name, url);
        if (r.status === "error" && /\b429\b|rate.?limit/i.test(r.error || "")) {
          cooldownUntil = Date.now() + 10_000;
        }
        // Fallback: generate an AI hero when scraping a real page returned
        // no usable image. (Skipped cities are excluded above.)
        r = await maybeFallback(r, c.state_code);
        results.push(r);
        try { await logAttempt(r); } catch { /* swallow */ }
        await sleep(300);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    stoppedReason = timeUp ? "time_budget" : (cities.length >= effectiveLimit ? "batch_full" : "completed");
  }

  // Compute remaining work for the next batch (excludes what we just processed).
  const processedSlugs = results.map((r) => r.slug);
  const exclusionForCount = [...(opts.excludeSlugs ?? []), ...processedSlugs];
  const { count: remainingCount } = await (() => {
    let q = supabaseAdmin
      .from("cities")
      .select("slug", { count: "exact", head: true })
      .eq("is_published", true);
    if (!opts.force) q = q.is("hero_image_url", null);
    if (opts.onlySlugs?.length) q = q.in("slug", opts.onlySlugs);
    if (exclusionForCount.length) {
      const list = `(${exclusionForCount.map((s) => `"${s.replace(/"/g, '""')}"`).join(",")})`;
      q = q.not("slug", "in", list);
    }
    return q;
  })();

  // For non-force runs the OK results no longer match `hero_image_url IS NULL`,
  // so they're already removed from the count. For force runs we exclude
  // explicitly via excludeSlugs/processedSlugs.
  const remaining = remainingCount ?? 0;
  if (remaining === 0) stoppedReason = "completed";

  const summary = results.reduce<Record<string, number>>(
    (acc, r) => {
      acc.total = (acc.total || 0) + 1;
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    },
    { total: 0 },
  );
  return { results, summary, remaining, processedSlugs, stoppedReason };
}

