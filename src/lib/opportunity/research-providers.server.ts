/**
 * RESEARCH PROVIDER ABSTRACTION.
 *
 * V1 performs no SERP or competitor research — but the seams are defined now
 * so that adding it later does not mean touching the decision engine, and so
 * that BYOK can be swapped for platform-funded research without a rewrite.
 *
 * Today SerpApi and Firecrawl are BYOK (workspace secrets). That is acceptable
 * for beta and wrong long term: the product experience should be
 *
 *     connect website → Founders researches it
 *
 * not
 *
 *     connect website → go buy three developer API keys.
 *
 * When platform-funded research arrives, implement `PlatformSerpProvider` /
 * `PlatformCrawlProvider` here and change `resolveProviders()`. Callers keep
 * the same interface.
 */

export type SerpResult = {
  position: number;
  url: string;
  title: string;
  domain: string;
};

export type SerpProvider = {
  readonly kind: "byok" | "platform" | "none";
  /** Null when no provider is configured — callers must degrade, not throw. */
  search(query: string, opts?: { location?: string }): Promise<SerpResult[] | null>;
};

export type CrawlResult = {
  url: string;
  title: string | null;
  h1: string | null;
  metaDescription: string | null;
  wordCount: number;
};

export type CrawlProvider = {
  readonly kind: "native" | "firecrawl" | "platform";
  fetchPage(url: string): Promise<CrawlResult | null>;
};

/** V1 default: no SERP research at all. Every gate and score works without it,
 *  by design — SERP is a Phase-5 enrichment, not a dependency. */
export const NullSerpProvider: SerpProvider = {
  kind: "none",
  async search() {
    return null;
  },
};

export type ResearchProviders = {
  serp: SerpProvider;
  crawl: CrawlProvider | null;
};

/**
 * V1 returns the null SERP provider unconditionally. The workspace argument is
 * already threaded through so that resolving a BYOK key — or later a
 * platform-funded pool — is a change inside this function only.
 */
export async function resolveProviders(_workspaceId: string): Promise<ResearchProviders> {
  return { serp: NullSerpProvider, crawl: null };
}
