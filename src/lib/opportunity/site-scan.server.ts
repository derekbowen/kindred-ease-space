/**
 * SITE INTELLIGENCE — scan an arbitrary customer domain.
 *
 * Retargets the HTML/sitemap parsing approach proven in the canonical auditor,
 * which was hardcoded to founders.click's own origin. Here the domain is an
 * input.
 *
 * Crawl policy (the scanner must not melt when someone types zillow.com):
 *   - sitemap first, HTML links only as a fallback
 *   - hard cap on fetched pages, wall clock, and concurrency
 *   - group URLs into path-template families and sample within each
 *   - store extracted STRUCTURED FEATURES, never raw HTML
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  canonicalTokens,
  categoryFromPhrase,
  normalizeGeo,
  slugify,
} from "./intent";

const sb = () => supabaseAdmin as any;

export const SCAN_LIMITS = {
  maxPages: 200,
  maxSitemapUrls: 5000,
  perTemplateSample: 20,
  fetchTimeoutMs: 10_000,
  wallClockMs: 90_000,
  concurrency: 6,
};

async function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCAN_LIMITS.fetchTimeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "founders.click site-scanner", ...(init?.headers ?? {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

const ATTR_RE = /(?:href|content)\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

function attr(tag: string): string | null {
  const m = ATTR_RE.exec(tag);
  return m ? (m[1] ?? m[2] ?? "").trim() : null;
}

function firstTagContent(html: string, tag: "title" | "h1"): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(html);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null;
}

function metaByName(html: string, name: string): string | null {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (new RegExp(`name\\s*=\\s*["']${name}["']`, "i").test(tag)) return attr(tag);
  }
  return null;
}

function linkByRel(html: string, rel: string): string | null {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (new RegExp(`rel\\s*=\\s*["']${rel}["']`, "i").test(tag)) return attr(tag);
  }
  return null;
}

function isIndexable(html: string): boolean {
  const robots = metaByName(html, "robots") ?? "";
  return !/noindex/i.test(robots);
}

function visibleWordCount(html: string): number {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.split(" ").length : 0;
}

/** Cheap stable fingerprint of the page's meaningful tokens — used to spot
 *  template families and near-identical pages without storing content. */
function fingerprint(title: string | null, h1: string | null, words: number): string {
  const toks = canonicalTokens(`${title ?? ""} ${h1 ?? ""}`).slice(0, 12).join(".");
  return `${toks}#${Math.round(words / 100)}`;
}

/** Reduce a URL path to a template: /pool-rentals/riverside-ca -> /s/s */
function pathTemplate(pathname: string): string {
  return (
    "/" +
    pathname
      .split("/")
      .filter(Boolean)
      .map((seg) => (/^\d+$/.test(seg) ? "n" : "s"))
      .join("/")
  );
}

async function fetchSitemapUrls(origin: string): Promise<{ urls: string[]; found: boolean }> {
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const collected = new Set<string>();
  let found = false;

  for (const sm of candidates) {
    if (collected.size >= SCAN_LIMITS.maxSitemapUrls) break;
    try {
      const res = await timedFetch(sm);
      if (!res.ok) continue;
      found = true;
      const xml = await res.text();
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
      // A sitemap index points at more sitemaps — follow a bounded number.
      const nested = locs.filter((u) => /\.xml(\.gz)?$/i.test(u)).slice(0, 10);
      const direct = locs.filter((u) => !/\.xml(\.gz)?$/i.test(u));
      direct.forEach((u) => collected.add(u));
      for (const child of nested) {
        if (collected.size >= SCAN_LIMITS.maxSitemapUrls) break;
        try {
          const r2 = await timedFetch(child);
          if (!r2.ok) continue;
          const x2 = await r2.text();
          [...x2.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
            .map((m) => m[1])
            .filter((u) => !/\.xml(\.gz)?$/i.test(u))
            .forEach((u) => collected.add(u));
        } catch {
          /* skip child sitemap */
        }
      }
    } catch {
      /* try next candidate */
    }
  }
  return { urls: [...collected], found };
}

/** Sample across template families so a 1M-page site still yields a
 *  representative picture within the cap. */
function selectRepresentative(urls: string[], origin: string): { picked: string[]; patterns: Array<{ template: string; count: number }> } {
  const byTemplate = new Map<string, string[]>();
  for (const u of urls) {
    let p: URL;
    try {
      p = new URL(u, origin);
    } catch {
      continue;
    }
    const t = pathTemplate(p.pathname);
    if (!byTemplate.has(t)) byTemplate.set(t, []);
    byTemplate.get(t)!.push(p.toString());
  }
  const patterns = [...byTemplate.entries()]
    .map(([template, list]) => ({ template, count: list.length }))
    .sort((a, b) => b.count - a.count);

  const picked: string[] = [];
  // Round-robin across families, largest first, until the cap.
  let idx = 0;
  while (picked.length < SCAN_LIMITS.maxPages) {
    let added = false;
    for (const { template } of patterns) {
      const list = byTemplate.get(template)!;
      if (idx < Math.min(list.length, SCAN_LIMITS.perTemplateSample)) {
        picked.push(list[idx]);
        added = true;
        if (picked.length >= SCAN_LIMITS.maxPages) break;
      }
    }
    if (!added) break;
    idx++;
  }
  return { picked, patterns: patterns.slice(0, 40) };
}

export type ScanPageFeature = {
  url: string;
  canonical_url: string | null;
  title: string | null;
  h1: string | null;
  meta_description: string | null;
  page_type: string;
  inferred_category: string | null;
  inferred_geo: string | null;
  word_count: number;
  indexable: boolean;
  content_fingerprint: string;
};

function classifyPageType(pathname: string, title: string | null): string {
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length === 0) return "home";
  const joined = `${pathname} ${title ?? ""}`.toLowerCase();
  if (/\b(blog|article|post|news|guide)\b/.test(joined)) return "editorial";
  if (/\b(about|contact|terms|privacy|faq|help)\b/.test(joined)) return "utility";
  if (segs.length >= 2) return "detail";
  return "category";
}

/** Extract a likely location from a title/path using known city hints. */
function inferGeo(text: string, cityHints: Set<string>): string | null {
  const toks = canonicalTokens(text);
  for (const t of toks) if (cityHints.has(t)) return t;
  return null;
}

export async function runSiteScan(
  workspaceId: string,
  domain: string,
): Promise<{ scanId: string; pagesFetched: number; urlsDiscovered: number }> {
  const host = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  const origin = `https://${host}`;
  const startedMs = Date.now();

  const { data: scanRow } = await sb()
    .from("site_scans")
    .insert({ workspace_id: workspaceId, domain: host, status: "running" })
    .select("id")
    .single();
  const scanId = scanRow.id as string;

  try {
    // City hints from the customer's own inventory make geo inference far more
    // accurate than guessing from text alone.
    const { data: listingCities } = await sb()
      .from("tenant_listings")
      .select("city")
      .eq("workspace_id", workspaceId)
      .not("city", "is", null)
      .limit(2000);
    const cityHints = new Set<string>();
    for (const r of (listingCities ?? []) as Array<{ city: string }>) {
      canonicalTokens(r.city).forEach((t) => cityHints.add(t));
    }

    const { urls: sitemapUrls, found: sitemapFound } = await fetchSitemapUrls(origin);

    let discovered = sitemapUrls;
    if (discovered.length === 0) {
      // Fallback: fetch the homepage and harvest same-host links.
      try {
        const res = await timedFetch(origin);
        const html = await res.text();
        const links = [...html.matchAll(/<a\b[^>]*>/gi)]
          .map((m) => attr(m[0]))
          .filter((h): h is string => Boolean(h));
        const set = new Set<string>([origin]);
        for (const h of links) {
          try {
            const u = new URL(h, origin);
            if (u.hostname.replace(/^www\./, "") === host.replace(/^www\./, "")) {
              u.hash = "";
              set.add(u.toString());
            }
          } catch {
            /* ignore malformed href */
          }
        }
        discovered = [...set];
      } catch {
        discovered = [origin];
      }
    }

    const { picked, patterns } = selectRepresentative(discovered, origin);

    const features: ScanPageFeature[] = [];
    const queue = [...picked];

    async function worker() {
      while (queue.length) {
        if (Date.now() - startedMs > SCAN_LIMITS.wallClockMs) return;
        const url = queue.shift();
        if (!url) return;
        try {
          const res = await timedFetch(url);
          if (!res.ok) continue;
          const ct = res.headers.get("content-type") ?? "";
          if (!ct.includes("html")) continue;
          const html = (await res.text()).slice(0, 400_000);
          const title = firstTagContent(html, "title");
          const h1 = firstTagContent(html, "h1");
          const words = visibleWordCount(html);
          const pathname = new URL(url).pathname;
          const geo = inferGeo(`${title ?? ""} ${pathname}`, cityHints);
          features.push({
            url,
            canonical_url: linkByRel(html, "canonical"),
            title,
            h1,
            meta_description: metaByName(html, "description"),
            page_type: classifyPageType(pathname, title),
            inferred_category: categoryFromPhrase(`${title ?? ""} ${h1 ?? ""}`, geo ?? "", "") || null,
            inferred_geo: geo,
            word_count: words,
            indexable: isIndexable(html),
            content_fingerprint: fingerprint(title, h1, words),
          });
        } catch {
          /* skip unreachable page */
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(SCAN_LIMITS.concurrency, Math.max(1, picked.length)) }, worker),
    );

    if (features.length) {
      const rows = features.map((f) => ({ ...f, scan_id: scanId, workspace_id: workspaceId }));
      for (let i = 0; i < rows.length; i += 100) {
        await sb().from("site_scan_pages").insert(rows.slice(i, i + 100));
      }
    }

    const categories = [...new Set(features.map((f) => f.inferred_category).filter(Boolean))].slice(0, 60);
    const locations = [...new Set(features.map((f) => f.inferred_geo).filter(Boolean))].slice(0, 200);

    await sb()
      .from("site_scans")
      .update({
        status: "complete",
        finished_at: new Date().toISOString(),
        urls_discovered: discovered.length,
        pages_fetched: features.length,
        sitemap_found: sitemapFound,
        inferred_categories: categories,
        inferred_locations: locations,
        url_patterns: patterns,
      })
      .eq("id", scanId);

    return { scanId, pagesFetched: features.length, urlsDiscovered: discovered.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[site-scan] failed", host, msg);
    await sb()
      .from("site_scans")
      .update({ status: "error", error: msg, finished_at: new Date().toISOString() })
      .eq("id", scanId);
    throw e;
  }
}

export { slugify };
