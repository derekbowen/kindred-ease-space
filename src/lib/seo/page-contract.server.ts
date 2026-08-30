/**
 * Gathers the facts validatePageContract() needs, then enforces the verdict at
 * the publish boundary.
 *
 * Kept separate from page-contract.ts so the rules stay pure and unit-testable
 * and only this file touches the database.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  validatePageContract,
  normalizeForCompare,
  type PageForValidation,
  type SiblingIntent,
  type ValidationContext,
  type Violation,
} from "./page-contract";
import {
  buildIntentKey,
  canonicalTokens,
  categoryFromPhrase,
  normalizeGeo,
  type ComparableIntent,
} from "@/lib/opportunity/intent";

const sb = () => supabaseAdmin as any;

/**
 * Reduce a page to the search intent it targets: normalized category plus
 * geography. Returns null when the page carries no location, because a
 * geography-free page cannot be compared this way and a guess would block
 * legitimate pages.
 */
export function intentForPage(
  title: string | null,
  variables: Record<string, any> | null | undefined,
  listingFilter: Record<string, any> | null | undefined,
): ComparableIntent | null {
  const vars = variables ?? {};
  const filter = listingFilter ?? {};
  const city = vars.city ?? filter.city ?? null;
  const state = vars.state ?? filter.state ?? null;
  const geoKey = normalizeGeo(city, state);
  if (!geoKey) return null;

  // Prefer the explicit category; fall back to reading it out of the title,
  // with the city and state stripped so "Austin" never becomes the category.
  const categoryKey = vars.category_plural
    ? categoryFromPhrase(String(vars.category_plural), city, state)
    : categoryFromPhrase(title ?? "", city, state);
  if (!categoryKey) return null;

  return {
    categoryKey,
    geoKey,
    titleTokens: canonicalTokens(title ?? ""),
  };
}

/** Stable key for logs/debugging. */
export function intentKeyForPage(intent: ComparableIntent): string {
  return buildIntentKey(intent.categoryKey, intent.geoKey);
}

/** Mirrors the related-pages query in public-tenant-page.functions.ts. */
const RELATED_PAGES_RENDERED = 8;

/**
 * How many published listings this page would actually render.
 *
 * MUST mirror the listing query in getPublicTenantPage — if the two disagree,
 * the gate is validating a page that does not exist. head:true returns the
 * count without transferring rows.
 */
export async function countListingsForFilter(
  workspaceId: string,
  filter: Record<string, any> | null | undefined,
): Promise<number> {
  const f = filter ?? {};
  let q = sb()
    .from("tenant_listings")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("state_published", true);
  if (f.city) q = q.ilike("city", String(f.city));
  if (f.state) q = q.ilike("state", String(f.state));
  if (f.category) q = q.eq("category", String(f.category));
  const { count, error } = await q;
  if (error) {
    // Fail CLOSED: reporting 0 would block a good page, reporting a fake
    // number would let a thin one through. Neither is acceptable silently, so
    // surface it and let the caller refuse the publish with a real reason.
    throw new Error(`could not count listings for this page: ${error.message}`);
  }
  return count ?? 0;
}

/**
 * Titles/descriptions/H1s already live in this workspace, excluding the page
 * being published (so re-publishing an edited page never collides with itself).
 */
export async function loadSiblingContext(
  workspaceId: string,
  excludePageId?: string,
): Promise<ValidationContext & { publishedCount: number }> {
  let q = sb()
    .from("tenant_pages")
    .select("id, slug, title, meta_description, h1, variables, listing_filter")
    .eq("workspace_id", workspaceId)
    .eq("status", "published");
  if (excludePageId) q = q.neq("id", excludePageId);
  const { data, error } = await q;
  if (error) throw new Error(`could not read existing pages: ${error.message}`);

  const rows = (data ?? []) as Array<{
    slug: string;
    title: string | null;
    meta_description: string | null;
    h1: string | null;
    variables: Record<string, any> | null;
    listing_filter: Record<string, any> | null;
  }>;
  const siblingTitles = new Set<string>();
  const siblingDescriptions = new Set<string>();
  const siblingH1s = new Set<string>();
  const siblingIntents: SiblingIntent[] = [];
  for (const r of rows) {
    const t = normalizeForCompare(r.title);
    if (t) siblingTitles.add(t);
    const d = normalizeForCompare(r.meta_description);
    if (d) siblingDescriptions.add(d);
    const h = normalizeForCompare(r.h1);
    if (h) siblingH1s.add(h);
    const intent = intentForPage(r.title, r.variables, r.listing_filter);
    if (intent) siblingIntents.push({ slug: r.slug, title: r.title ?? r.slug, intent });
  }
  return {
    siblingTitles,
    siblingDescriptions,
    siblingH1s,
    siblingIntents,
    publishedCount: rows.length,
  };
}

export type ContractCheck = {
  ok: boolean;
  violations: Violation[];
  blocking: Violation[];
};

/** Validate one page about to be published. */
export async function checkPageBeforePublish(
  workspaceId: string,
  page: {
    id?: string;
    slug: string;
    title: string | null;
    metaDescription: string | null;
    h1: string | null;
    bodyMarkdown: string | null;
    listingFilter: Record<string, any> | null | undefined;
    variables?: Record<string, any> | null;
  },
  preloaded?: ValidationContext & { publishedCount: number },
): Promise<ContractCheck> {
  const ctx = preloaded ?? (await loadSiblingContext(workspaceId, page.id));
  const listingCount = await countListingsForFilter(workspaceId, page.listingFilter);

  const candidate: PageForValidation = {
    slug: page.slug,
    title: page.title,
    metaDescription: page.metaDescription,
    h1: page.h1,
    bodyMarkdown: page.bodyMarkdown,
    listingCount,
    // The renderer links up to 8 sibling published pages; with none published
    // yet there is genuinely nothing to link to, and the contract treats the
    // first page accordingly rather than blocking it.
    internalLinkCount: Math.min(ctx.publishedCount, RELATED_PAGES_RENDERED),
  };

  const intent = intentForPage(page.title, page.variables, page.listingFilter);
  const { ok, violations } = validatePageContract(candidate, { ...ctx, intent: intent ?? undefined });
  return { ok, violations, blocking: violations.filter((v) => v.severity === "BLOCKING") };
}

/**
 * Validate a batch. One sibling read for the whole batch; listing counts run
 * with bounded concurrency so a 500-page publish does not open 500 sockets.
 *
 * Pages within the batch are also checked against EACH OTHER, not just against
 * what is already live — otherwise a bulk import of 200 identical city pages
 * would pass, since none of them is published yet.
 */
export async function checkBatchBeforePublish(
  workspaceId: string,
  pages: Array<{
    id: string;
    slug: string;
    title: string | null;
    metaDescription: string | null;
    h1: string | null;
    bodyMarkdown: string | null;
    listingFilter: Record<string, any> | null | undefined;
    variables?: Record<string, any> | null;
  }>,
  concurrency = 16,
): Promise<Map<string, ContractCheck>> {
  const base = await loadSiblingContext(workspaceId);
  const results = new Map<string, ContractCheck>();

  // Accumulates as we go, so the second copy of a duplicate inside the batch
  // collides with the first.
  const seenTitles = new Set(base.siblingTitles);
  const seenDescs = new Set(base.siblingDescriptions);
  const seenH1s = new Set(base.siblingH1s);
  // Accumulates so a batch containing two rewordings of one search collides
  // with itself, not merely with what is already live.
  const seenIntents: SiblingIntent[] = [...(base.siblingIntents ?? [])];

  const counts = new Map<string, number>();
  for (let i = 0; i < pages.length; i += concurrency) {
    const slice = pages.slice(i, i + concurrency);
    await Promise.all(
      slice.map(async (p) => {
        try {
          counts.set(p.id, await countListingsForFilter(workspaceId, p.listingFilter));
        } catch {
          // Treat an uncountable page as having no inventory: it will be
          // blocked as thin unless it carries real body copy, which is the
          // safe direction.
          counts.set(p.id, 0);
        }
      }),
    );
  }

  // Sequential so intra-batch duplicate detection is deterministic and
  // order-stable — the FIRST occurrence wins, every later copy is flagged.
  for (const p of pages) {
    const intent = intentForPage(p.title, p.variables, p.listingFilter);
    const ctx: ValidationContext = {
      siblingTitles: seenTitles,
      siblingDescriptions: seenDescs,
      siblingH1s: seenH1s,
      siblingIntents: seenIntents,
      intent: intent ?? undefined,
    };
    const candidate: PageForValidation = {
      slug: p.slug,
      title: p.title,
      metaDescription: p.metaDescription,
      h1: p.h1,
      bodyMarkdown: p.bodyMarkdown,
      listingCount: counts.get(p.id) ?? 0,
      internalLinkCount: Math.min(base.publishedCount + results.size, RELATED_PAGES_RENDERED),
    };
    const { ok, violations } = validatePageContract(candidate, ctx);
    results.set(p.id, { ok, violations, blocking: violations.filter((v) => v.severity === "BLOCKING") });

    if (ok) {
      const t = normalizeForCompare(p.title);
      if (t) seenTitles.add(t);
      const d = normalizeForCompare(p.metaDescription);
      if (d) seenDescs.add(d);
      const h = normalizeForCompare(p.h1);
      if (h) seenH1s.add(h);
      if (intent) seenIntents.push({ slug: p.slug, title: p.title ?? p.slug, intent });
    }
  }

  return results;
}
