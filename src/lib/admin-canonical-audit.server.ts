/**
 * Server-only helpers for the canonical-URL crawl audit. Imported only by
 * *.functions.ts and the public hook route. Never reached from the client.
 */
import {
  CANONICAL_ORIGIN,
  classifyUrl,
  type UrlClassification,
} from "@/lib/canonical";

const MAX_URLS_PER_RUN = 200;
const FETCH_TIMEOUT_MS = 10_000;

export type AuditIssue = {
  url: string;
  classification: UrlClassification;
  source: "canonical" | "og:url" | "twitter:url" | "anchor" | "alternate";
};

export type AuditPageResult = {
  url: string;
  status: number;
  ok: boolean;
  fetchedAt: string;
  /** apex 301 → www check; null = not tested */
  apexRedirectsToWww: boolean | null;
  issues: AuditIssue[];
  counts: { canonical: number; apex: number; preview: number; external: number };
  error?: string;
};

export type AuditRunSummary = {
  startedAt: string;
  finishedAt: string;
  totalPages: number;
  pagesWithFailures: number;
  pagesWithWarnings: number;
  totals: { canonical: number; apex: number; preview: number; external: number };
  pages: AuditPageResult[];
};

const ATTR_RE = /\b(?:href|content)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function extract(html: string, source: AuditIssue["source"], filter: (slice: string) => boolean): string[] {
  const out: string[] = [];
  // Capture full tags then extract attribute by regex — fast and dependency-free.
  const tagRe = source === "anchor" ? /<a\b[^>]*>/gi : /<(?:link|meta)\b[^>]*>/gi;
  for (const tagMatch of html.matchAll(tagRe)) {
    const tag = tagMatch[0];
    if (!filter(tag)) continue;
    ATTR_RE.lastIndex = 0;
    const m = ATTR_RE.exec(tag);
    if (m) out.push((m[1] ?? m[2]).trim());
  }
  return out;
}

function parseHtml(html: string): { canonical: string[]; ogUrl: string[]; twitterUrl: string[]; anchors: string[]; alternates: string[] } {
  return {
    canonical: extract(html, "canonical", (t) => /rel\s*=\s*["']canonical["']/i.test(t)),
    ogUrl: extract(html, "og:url", (t) => /property\s*=\s*["']og:url["']/i.test(t)),
    twitterUrl: extract(html, "twitter:url", (t) => /name\s*=\s*["']twitter:url["']/i.test(t)),
    anchors: extract(html, "anchor", () => true),
    alternates: extract(html, "alternate", (t) => /rel\s*=\s*["']alternate["']/i.test(t)),
  };
}

async function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }
}

async function checkApexRedirect(path: string): Promise<boolean | null> {
  const apex = `https://founders.click${path.startsWith("/") ? path : `/${path}`}`;
  try {
    const res = await timedFetch(apex, { method: "HEAD" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location") ?? "";
      return loc.startsWith(CANONICAL_ORIGIN);
    }
    return false;
  } catch {
    return null;
  }
}

export async function auditPage(path: string): Promise<AuditPageResult> {
  const url = `${CANONICAL_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`;
  const fetchedAt = new Date().toISOString();
  try {
    const res = await timedFetch(url, { method: "GET", redirect: "follow" });
    const html = await res.text();
    const parsed = parseHtml(html);

    const issues: AuditIssue[] = [];
    const counts = { canonical: 0, apex: 0, preview: 0, external: 0 };

    const collect = (urls: string[], source: AuditIssue["source"]) => {
      for (const u of urls) {
        const c = classifyUrl(u);
        if (c === "canonical" || c === "external-allowed") {
          counts.canonical++;
          continue;
        }
        if (c === "external") {
          counts.external++;
          continue;
        }
        if (c === "apex") counts.apex++;
        if (c === "preview") counts.preview++;
        issues.push({ url: u, classification: c, source });
      }
    };

    collect(parsed.canonical, "canonical");
    collect(parsed.ogUrl, "og:url");
    collect(parsed.twitterUrl, "twitter:url");
    collect(parsed.alternates, "alternate");
    collect(parsed.anchors, "anchor");

    const apexRedirectsToWww = path === "/" || path === "" ? await checkApexRedirect(path) : null;

    return {
      url,
      status: res.status,
      ok: res.ok,
      fetchedAt,
      apexRedirectsToWww,
      issues,
      counts,
    };
  } catch (err) {
    return {
      url,
      status: 0,
      ok: false,
      fetchedAt,
      apexRedirectsToWww: null,
      issues: [],
      counts: { canonical: 0, apex: 0, preview: 0, external: 0 },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Pull URLs from /sitemap.xml. Falls back to a small seed list. */
export async function discoverUrls(): Promise<string[]> {
  const seed = ["/", "/login", "/signup"];
  try {
    const res = await timedFetch(`${CANONICAL_ORIGIN}/sitemap.xml`);
    if (!res.ok) return seed;
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    const paths = locs
      .map((u) => {
        try {
          return new URL(u).pathname;
        } catch {
          return null;
        }
      })
      .filter((p): p is string => !!p);
    const merged = Array.from(new Set([...seed, ...paths]));
    return merged.slice(0, MAX_URLS_PER_RUN);
  } catch {
    return seed;
  }
}

export async function runFullAudit(): Promise<AuditRunSummary> {
  const startedAt = new Date().toISOString();
  const paths = await discoverUrls();

  // Bounded concurrency: 5 in flight.
  const results: AuditPageResult[] = [];
  const queue = [...paths];
  const workers = Array.from({ length: 5 }, async () => {
    while (queue.length) {
      const p = queue.shift()!;
      results.push(await auditPage(p));
    }
  });
  await Promise.all(workers);

  const totals = { canonical: 0, apex: 0, preview: 0, external: 0 };
  let pagesWithFailures = 0;
  let pagesWithWarnings = 0;
  for (const r of results) {
    totals.canonical += r.counts.canonical;
    totals.apex += r.counts.apex;
    totals.preview += r.counts.preview;
    totals.external += r.counts.external;
    if (r.counts.preview > 0 || r.error || (r.apexRedirectsToWww === false)) pagesWithFailures++;
    else if (r.counts.apex > 0) pagesWithWarnings++;
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    totalPages: results.length,
    pagesWithFailures,
    pagesWithWarnings,
    totals,
    pages: results,
  };
}
